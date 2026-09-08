import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import * as v from 'valibot'

import {
  ensureExperimentDirectory,
  experimentHash,
  inspectRunTree,
  readExperimentRecord,
  scanCredentialTree,
  writeExperimentRecord,
  type ExperimentPlan
} from '@harness-bench/core'

import { ResultError } from './errors.ts'

import {
  RegradedRunRecordV1Schema,
  ScoringMigrationRecordV1Schema,
  type RegradedRunRecordV1,
  type ScoringMigrationRecordV1
} from './regrade-schemas.ts'

import {
  ensureManagedDirectory,
  parseManagedRecordPath,
  readStableFile,
  serializeRecord,
  sha256,
  type StoredResultRecord
} from './storage.ts'

interface TreeEntry {
  readonly digest: string;
  readonly executable: boolean;
  readonly path: string;
  readonly size: number;
}

export interface ReadRegradedRunRecordResult
  extends StoredResultRecord<RegradedRunRecordV1> {
  readonly leaf: string;
  readonly runsRoot: string;
}

export interface StoredScoringMigrationRecord
  extends StoredResultRecord<ScoringMigrationRecordV1> {}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function treeEntries(root: string): Promise<readonly TreeEntry[]> {
  const entries: TreeEntry[] = []

  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true })

    children.sort((left, right) => compareText(left.name, right.name))

    for (const child of children) {
      const path = resolve(directory, child.name)
      const metadata = await lstat(path)

      if (metadata.isSymbolicLink()) {
        throw new ResultError(
          'INTEGRITY_MISMATCH',
          'Regrade evidence contains a symbolic link',
          { stage: 'input' }
        )
      }

      if (metadata.isDirectory()) {
        await visit(path)

        continue
      }

      if (!metadata.isFile()) {
        throw new ResultError(
          'INTEGRITY_MISMATCH',
          'Regrade evidence contains a special entry',
          { stage: 'input' }
        )
      }

      const contents = await readStableFile(path)
      const entryPath = relative(root, path).split('\\').join('/')

      entries.push({
        digest: sha256(contents),
        executable: (metadata.mode & 0o111) !== 0,
        path: entryPath,
        size: contents.byteLength
      })
    }
  }

  await visit(root)

  return entries
}

async function sealTree(path: string): Promise<void> {
  const metadata = await lstat(path)

  if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Cannot seal a regrade symlink or special entry',
      { stage: 'normalization' }
    )
  }

  if (metadata.isDirectory()) {
    for (const child of await readdir(path)) {
      await sealTree(resolve(path, child))
    }

    await chmod(path, 0o500)

    return
  }

  const mode = (metadata.mode & 0o111) !== 0 ? 0o500 : 0o400

  await chmod(path, mode)
}

async function assertSealedTree(path: string): Promise<void> {
  const metadata = await lstat(path)

  if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Regrade evidence contains an unsafe entry',
      { stage: 'input' }
    )
  }

  if (metadata.isDirectory()) {
    if ((metadata.mode & 0o777) !== 0o500) {
      throw new ResultError(
        'INTEGRITY_MISMATCH',
        'Regrade evidence directory is not sealed',
        { stage: 'input' }
      )
    }

    for (const child of await readdir(path)) {
      await assertSealedTree(resolve(path, child))
    }

    return
  }

  const expectedMode = (metadata.mode & 0o111) !== 0 ? 0o500 : 0o400

  if ((metadata.mode & 0o777) !== expectedMode) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Regrade evidence file is not sealed',
      { stage: 'input' }
    )
  }
}

async function makeTreeWritable(path: string): Promise<void> {
  const metadata = await lstat(path)

  if (metadata.isSymbolicLink()) return

  if (metadata.isDirectory()) {
    await chmod(path, 0o700)

    for (const child of await readdir(path)) {
      await makeTreeWritable(resolve(path, child))
    }

    return
  }

  await chmod(path, 0o600)
}

function parseRawManifest(candidate: unknown): readonly TreeEntry[] {
  const schema = v.array(v.strictObject({
    digest: v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/)),
    executable: v.boolean(),
    path: v.pipe(v.string(), v.nonEmpty()),
    size: v.pipe(v.number(), v.integer(), v.minValue(0))
  }))

  const parsed = v.safeParse(schema, candidate)

  if (!parsed.success) {
    throw new ResultError('INVALID_INPUT', 'Regrade raw manifest is invalid', {
      stage: 'input'
    })
  }

  return parsed.output
}

