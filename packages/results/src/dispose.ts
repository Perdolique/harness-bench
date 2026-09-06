import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import * as v from 'valibot'
import { ResultError } from './errors.ts'
import { normalizeRunWithRuntime, type NormalizeRunResult } from './normalize.ts'
import { ResultTimestampSchema, RunTombstoneV1Schema, type RunTombstoneV1 } from './schemas.ts'
import { serializeRecord, sha256, writeContentAddressedRecord } from './storage.ts'

export type DisposeReason =
  | 'credential-detected'
  | 'owner-request'
  | 'retention-expired'
export type DisposeDisposition = 'delete' | 'incident-retain'
export type CredentialAction = 'revoked' | 'rotated'

export interface DisposeRunOptions {
  readonly confirmRunId: string;
  readonly credentialAction?: CredentialAction;
  readonly disposition: DisposeDisposition;
  readonly incidentExpiresAt?: string;
  readonly now?: Date;
  readonly reason: DisposeReason;
  readonly runsDirectory?: string;
}

export interface DisposeRunResult {
  readonly digest: string;
  readonly record: RunTombstoneV1;
  readonly recordPath: string;
}

export interface DisposeRuntime {
  readonly afterStage?: () => Promise<void>;
  readonly beforeTombstoneInstall?: () => Promise<void>;
}

function clock(options: DisposeRunOptions): Date {
  const now = options.now ?? new Date()

  if (Number.isNaN(now.getTime())) {
    throw new ResultError('INVALID_INPUT', 'Disposition clock is invalid', {
      stage: 'disposition'
    })
  }

  return now
}

function validateDisposition(
  normalized: NormalizeRunResult,
  options: DisposeRunOptions,
  now: Date
): void {
  const runId = normalized.record.record_type === 'normalized'
    ? normalized.record.identities.run.run_id
    : normalized.record.identity.run_id

  if (options.confirmRunId !== runId) {
    throw new ResultError(
      'LIFECYCLE_REJECTED',
      'Run ID confirmation does not match the selected run',
      { stage: 'disposition' }
    )
  }

  if (
    normalized.kind === 'restricted' &&
    options.reason !== 'credential-detected'
  ) {
    throw new ResultError(
      'LIFECYCLE_REJECTED',
      'Restricted evidence requires the credential-detected owner-response flow',
      { stage: 'disposition' }
    )
  }

  if (options.reason !== 'credential-detected') {
    if (
      normalized.kind !== 'normalized' ||
      normalized.record.retention.classification !== 'private'
    ) {
      throw new ResultError(
        'LIFECYCLE_REJECTED',
        'Public run records cannot be deleted by the private retention workflow',
        { stage: 'disposition' }
      )
    }

    if (
      options.reason === 'retention-expired' &&
      Date.parse(normalized.record.retention.expires_at) > now.getTime()
    ) {
      throw new ResultError(
        'LIFECYCLE_REJECTED',
        'Private retention has not expired',
        { stage: 'disposition' }
      )
    }
  }

  if (options.reason === 'credential-detected') {
    if (
      normalized.kind !== 'restricted' ||
      !['credential_detected', 'raw_quarantined'].includes(
        normalized.record.restriction.category
      )
    ) {
      throw new ResultError(
        'LIFECYCLE_REJECTED',
        'Credential disposition requires an existing restriction record',
        { stage: 'disposition' }
      )
    }

    if (!['rotated', 'revoked'].includes(options.credentialAction ?? '')) {
      throw new ResultError(
        'LIFECYCLE_REJECTED',
        'Credential disposition requires owner rotation or revocation attestation',
        { stage: 'disposition' }
      )
    }
  } else if (options.credentialAction !== undefined) {
    throw new ResultError(
      'LIFECYCLE_REJECTED',
      'Credential action is only valid for credential-detected disposition',
      { stage: 'disposition' }
    )
  }

  if (options.disposition === 'incident-retain') {
    if (options.reason !== 'credential-detected' || normalized.kind !== 'restricted') {
      throw new ResultError(
        'LIFECYCLE_REJECTED',
        'Incident retention is only valid for restricted credential evidence',
        { stage: 'disposition' }
      )
    }

    const expiresAt = options.incidentExpiresAt

    if (
      expiresAt === undefined ||
      !v.safeParse(ResultTimestampSchema, expiresAt).success ||
      Date.parse(expiresAt) <= now.getTime()
    ) {
      throw new ResultError(
        'LIFECYCLE_REJECTED',
        'Incident retention requires a future ISO timestamp',
        { stage: 'disposition' }
      )
    }
  } else if (options.incidentExpiresAt !== undefined) {
    throw new ResultError(
      'LIFECYCLE_REJECTED',
      'Incident expiry is only valid for incident retention',
      { stage: 'disposition' }
    )
  }
}

