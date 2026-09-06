import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { runDispositionReservationPath } from '@harness-bench/core'
import * as v from 'valibot'
import { ResultError } from './errors.ts'
import { normalizeRunWithRuntime, type NormalizeRunResult } from './normalize.ts'

import {
  NormalizedRunRecordV1Schema,
  RestrictedRunRecordV1Schema,
  ResultTimestampSchema,
  RunTombstoneV1Schema,
  SanitizedRunExportV1Schema,
  type RunTombstoneV1
} from './schemas.ts'

import {
  readStoredRecord,
  serializeRecord,
  sha256,
  withRunResultLock,
  writeContentAddressedRecord,
  type ResultRecordCategory
} from './storage.ts'

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
  readonly afterSourceStage?: () => Promise<void>;
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

function validateDispositionOptions(
  options: DisposeRunOptions,
  now: Date
): void {
  const credentialDisposition = options.reason === 'credential-detected'
  const incidentRetention = options.disposition === 'incident-retain'

  if (credentialDisposition && options.credentialAction === undefined) {
    throw new ResultError(
      'LIFECYCLE_REJECTED',
      'Credential disposition requires owner rotation or revocation attestation',
      { stage: 'disposition' }
    )
  }

  if (!credentialDisposition && options.credentialAction !== undefined) {
    throw new ResultError(
      'LIFECYCLE_REJECTED',
      'Credential action is only valid for credential-detected disposition',
      { stage: 'disposition' }
    )
  }

  if (incidentRetention && !credentialDisposition) {
    throw new ResultError(
      'LIFECYCLE_REJECTED',
      'Incident retention is only valid for restricted credential evidence',
      { stage: 'disposition' }
    )
  }

  if (incidentRetention) {
    const expiresAt = options.incidentExpiresAt

    const timestampValid =
      expiresAt !== undefined &&
      v.safeParse(ResultTimestampSchema, expiresAt).success

    if (
      !timestampValid ||
      expiresAt === undefined ||
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

function validateDisposition(
  normalizationResult: NormalizeRunResult,
  options: DisposeRunOptions,
  now: Date
): void {
  const runId = normalizationResult.record.record_type === 'normalized'
    ? normalizationResult.record.identities.run.run_id
    : normalizationResult.record.identity.run_id

  if (options.confirmRunId !== runId) {
    throw new ResultError(
      'LIFECYCLE_REJECTED',
      'Run ID confirmation does not match the selected run',
      { stage: 'disposition' }
    )
  }

  if (
    normalizationResult.kind === 'restricted' &&
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
      normalizationResult.kind !== 'normalized' ||
      normalizationResult.record.retention.classification !== 'private'
    ) {
      throw new ResultError(
        'LIFECYCLE_REJECTED',
        'Public run records cannot be deleted by the private retention workflow',
        { stage: 'disposition' }
      )
    }

    if (
      options.reason === 'retention-expired' &&
      Date.parse(normalizationResult.record.retention.expires_at) > now.getTime()
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
      normalizationResult.kind !== 'restricted' ||
      !['credential_detected', 'raw_quarantined'].includes(
        normalizationResult.record.restriction.category
      )
    ) {
      throw new ResultError(
        'LIFECYCLE_REJECTED',
        'Credential disposition requires an existing restriction record',
        { stage: 'disposition' }
      )
    }
  }
}

const StoredRestrictionSchema = v.union([
  RestrictedRunRecordV1Schema,
  RunTombstoneV1Schema
])

async function validateStoredRecord(
  runsRoot: string,
  runId: string,
  category: ResultRecordCategory,
  address: string
): Promise<string> {
  const recordPath = resolve(
    runsRoot,
    '.results',
    runId,
    category,
    address,
    'record.json'
  )

  if (category === 'normalized') {
    const stored = await readStoredRecord(
      recordPath,
      category,
      NormalizedRunRecordV1Schema
    )

    if (stored.record.identities.run.run_id !== runId) {
      throw new ResultError(
        'DISPOSITION_FAILED',
        'Managed result identity does not match its run directory',
        { stage: 'disposition' }
      )
    }

    return stored.digest
  }

  if (category === 'exports') {
    const stored = await readStoredRecord(
      recordPath,
      category,
      SanitizedRunExportV1Schema
    )

    if (stored.record.identities.run.run_id !== runId) {
      throw new ResultError(
        'DISPOSITION_FAILED',
        'Managed result identity does not match its run directory',
        { stage: 'disposition' }
      )
    }

    return stored.digest
  }

  const stored = await readStoredRecord(
    recordPath,
    category,
    StoredRestrictionSchema
  )

  if (stored.record.identity.run_id !== runId) {
    throw new ResultError(
      'DISPOSITION_FAILED',
      'Managed result identity does not match its run directory',
      { stage: 'disposition' }
    )
  }

  return stored.digest
}

async function derivedRecordDigests(
  runsRoot: string,
  runId: string
): Promise<readonly string[]> {
  const runResults = resolve(runsRoot, '.results', runId)
  const digests = new Set<string>()

  const categories: readonly ResultRecordCategory[] = [
    'exports',
    'normalized',
    'restrictions'
  ]

  let runMetadata

  try {
    runMetadata = await lstat(runResults)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }

    throw new ResultError(
      'DISPOSITION_FAILED',
      'Managed derived run directory is unavailable',
      {
        cause: error,
        stage: 'disposition'
      }
    )
  }

  try {
    if (
      runMetadata.isSymbolicLink() ||
      !runMetadata.isDirectory() ||
      (runMetadata.mode & 0o777) !== 0o700
    ) {
      throw new ResultError(
        'DISPOSITION_FAILED',
        'Managed derived run directory is not sealed',
        { stage: 'disposition' }
      )
    }

    const categoryEntries = await readdir(runResults, { withFileTypes: true })

    for (const categoryEntry of categoryEntries) {
      if (
        !categoryEntry.isDirectory() ||
        !categories.includes(categoryEntry.name as ResultRecordCategory)
      ) {
        throw new ResultError(
          'DISPOSITION_FAILED',
          'Managed derived run directory contains an unexpected entry',
          { stage: 'disposition' }
        )
      }

      const category = categoryEntry.name as ResultRecordCategory
      const categoryRoot = resolve(runResults, category)
      const categoryMetadata = await lstat(categoryRoot)

      if (
        categoryMetadata.isSymbolicLink() ||
        !categoryMetadata.isDirectory() ||
        (categoryMetadata.mode & 0o777) !== 0o700
      ) {
        throw new ResultError(
          'DISPOSITION_FAILED',
          'Managed result category is not sealed',
          { stage: 'disposition' }
        )
      }

      const addresses = await readdir(categoryRoot, { withFileTypes: true })

      for (const addressEntry of addresses) {
        if (
          !addressEntry.isDirectory() ||
          !/^[a-f0-9]{64}$/.test(addressEntry.name)
        ) {
          throw new ResultError(
            'DISPOSITION_FAILED',
            'Managed result category contains an unexpected entry',
            { stage: 'disposition' }
          )
        }

        const digest = await validateStoredRecord(
          runsRoot,
          runId,
          category,
          addressEntry.name
        )

        digests.add(digest)
      }
    }
  } catch (error) {
    throw new ResultError(
      'DISPOSITION_FAILED',
      'Managed derived records failed validation before disposition',
      {
        cause: error,
        stage: 'disposition'
      }
    )
  }

  return [...digests].sort()
}

function tombstoneRecord(
  normalizationResult: NormalizeRunResult,
  options: DisposeRunOptions,
  now: Date,
  digests: readonly string[]
): RunTombstoneV1 {
  const identity = normalizationResult.kind === 'normalized'
    ? normalizationResult.record.identities.run
    : normalizationResult.record.identity

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

    source_digests: normalizationResult.record.source_digests,
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

type SourceDispositionState = 'canonical' | 'deleted' | 'staged'
type DerivedDispositionState = 'absent' | 'canonical' | 'deleted' | 'staged'
type TombstoneDispositionState = 'absent' | 'installed' | 'sealed' | 'staging'
type ReservationDispositionState = 'absent' | 'installed'

async function createDispositionReservation(
  runsRoot: string,
  runId: string
): Promise<string> {
  const reservationPath = runDispositionReservationPath(runsRoot, runId)
  const reservationRoot = dirname(reservationPath)

  try {
    await mkdir(reservationRoot, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }

  const rootMetadata = await lstat(reservationRoot)

  if (
    rootMetadata.isSymbolicLink() ||
    !rootMetadata.isDirectory() ||
    (rootMetadata.mode & 0o777) !== 0o700
  ) {
    throw new ResultError(
      'DISPOSITION_FAILED',
      'Run reservation root is not a real mode-0700 directory',
      { stage: 'disposition' }
    )
  }

  try {
    await writeFile(reservationPath, `${runId}\n`, {
      flag: 'wx',
      mode: 0o400
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ResultError(
        'LIFECYCLE_REJECTED',
        'Run ID already has a disposition reservation',
        {
          cause: error,
          stage: 'disposition'
        }
      )
    }

    throw error
  }

  return reservationPath
}

async function removeDispositionReservation(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    return
  }

  await chmod(path, 0o600)
  await rm(path)
}

async function existingRecoveryPaths(
  runsRoot: string,
  paths: readonly string[]
): Promise<readonly string[]> {
  const existing: string[] = []

  for (const path of paths) {
    const exists = await pathExists(path).catch(() => false)

    if (exists) {
      existing.push(relative(runsRoot, path).split('\\').join('/'))
    }
  }

  return existing.sort()
}

async function deleteWithTombstone(
  runDirectory: string,
  runsRoot: string,
  runId: string,
  createRecord: () => RunTombstoneV1,
  runtime: DisposeRuntime
): Promise<DisposeRunResult> {
  const nonce = randomUUID()
  const tombstoneStaging = resolve(runsRoot, `.tombstone-${runId}-${nonce}`)
  const sourceStaging = resolve(runsRoot, `.dispose-${runId}-${nonce}`)
  const resultsRoot = resolve(runsRoot, '.results')
  const resultsSource = resolve(resultsRoot, runId)
  const resultsStaging = resolve(resultsRoot, `.dispose-${runId}-${nonce}`)
  const reservationPath = runDispositionReservationPath(runsRoot, runId)
  let sourceState: SourceDispositionState = 'canonical'

  let derivedState: DerivedDispositionState = await pathExists(resultsSource)
    ? 'canonical'
    : 'absent'

  let tombstoneState: TombstoneDispositionState = 'absent'
  let reservationState: ReservationDispositionState = 'absent'
  let sealed: Awaited<ReturnType<typeof sealTombstoneStaging>> | undefined

  try {
    await createDispositionReservation(runsRoot, runId)

    reservationState = 'installed'

    await mkdir(tombstoneStaging, { mode: 0o700 })

    tombstoneState = 'staging'

    await rename(runDirectory, sourceStaging)

    sourceState = 'staged'

    await runtime.afterSourceStage?.()
    await mkdir(runDirectory, { mode: 0o700 })

    if (derivedState === 'canonical') {
      await rename(resultsSource, resultsStaging)

      derivedState = 'staged'
    }

    await runtime.afterStage?.()
    await deleteStaged(sourceStaging)

    sourceState = 'deleted'

    if (derivedState === 'staged') {
      await deleteStaged(resultsStaging)

      derivedState = 'deleted'
    }

    const record = createRecord()

    sealed = await sealTombstoneStaging(tombstoneStaging, record)

    tombstoneState = 'sealed'

    await runtime.beforeTombstoneInstall?.()

    const finalLeaf = resolve(runDirectory, basename(sealed.leafPath))

    await chmod(sealed.leafPath, 0o700)
    await rename(sealed.leafPath, finalLeaf)

    tombstoneState = 'installed'

    await chmod(finalLeaf, 0o500)
    await chmod(runDirectory, 0o500)
    await removeDispositionReservation(reservationPath)

    reservationState = 'absent'

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
      if (sourceState === 'staged') {
        if (await pathExists(runDirectory)) {
          await makeWritable(runDirectory)
          await rm(runDirectory, { recursive: true })
        }

        await restrictRemaining(sourceStaging)
        await rename(sourceStaging, runDirectory)

        sourceState = 'canonical'
      }

      if (derivedState === 'staged' && !(await pathExists(resultsSource))) {
        await restoreDerivedModes(resultsStaging)
        await rename(resultsStaging, resultsSource)

        derivedState = 'canonical'
      }

      if (sourceState === 'canonical' || sourceState === 'deleted') {
        await restrictRemaining(runDirectory)
      }

      if (sourceState === 'deleted') {
        await restrictRemaining(resultsStaging)
        await restrictRemaining(tombstoneStaging)
      }
    } catch {
      await restrictRemaining(runDirectory).catch(() => undefined)
      await restrictRemaining(sourceStaging).catch(() => undefined)
      await restrictRemaining(resultsStaging).catch(() => undefined)
      await restrictRemaining(tombstoneStaging).catch(() => undefined)
    }

    if (
      reservationState === 'installed' &&
      (sourceState === 'canonical' || tombstoneState === 'installed')
    ) {
      await removeDispositionReservation(reservationPath).catch(() => undefined)

      reservationState = 'absent'
    }

    const preserveTombstoneRecovery =
      sourceState === 'deleted' && tombstoneState !== 'installed'

    const recoveryCandidates = [
      runDirectory,
      sourceStaging,
      resultsStaging,
      reservationPath
    ]

    if (preserveTombstoneRecovery) {
      recoveryCandidates.push(tombstoneStaging)
    }

    const recoveryPaths = await existingRecoveryPaths(
      runsRoot,
      recoveryCandidates
    )

    throw new ResultError(
      'DISPOSITION_FAILED',
      'Run disposition did not complete safely; inspect restricted recovery state',
      {
        cause: error,
        recoveryPaths,
        stage: 'disposition'
      }
    )
  } finally {
    const sourceDeleted = sourceState === 'deleted'
    const tombstoneInstalled = tombstoneState === 'installed'
    const removeTombstoneStaging = !sourceDeleted || tombstoneInstalled

    if (
      removeTombstoneStaging &&
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

    if (
      reservationState === 'installed' &&
      (sourceState === 'canonical' || tombstoneInstalled)
    ) {
      await removeDispositionReservation(reservationPath).catch(() => undefined)
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

  validateDispositionOptions(options, now)

  const runsRoot = resolve(options.runsDirectory ?? dirname(resolvedRunDirectory))

  const normalizationResult = await normalizeRunWithRuntime(
    resolvedRunDirectory,
    { runsDirectory: runsRoot },
    { now: () => now }
  )

  validateDisposition(normalizationResult, options, now)

  const runId = normalizationResult.kind === 'normalized'
    ? normalizationResult.record.identities.run.run_id
    : normalizationResult.record.identity.run_id

  return withRunResultLock(runsRoot, runId, async () => {
    const digests = await derivedRecordDigests(runsRoot, runId)

    if (options.disposition === 'incident-retain') {
      const record = tombstoneRecord(
        normalizationResult,
        options,
        now,
        digests
      )

      return writeContentAddressedRecord(
        runsRoot,
        runId,
        'restrictions',
        record
      )
    }

    const createRecord = () => tombstoneRecord(
      normalizationResult,
      options,
      clock(options),
      digests
    )

    return deleteWithTombstone(
      resolvedRunDirectory,
      runsRoot,
      runId,
      createRecord,
      runtime
    )
  })
}

export async function disposeRun(
  runDirectory: string,
  options: DisposeRunOptions
): Promise<DisposeRunResult> {
  return disposeRunWithRuntime(runDirectory, options, {})
}
