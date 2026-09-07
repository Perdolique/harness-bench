import { lstat, readdir } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { scanCredentialBytes } from '@harness-bench/core'

import {
  CompletionRunRecordSchema,
  InitialRunRecordSchema,
  type CompletionRunRecord,
  type InitialRunRecord
} from '@harness-bench/schemas'

import * as v from 'valibot'
import { ResultError } from './errors.ts'
import { assertSourceRelationships, sourceProvenance, type ResolvedEvidenceReference } from './normalize.ts'
import { NormalizedRunRecordV1Schema, type NormalizedRunRecordV1 } from './schemas.ts'
import { hashStableFile, parseManagedRecordPath, readStableFile, readStoredRecord, sha256 } from './storage.ts'

export interface ReadNormalizedRunRecordResult {
  readonly completionRecord: CompletionRunRecord;
  readonly digest: string;
  readonly initialRecord: InitialRunRecord;
  readonly record: NormalizedRunRecordV1;
  readonly recordPath: string;
  readonly runDirectory: string;
  readonly rawManifestPath: string;
  readonly verifierLogPaths: readonly string[];
  readonly resolvedReferences: readonly ResolvedEvidenceReference[];
}

export interface ReadNormalizedRunRecordRuntime {
  readonly beforeFinalSnapshot?: () => Promise<void>;
}

interface VerifiedFileSnapshot {
  readonly localPath: string;
  readonly ino: number;
  readonly ctimeMs: number;
  readonly size: number;
  readonly mode: number;
}

async function captureFileSnapshot(localPath: string): Promise<VerifiedFileSnapshot> {
  const metadata = await lstat(localPath)

  return {
    localPath,
    ino: metadata.ino,
    ctimeMs: metadata.ctimeMs,
    size: metadata.size,
    mode: metadata.mode
  }
}

async function assertFileSnapshotUnchanged(runDirectory: string, snapshot: VerifiedFileSnapshot): Promise<void> {
  const executable = (snapshot.mode & 0o111) !== 0

  await assertFilePath(runDirectory, snapshot.localPath, executable)

  const current = await captureFileSnapshot(snapshot.localPath)

  if (!isDeepStrictEqual(current, snapshot)) {
    throw new ResultError('INTEGRITY_MISMATCH', 'Report evidence changed during inspection')
  }
}

const ManifestSchema = v.array(v.strictObject({
  path: v.pipe(v.string(), v.check((path) => !path.startsWith('/') && !path.includes('\\') && path.split('/').every((part) => !['', '.', '..', 'sha256-manifest.json'].includes(part)))),
  digest: v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/)),
  size: v.pipe(v.number(), v.integer(), v.minValue(0)),
  executable: v.boolean()
}))

async function assertDirectory(path: string, mode: number): Promise<void> {
  const metadata = await lstat(path)

  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== mode) {
    throw new ResultError('INTEGRITY_MISMATCH', 'Report source directory is not sealed')
  }
}

async function assertFilePath(root: string, path: string, executable = false): Promise<void> {
  const local = relative(root, path)

  if (local === '' || local.startsWith('../') || local.startsWith('/')) {
    throw new ResultError('INTEGRITY_MISMATCH', 'Report evidence escapes the run directory')
  }

  let parent = dirname(path)

  while (parent !== root) {
    await assertDirectory(parent, 0o500)

    parent = dirname(parent)
  }

  const metadata = await lstat(path)
  const mode = executable ? 0o500 : 0o400

  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== mode) {
    throw new ResultError('INTEGRITY_MISMATCH', 'Report evidence is not a sealed regular file')
  }
}