async function derivedRecordDigests(
  runsRoot: string,
  runId: string
): Promise<readonly string[]> {
  const runResults = resolve(runsRoot, '.results', runId)
  const digests = new Set<string>()

  try {
    for (const category of ['exports', 'normalized', 'restrictions']) {
      const categoryRoot = resolve(runResults, category)

      try {
        for (const entry of await readdir(categoryRoot)) {
          if (/^[a-f0-9]{64}$/.test(entry)) {
            digests.add(`sha256:${entry}`)
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }
  } catch (error) {
    throw new ResultError(
      'DISPOSITION_FAILED',
      'Could not inspect managed derived records',
      {
        cause: error,
        stage: 'disposition'
      }
    )
  }

  return [...digests].sort()
}

function tombstoneRecord(
  normalized: NormalizeRunResult,
  options: DisposeRunOptions,
  now: Date,
  digests: readonly string[]
): RunTombstoneV1 {
  const identity = normalized.kind === 'normalized'
    ? normalized.record.identities.run
    : normalized.record.identity

  return v.parse(RunTombstoneV1Schema, {
    document_type: 'run_tombstone',
    schema_version: 1,
    normalization_revision: '1',
    record_type: 'tombstone',
    created_at: now.toISOString(),
    identity,
    reason: options.reason,
    disposition: options.disposition,

    owner_attestation: {
      confirmed_run_id: options.confirmRunId,
      credential_action: options.credentialAction ?? 'not_applicable'
    },

    incident_expires_at: options.disposition === 'incident-retain'
      ? {
      status: 'known',
      value: options.incidentExpiresAt
    }
      : { status: 'not_applicable' },

    source_digests: normalized.record.source_digests,
    derived_record_digests: digests,
    retention_classification: 'private',
    deleted_from_managed_storage: options.disposition === 'delete',
    external_copies_status: 'not_managed'
  })
}

async function sealTombstoneStaging(
  staging: string,
  record: RunTombstoneV1
): Promise<{ readonly digest: string; readonly leafPath: string }> {
  const source = serializeRecord(record)
  const digest = sha256(source)
  const address = digest.slice('sha256:'.length)
  const leaf = resolve(staging, address)
  const recordPath = resolve(leaf, 'record.json')

  await mkdir(leaf, {
    recursive: true,
    mode: 0o700
  })

  await writeFile(recordPath, source, {
    flag: 'wx',
    mode: 0o600
  })

  await chmod(recordPath, 0o400)
  await chmod(leaf, 0o500)

  return {
    digest,
    leafPath: leaf
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)

    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }

    throw error
  }
}

async function makeWritable(path: string): Promise<void> {
  const metadata = await lstat(path)

  if (metadata.isSymbolicLink()) {
    await chmod(dirname(path), 0o700)

    return
  }

  if (metadata.isDirectory()) {
    await chmod(path, 0o700)

    for (const entry of await readdir(path)) {
      await makeWritable(resolve(path, entry))
    }

    return
  }

  await chmod(path, 0o600)
}

async function restrictRemaining(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    return
  }

  const metadata = await lstat(path)

  if (metadata.isSymbolicLink()) {
    return
  }

  if (metadata.isDirectory()) {
    for (const entry of await readdir(path)) {
      await restrictRemaining(resolve(path, entry))
    }

    await chmod(path, 0o500)

    return
  }

  await chmod(path, (metadata.mode & 0o111) === 0 ? 0o400 : 0o500)
}

async function deleteStaged(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    return
  }

  await makeWritable(path)
  await rm(path, { recursive: true })
}

async function restoreDerivedModes(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    return
  }

  await chmod(path, 0o700)

  for (const category of await readdir(path)) {
    const categoryPath = resolve(path, category)
    const categoryMetadata = await lstat(categoryPath)

    if (categoryMetadata.isSymbolicLink() || !categoryMetadata.isDirectory()) {
      continue
    }

    await chmod(categoryPath, 0o700)

    for (const address of await readdir(categoryPath)) {
      const leaf = resolve(categoryPath, address)

      await restrictRemaining(leaf)
    }
  }
}