async function validateRegradeLeaf(
  recordPath: string
): Promise<ReadRegradedRunRecordResult> {
  const location = parseManagedRecordPath(recordPath, 'regrades')

  for (const parent of [location.resultsRoot, location.runRoot, location.categoryRoot]) {
    const metadata = await lstat(parent)

    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (metadata.mode & 0o777) !== 0o700
    ) {
      throw new ResultError(
        'INTEGRITY_MISMATCH',
        'Managed regrade parent directory is unsafe',
        { stage: 'input' }
      )
    }
  }

  await assertSealedTree(location.leaf)

  const entries = (await readdir(location.leaf)).sort(compareText)
  const expectedEntries = ['inputs', 'raw', 'raw-manifest.json', 'record.json']

  if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Regrade result inventory is not exact',
      { stage: 'input' }
    )
  }

  const source = await readStableFile(location.absolutePath)
  const digest = sha256(source)

  if (digest.slice(7) !== location.address) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Regrade record does not match its content address',
      { stage: 'input' }
    )
  }

  let candidate: unknown

  try {
    candidate = JSON.parse(source.toString('utf8'))
  } catch (error) {
    throw new ResultError('INVALID_INPUT', 'Regrade record is not valid JSON', {
      cause: error,
      stage: 'input'
    })
  }

  const parsed = v.safeParse(RegradedRunRecordV1Schema, candidate)

  if (!parsed.success) {
    throw new ResultError('INVALID_INPUT', 'Regrade record is invalid', {
      stage: 'input'
    })
  }

  const record = parsed.output
  const rawManifestPath = resolve(location.leaf, record.evidence.raw_manifest_path)
  const manifestSource = await readStableFile(rawManifestPath)

  if (sha256(manifestSource) !== record.evidence.raw_manifest_digest) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Regrade raw manifest digest differs',
      { stage: 'input' }
    )
  }

  let rawManifestCandidate: unknown

  try {
    rawManifestCandidate = JSON.parse(manifestSource.toString('utf8'))
  } catch (error) {
    throw new ResultError('INVALID_INPUT', 'Regrade raw manifest is not JSON', {
      cause: error,
      stage: 'input'
    })
  }

  const expectedRaw = parseRawManifest(rawManifestCandidate)
  const actualRaw = await treeEntries(resolve(location.leaf, 'raw'))

  if (JSON.stringify(actualRaw) !== JSON.stringify(expectedRaw)) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Regrade raw evidence differs from its manifest',
      { stage: 'input' }
    )
  }

  const evidenceDigests = [
    [record.evidence.config_path, record.evidence.config_digest],
    [record.evidence.lock_path, record.evidence.lock_digest],
    [record.evidence.result_path, record.evidence.result_digest],
    [record.evidence.verifier_result_path, record.evidence.verifier_result_digest],
    [record.evidence.target_document_path, record.target.task_document_digest]
  ] as const

  for (const [path, expectedDigest] of evidenceDigests) {
    const contents = await readStableFile(resolve(location.leaf, path))

    if (sha256(contents) !== expectedDigest) {
      throw new ResultError(
        'INTEGRITY_MISMATCH',
        'Regrade evidence digest differs',
        { stage: 'input' }
      )
    }
  }

  const targetPackage = await inspectRunTree(
    resolve(location.leaf, record.evidence.target_package_path)
  )

  const materializedTargetPackage = await inspectRunTree(
    resolve(location.leaf, record.evidence.materialized_target_package_path)
  )

  if (
    targetPackage.digest !== record.target.task_package_digest ||
    materializedTargetPackage.digest !==
      record.target.materialized_task_package_digest
  ) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Regrade target package digest differs',
      { stage: 'input' }
    )
  }

  return {
    digest,
    leaf: location.leaf,
    record,
    recordPath: location.absolutePath,
    runsRoot: location.runsRoot
  }
}

export async function prepareRegradeStaging(
  runsRoot: string,
  runId: string
): Promise<string> {
  const resultsRoot = resolve(runsRoot, '.results')
  const runRoot = resolve(resultsRoot, runId)
  const categoryRoot = resolve(runRoot, 'regrades')

  for (const path of [resultsRoot, runRoot, categoryRoot]) {
    await ensureManagedDirectory(path)
  }

  for (const name of await readdir(categoryRoot)) {
    if (!name.startsWith('.staging-')) continue

    const abandoned = resolve(categoryRoot, name)

    await sealTree(abandoned)
    await rename(abandoned, resolve(categoryRoot, `.failed-${randomUUID()}`))
  }

  const staging = resolve(categoryRoot, `.staging-${randomUUID()}`)

  await mkdir(staging, { mode: 0o700 })

  return staging
}

export async function quarantineRegradeStaging(staging: string): Promise<string> {
  const categoryRoot = dirname(staging)
  const destination = resolve(categoryRoot, `.failed-${randomUUID()}`)

  await sealTree(staging)
  await rename(staging, destination)

  return destination
}