async function assertReadableState(runsRoot: string, runId: string): Promise<void> {
  const lockPath = resolve(runsRoot, '.results/.locks', `${runId}.lock`)

  try {
    await lstat(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }

    const restrictions = resolve(runsRoot, '.results', runId, 'restrictions')

    try {
      await assertDirectory(restrictions, 0o700)

      const entries = await readdir(restrictions)

      if (entries.length > 0) {
        throw new ResultError('EXPORT_BLOCKED', 'Run is restricted; report access is blocked')
      }
    } catch (restrictionError) {
      if ((restrictionError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw restrictionError
      }
    }

    return
  }

  throw new ResultError('RECORD_CONFLICT', 'Another result operation is active for this run')
}

async function readVerifiedMetadata(runDirectory: string, name: string, digest: string): Promise<Buffer> {
  const sourcePath = resolve(runDirectory, name)

  await assertFilePath(runDirectory, sourcePath)

  const source = await readStableFile(sourcePath)
  const actualDigest = sha256(source)

  if (actualDigest !== digest) {
    throw new ResultError('INTEGRITY_MISMATCH', 'Run metadata differs from the normalized source')
  }

  return source
}

async function readReportSource(path: string, runtime: ReadNormalizedRunRecordRuntime): Promise<ReadNormalizedRunRecordResult> {
  const location = parseManagedRecordPath(path, 'normalized')

  await assertDirectory(location.runsRoot, 0o700)
  await assertReadableState(location.runsRoot, location.runId)

  const stored = await readStoredRecord(path, 'normalized', NormalizedRunRecordV1Schema)
  const record = stored.record

  if (record.identities.run.run_id !== location.runId) {
    throw new ResultError('INTEGRITY_MISMATCH', 'Normalized identity does not match the managed path')
  }

  const storedSource = await readStableFile(stored.recordPath)
  const sourceDigest = sha256(storedSource)

  if (sourceDigest !== stored.digest) {
    throw new ResultError('INTEGRITY_MISMATCH', 'Report source changed during inspection')
  }

  const serialized = JSON.stringify(record)
  const decodedSource = Buffer.from(serialized)
  const findings = scanCredentialBytes(storedSource, { path: 'normalized/record.json' })
  const decodedFindings = scanCredentialBytes(decodedSource, { path: 'normalized/record.json' })

  if (findings.length > 0 || decodedFindings.length > 0) {
    throw new ResultError('EXPORT_BLOCKED', 'Credential pattern detected; report access is blocked')
  }

  const runDirectory = resolve(location.runsRoot, location.runId)

  await assertDirectory(runDirectory, 0o500)

  const rawManifestPath = resolve(runDirectory, 'raw-manifest.json')

  const metadataFiles = [
    ['initial.json', record.source_digests.initial_record],
    ['completion.json', record.source_digests.completion_record],
    ['raw-manifest.json', record.source_digests.raw_manifest]
  ] as const

  const initialSource = await readVerifiedMetadata(runDirectory, 'initial.json', record.source_digests.initial_record)
  const completionSource = await readVerifiedMetadata(runDirectory, 'completion.json', record.source_digests.completion_record)
  const manifestSource = await readVerifiedMetadata(runDirectory, 'raw-manifest.json', record.source_digests.raw_manifest)
  const initialJson = initialSource.toString('utf8')
  const completionJson = completionSource.toString('utf8')
  const initialCandidate: unknown = JSON.parse(initialJson)
  const completionCandidate: unknown = JSON.parse(completionJson)
  const initial = v.parse(InitialRunRecordSchema, initialCandidate)
  const completion = v.parse(CompletionRunRecordSchema, completionCandidate)

  assertSourceRelationships(initial, completion, record.source_digests.initial_record, record.source_digests.raw_manifest)

  const provenance = sourceProvenance({
    initial,
    initialDigest: record.source_digests.initial_record,
    completionDigest: record.source_digests.completion_record,
    manifestDigest: record.source_digests.raw_manifest
  })

  const outcome = {
    classification: completion.classification,
    termination: completion.termination,
    valid_grade: completion.valid_grade
  }

  const identitiesMatch = isDeepStrictEqual(record.identities, provenance.identities)
  const revisionsMatch = isDeepStrictEqual(record.revisions, provenance.revisions)
  const outcomeMatches = isDeepStrictEqual(record.outcome, outcome)
  const retentionMatches = isDeepStrictEqual(record.retention, initial.retention)

  if (
    !identitiesMatch || !revisionsMatch || !outcomeMatches || !retentionMatches ||
    initial.runner.name !== record.revisions.runner_name ||
    initial.runner.version !== record.revisions.runner_version ||
    completion.raw_artifact_path !== 'raw' ||
    record.timings.total_seconds !== completion.timings.total_seconds
  ) {
    throw new ResultError('INTEGRITY_MISMATCH', 'Normalized record does not match its authoritative run metadata')
  }

  const manifestJson = manifestSource.toString('utf8')
  const manifestCandidate: unknown = JSON.parse(manifestJson)
  const manifest = v.parse(ManifestSchema, manifestCandidate)

  if (new Set(manifest.map((entry) => entry.path)).size !== manifest.length) {
    throw new ResultError('INTEGRITY_MISMATCH', 'Raw manifest contains duplicate paths')
  }

  const resolvedReferences: ResolvedEvidenceReference[] = []
  const verifiedFiles: VerifiedFileSnapshot[] = []

  for (const reference of record.references) {
    const localPath = resolve(runDirectory, reference.path)
    const rawRelativePath = reference.path.startsWith('raw/') ? reference.path.slice(4) : undefined
    const entries = manifest.filter((entry) => entry.path === rawRelativePath)
    const entry = entries[0]

    if (entries.length !== 1 || entry === undefined || entry.digest !== reference.digest || entry.size !== reference.size || entry.executable !== reference.executable) {
      throw new ResultError('INTEGRITY_MISMATCH', 'Report evidence does not match the raw manifest')
    }

    await assertFilePath(runDirectory, localPath, reference.executable)

    const snapshot = await captureFileSnapshot(localPath)
    const hashed = await hashStableFile(localPath)

    if (hashed.digest !== reference.digest || hashed.size !== reference.size) {
      throw new ResultError('INTEGRITY_MISMATCH', 'Report evidence bytes differ from the retained record')
    }

    resolvedReferences.push({
      localPath,
      relativePath: reference.path,
      role: reference.role
    })

    verifiedFiles.push(snapshot)
  }

  const verifierLogPaths: string[] = []

  for (const entry of manifest) {
    if (!/^harbor\/job\/[^/]+\/verifier\/(?:[^/]+\/)*[^/]+\.(?:log|txt)$/.test(entry.path)) continue

    const localPath = resolve(runDirectory, 'raw', entry.path)

    await assertFilePath(runDirectory, localPath, entry.executable)

    const snapshot = await captureFileSnapshot(localPath)
    const hashed = await hashStableFile(localPath)

    if (hashed.digest !== entry.digest || hashed.size !== entry.size) {
      throw new ResultError('INTEGRITY_MISMATCH', 'Verifier log differs from the raw manifest')
    }

    verifierLogPaths.push(localPath)
    verifiedFiles.push(snapshot)
  }

  verifierLogPaths.sort()

  // Recheck the captured evidence and metadata after the complete inspection.
  await runtime.beforeFinalSnapshot?.()

  for (const [name, digest] of metadataFiles) {
    const sourcePath = resolve(runDirectory, name)

    await assertFilePath(runDirectory, sourcePath)

    const hashed = await hashStableFile(sourcePath)

    if (hashed.digest !== digest) {
      throw new ResultError('INTEGRITY_MISMATCH', 'Run metadata changed during inspection')
    }
  }

  for (const snapshot of verifiedFiles) {
    await assertFileSnapshotUnchanged(runDirectory, snapshot)
  }

  await assertReadableState(location.runsRoot, location.runId)
  await assertDirectory(runDirectory, 0o500)

  const finalStored = await readStoredRecord(path, 'normalized', NormalizedRunRecordV1Schema)

  if (finalStored.digest !== stored.digest) {
    throw new ResultError('INTEGRITY_MISMATCH', 'Report source changed during inspection')
  }

  return {
    completionRecord: completion,
    digest: stored.digest,
    initialRecord: initial,
    record,
    recordPath: stored.recordPath,
    runDirectory,
    rawManifestPath,
    verifierLogPaths,
    resolvedReferences
  }
}

// Reads retained evidence for local inspection without creating derived records or locks.
export async function readNormalizedRunRecord(path: string, runtime: ReadNormalizedRunRecordRuntime = {}): Promise<ReadNormalizedRunRecordResult> {
  try {
    return await readReportSource(path, runtime)
  } catch (error) {
    if (error instanceof ResultError) {
      throw error
    }

    throw new ResultError('INVALID_INPUT', 'Report source is unavailable or invalid', { cause: error })
  }
}