async function deleteWithTombstone(
  runDirectory: string,
  runsRoot: string,
  runId: string,
  record: RunTombstoneV1,
  runtime: DisposeRuntime
): Promise<DisposeRunResult> {
  const nonce = randomUUID()
  const tombstoneStaging = resolve(runsRoot, `.tombstone-${runId}-${nonce}`)
  const sourceStaging = resolve(runsRoot, `.dispose-${runId}-${nonce}`)
  const resultsRoot = resolve(runsRoot, '.results')
  const resultsSource = resolve(resultsRoot, runId)
  const resultsStaging = resolve(resultsRoot, `.dispose-${runId}-${nonce}`)
  let sourceMoved = false
  let resultsMoved = false
  let privateDeletionCompleted = false
  let tombstoneInstalled = false
  let sealed: Awaited<ReturnType<typeof sealTombstoneStaging>> | undefined

  try {
    await mkdir(tombstoneStaging, { mode: 0o700 })

    sealed = await sealTombstoneStaging(tombstoneStaging, record)

    await rename(runDirectory, sourceStaging)

    sourceMoved = true

    await mkdir(runDirectory, { mode: 0o700 })

    if (await pathExists(resultsSource)) {
      await rename(resultsSource, resultsStaging)

      resultsMoved = true
    }

    await runtime.afterStage?.()
    await deleteStaged(sourceStaging)

    sourceMoved = false

    await deleteStaged(resultsStaging)

    resultsMoved = false
    privateDeletionCompleted = true

    await runtime.beforeTombstoneInstall?.()

    const finalLeaf = resolve(runDirectory, basename(sealed.leafPath))

    await chmod(sealed.leafPath, 0o700)
    await rename(sealed.leafPath, finalLeaf)

    tombstoneInstalled = true

    await chmod(finalLeaf, 0o500)
    await chmod(runDirectory, 0o500)

    return {
      digest: sealed.digest,
      record,

      recordPath: resolve(
        runDirectory,
        sealed.digest.slice('sha256:'.length),
        'record.json'
      )
    }
  } catch (error) {
    try {
      if (sourceMoved) {
        if (await pathExists(runDirectory)) {
          await makeWritable(runDirectory)
          await rm(runDirectory, { recursive: true })
        }

        await restrictRemaining(sourceStaging)
        await rename(sourceStaging, runDirectory)

        sourceMoved = false
      }

      if (resultsMoved && !(await pathExists(resultsSource))) {
        await restoreDerivedModes(resultsStaging)
        await rename(resultsStaging, resultsSource)

        resultsMoved = false
      }

      if (privateDeletionCompleted && await pathExists(runDirectory)) {
        await restrictRemaining(runDirectory)
      }

      if (privateDeletionCompleted) {
        await restrictRemaining(tombstoneStaging)
      }

      if (!sourceMoved && await pathExists(runDirectory)) {
        await restrictRemaining(runDirectory)
      }
    } catch {
      await restrictRemaining(runDirectory).catch(() => undefined)
      await restrictRemaining(sourceStaging).catch(() => undefined)
      await restrictRemaining(resultsStaging).catch(() => undefined)
      await restrictRemaining(tombstoneStaging).catch(() => undefined)
    }

    throw new ResultError(
      'DISPOSITION_FAILED',
      'Run disposition did not complete safely; inspect restricted recovery state',
      {
        cause: error,
        stage: 'disposition'
      }
    )
  } finally {
    if (
      (!privateDeletionCompleted || tombstoneInstalled) &&
      await pathExists(tombstoneStaging).catch(() => false)
    ) {
      await makeWritable(tombstoneStaging).catch(() => undefined)

      await rm(tombstoneStaging, {
        force: true,
        recursive: true
      }).catch(
        () => undefined
      )
    }
  }
}

export async function disposeRunWithRuntime(
  runDirectory: string,
  options: DisposeRunOptions,
  runtime: DisposeRuntime
): Promise<DisposeRunResult> {
  const now = clock(options)
  const resolvedRunDirectory = resolve(runDirectory)

  if (basename(resolvedRunDirectory) !== options.confirmRunId) {
    throw new ResultError(
      'LIFECYCLE_REJECTED',
      'Selected run path does not match the confirmed run ID',
      { stage: 'disposition' }
    )
  }

  const runsRoot = resolve(options.runsDirectory ?? dirname(resolvedRunDirectory))

  const normalized = await normalizeRunWithRuntime(
    resolvedRunDirectory,
    { runsDirectory: runsRoot },
    { now: () => now }
  )

  validateDisposition(normalized, options, now)

  const runId = normalized.kind === 'normalized'
    ? normalized.record.identities.run.run_id
    : normalized.record.identity.run_id

  const digests = await derivedRecordDigests(runsRoot, runId)
  const record = tombstoneRecord(normalized, options, now, digests)

  if (options.disposition === 'incident-retain') {
    return writeContentAddressedRecord(
      runsRoot,
      runId,
      'restrictions',
      record
    )
  }

  return deleteWithTombstone(
    resolvedRunDirectory,
    runsRoot,
    runId,
    record,
    runtime
  )
}

export async function disposeRun(
  runDirectory: string,
  options: DisposeRunOptions
): Promise<DisposeRunResult> {
  return disposeRunWithRuntime(runDirectory, options, {})
}