export async function findRegradedRunRecord(
  runsRoot: string,
  runId: string,
  migrationDefinitionDigest: string
): Promise<ReadRegradedRunRecordResult | null> {
  const categoryRoot = resolve(runsRoot, '.results', runId, 'regrades')
  let names: string[]

  try {
    names = await readdir(categoryRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null

    throw error
  }

  const matches: ReadRegradedRunRecordResult[] = []

  for (const name of names.sort(compareText)) {
    if (name.startsWith('.failed-')) continue

    if (!/^[a-f0-9]{64}$/.test(name)) {
      throw new ResultError(
        'RECORD_CONFLICT',
        'Regrade storage contains an incomplete or invalid entry',
        { stage: 'input' }
      )
    }

    const recordPath = resolve(categoryRoot, name, 'record.json')
    const record = await readRegradedRunRecord(recordPath)

    if (
      record.record.migration_definition_digest === migrationDefinitionDigest
    ) {
      matches.push(record)
    }
  }

  if (matches.length > 1) {
    throw new ResultError(
      'RECORD_CONFLICT',
      'Scoring migration has multiple regrades for one run',
      { stage: 'input' }
    )
  }

  return matches[0] ?? null
}

export async function sealRegradedRunRecord(
  staging: string,
  record: RegradedRunRecordV1
): Promise<ReadRegradedRunRecordResult> {
  const parsed = v.parse(RegradedRunRecordV1Schema, record)
  const source = serializeRecord(parsed)
  const digest = sha256(source)
  const categoryRoot = dirname(staging)
  const leaf = resolve(categoryRoot, digest.slice(7))
  const recordPath = resolve(leaf, 'record.json')

  await writeFile(resolve(staging, 'record.json'), source, {
    flag: 'wx',
    mode: 0o600
  })

  const findings = await scanCredentialTree({ root: staging })

  if (findings.findings.length > 0) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Regrade evidence contains a credential pattern',
      { stage: 'normalization' }
    )
  }

  await sealTree(staging)

  try {
    await rename(staging, leaf)
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(
      (error as NodeJS.ErrnoException).code ?? ''
    )) {
      throw error
    }

    await makeTreeWritable(staging)

    await rm(staging, {
      force: true,
      recursive: true
    })
  }

  return validateRegradeLeaf(recordPath)
}

export async function readRegradedRunRecord(
  recordPath: string
): Promise<ReadRegradedRunRecordResult> {
  return validateRegradeLeaf(recordPath)
}

function migrationRecordPath(plan: ExperimentPlan, digest: string): string {
  return resolve(
    plan.runs_directory,
    '.experiments',
    'migrations',
    digest.slice(7),
    'record.json'
  )
}

export async function writeScoringMigrationRecord(
  plan: ExperimentPlan,
  record: ScoringMigrationRecordV1
): Promise<StoredScoringMigrationRecord> {
  const parsed = v.parse(ScoringMigrationRecordV1Schema, record)
  const root = resolve(plan.runs_directory, '.experiments', 'migrations')

  await ensureExperimentDirectory(root)

  for (const name of await readdir(root)) {
    if (!/^[a-f0-9]{64}$/.test(name)) {
      throw new ResultError(
        'INTEGRITY_MISMATCH',
        'Migration storage contains an invalid entry',
        { stage: 'normalization' }
      )
    }

    const existingPath = resolve(root, name, 'record.json')
    const existing = await readScoringMigrationRecord(existingPath, plan)

    const sameIdentity =
      existing.record.identity.migration_id === parsed.identity.migration_id &&
      existing.record.identity.revision === parsed.identity.revision

    if (sameIdentity) {
      if (existing.record.identity.definition_digest !== parsed.identity.definition_digest) {
        throw new ResultError(
          'RECORD_CONFLICT',
          'Migration identity already exists with different content',
          { stage: 'normalization' }
        )
      }

      const existingComparable = {
        ...existing.record,
        created_at: parsed.created_at
      }

      if (!isDeepStrictEqual(existingComparable, parsed)) {
        throw new ResultError(
          'RECORD_CONFLICT',
          'Existing migration identity has different entries',
          { stage: 'normalization' }
        )
      }

      return existing
    }
  }

  const digest = experimentHash(parsed)
  const path = migrationRecordPath(plan, digest)

  await ensureExperimentDirectory(dirname(path))
  await writeExperimentRecord(path, parsed)

  return {
    digest,
    record: parsed,
    recordPath: path
  }
}

export async function readScoringMigrationRecord(
  path: string,
  plan: ExperimentPlan
): Promise<StoredScoringMigrationRecord> {
  const candidate = await readExperimentRecord(path)
  const parsed = v.safeParse(ScoringMigrationRecordV1Schema, candidate)

  if (!parsed.success) {
    throw new ResultError('INVALID_INPUT', 'Scoring migration record is invalid', {
      stage: 'input'
    })
  }

  const record = parsed.output
  const digest = experimentHash(record)
  const expectedPath = migrationRecordPath(plan, digest)

  if (
    resolve(path) !== expectedPath ||
    record.experiment.experiment_id !== plan.experiment.experiment_id ||
    record.experiment.experiment_revision !== plan.experiment.revision ||
    record.experiment.plan_digest !== plan.experiment.plan_digest
  ) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Scoring migration record does not match its experiment or content address',
      { stage: 'input' }
    )
  }

  return {
    digest,
    record,
    recordPath: resolve(path)
  }
}
