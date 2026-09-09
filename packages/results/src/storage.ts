import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type * as v from 'valibot'
import { safeParse } from 'valibot'
import { ResultError } from './errors.ts'

const SHA256_PREFIX = 'sha256:'

export type ResultRecordCategory =
  | 'exports'
  | 'normalized'
  | 'regrades'
  | 'restrictions'

export interface StoredResultRecord<TRecord> {
  readonly digest: string;
  readonly record: TRecord;
  readonly recordPath: string;
}

export interface ManagedRecordLocation {
  readonly absolutePath: string;
  readonly address: string;
  readonly categoryRoot: string;
  readonly leaf: string;
  readonly resultsRoot: string;
  readonly runId: string;
  readonly runRoot: string;
  readonly runsRoot: string;
}

export interface StableFileDigest {
  readonly digest: string;
  readonly size: number;
}

export function sha256(contents: Uint8Array | string): string {
  return `${SHA256_PREFIX}${createHash('sha256').update(contents).digest('hex')}`
}

export function serializeRecord(record: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
}

function stableFileMetadataMatches(
  before: Stats,
  after: Stats,
  current: Stats
): boolean {
  return (
    before.isFile() &&
    after.isFile() &&
    !current.isSymbolicLink() &&
    current.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    before.mode === after.mode &&
    after.dev === current.dev &&
    after.ino === current.ino &&
    after.size === current.size &&
    after.mtimeMs === current.mtimeMs &&
    after.ctimeMs === current.ctimeMs &&
    after.mode === current.mode
  )
}

export async function readStableFile(path: string): Promise<Buffer> {
  const absolutePath = resolve(path)
  let handle

  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)

    const before = await handle.stat()
    const contents = await handle.readFile()
    const after = await handle.stat()
    const current = await lstat(absolutePath)

    if (!stableFileMetadataMatches(before, after, current)) {
      throw new ResultError(
        'INTEGRITY_MISMATCH',
        'Source changed while it was read',
        { stage: 'normalization' }
      )
    }

    return contents
  } catch (error) {
    if (error instanceof ResultError) {
      throw error
    }

    throw new ResultError('INVALID_INPUT', 'Required input is unavailable', {
      cause: error,
      stage: 'input'
    })
  } finally {
    await handle?.close()
  }
}

export async function hashStableFile(path: string): Promise<StableFileDigest> {
  const absolutePath = resolve(path)
  let handle

  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)

    const before = await handle.stat()
    const hash = createHash('sha256')
    const stream = handle.createReadStream({ autoClose: false })

    for await (const chunk of stream) {
      hash.update(chunk)
    }

    const after = await handle.stat()
    const current = await lstat(absolutePath)

    if (!stableFileMetadataMatches(before, after, current)) {
      throw new ResultError(
        'INTEGRITY_MISMATCH',
        'Source changed while it was hashed',
        { stage: 'normalization' }
      )
    }

    return {
      digest: `${SHA256_PREFIX}${hash.digest('hex')}`,
      size: before.size
    }
  } catch (error) {
    if (error instanceof ResultError) {
      throw error
    }

    throw new ResultError('INVALID_INPUT', 'Required input is unavailable', {
      cause: error,
      stage: 'input'
    })
  } finally {
    await handle?.close()
  }
}

export async function ensureManagedDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }

  const metadata = await lstat(path)

  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ResultError(
      'RECORD_CONFLICT',
      'Managed results path is not a real directory',
      { stage: 'normalization' }
    )
  }

  const mode = metadata.mode & 0o777

  if (mode !== 0o700) {
    throw new ResultError(
      'RECORD_CONFLICT',
      'Managed results directory has an unexpected mode',
      { stage: 'normalization' }
    )
  }
}

export function parseManagedRecordPath(
  recordPath: string,
  category: ResultRecordCategory
): ManagedRecordLocation {
  const absolutePath = resolve(recordPath)
  const leaf = dirname(absolutePath)
  const categoryRoot = dirname(leaf)
  const runRoot = dirname(categoryRoot)
  const resultsRoot = dirname(runRoot)
  const address = basename(leaf)
  const runId = basename(runRoot)

  if (
    basename(absolutePath) !== 'record.json' ||
    basename(categoryRoot) !== category ||
    basename(resultsRoot) !== '.results' ||
    !/^[a-f0-9]{64}$/.test(address) ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(runId)
  ) {
    throw new ResultError(
      'INVALID_INPUT',
      'Result record path does not match the managed layout',
      { stage: 'input' }
    )
  }

  return {
    absolutePath,
    address,
    categoryRoot,
    leaf,
    resultsRoot,
    runId,
    runRoot,
    runsRoot: dirname(resultsRoot)
  }
}

// Serializes publication and restriction commits for one managed run.
export async function withRunResultLock<T>(
  runsRoot: string,
  runId: string,
  operation: () => Promise<T>
): Promise<T> {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(runId)) {
    throw new ResultError('INVALID_INPUT', 'Run ID is invalid', {
      stage: 'input'
    })
  }

  const resultsRoot = resolve(runsRoot, '.results')
  const locksRoot = resolve(resultsRoot, '.locks')

  await ensureManagedDirectory(resultsRoot)
  await ensureManagedDirectory(locksRoot)

  const lockPath = resolve(locksRoot, `${runId}.lock`)
  let handle

  try {
    handle = await open(
      lockPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code

    if (code === 'EEXIST') {
      throw new ResultError(
        'RECORD_CONFLICT',
        'Another result operation is active for this run',
        {
          cause: error,
          stage: 'normalization'
        }
      )
    }

    throw new ResultError(
      'RECORD_CONFLICT',
      'Could not acquire the result operation lock',
      {
        cause: error,
        stage: 'normalization'
      }
    )
  }

  try {
    return await operation()
  } finally {
    await handle.close()
    await rm(lockPath, { force: true })
  }
}

export async function withRunResultLocks<T>(
  runsRoot: string,
  runIds: readonly string[],
  operation: () => Promise<T>,
  runtime: {
    readonly afterAcquire?: (runId: string) => Promise<void>;
  } = {}
): Promise<T> {
  const unique = [...new Set(runIds)].sort()

  async function acquire(index: number): Promise<T> {
    const runId = unique[index]

    if (runId === undefined) return operation()

    return withRunResultLock(
      runsRoot,
      runId,
      async () => {
        await runtime.afterAcquire?.(runId)

        return acquire(index + 1)
      }
    )
  }

  return acquire(0)
}

async function validateExistingRecord(
  leaf: string,
  expected: Buffer
): Promise<void> {
  const [metadata, entries] = await Promise.all([
    lstat(leaf),
    readdir(leaf)
  ])

  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o777) !== 0o500 ||
    entries.length !== 1 ||
    entries[0] !== 'record.json'
  ) {
    throw new ResultError(
      'RECORD_CONFLICT',
      'Existing result address is not a sealed directory',
      { stage: 'normalization' }
    )
  }

  const recordPath = resolve(leaf, 'record.json')
  const recordMetadata = await lstat(recordPath)

  if (
    recordMetadata.isSymbolicLink() ||
    !recordMetadata.isFile() ||
    (recordMetadata.mode & 0o777) !== 0o400
  ) {
    throw new ResultError(
      'RECORD_CONFLICT',
      'Existing result record is not sealed',
      { stage: 'normalization' }
    )
  }

  const existing = await readStableFile(recordPath)

  if (!existing.equals(expected)) {
    throw new ResultError(
      'RECORD_CONFLICT',
      'Existing content address does not match its record',
      { stage: 'normalization' }
    )
  }
}

export async function writeContentAddressedRecord<TRecord>(
  runsRoot: string,
  runId: string,
  category: ResultRecordCategory,
  record: TRecord
): Promise<StoredResultRecord<TRecord>> {
  const source = serializeRecord(record)
  const digest = sha256(source)
  const address = digest.slice(SHA256_PREFIX.length)
  const resultsRoot = resolve(runsRoot, '.results')
  const runRoot = resolve(resultsRoot, runId)
  const categoryRoot = resolve(runRoot, category)

  for (const path of [resultsRoot, runRoot, categoryRoot]) {
    await ensureManagedDirectory(path)
  }

  const leaf = resolve(categoryRoot, address)
  const recordPath = resolve(leaf, 'record.json')

  try {
    await validateExistingRecord(leaf, source)

    return {
      digest,
      record,
      recordPath
    }
  } catch (error) {
    if (
      error instanceof ResultError ||
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      throw error
    }
  }

  const staging = resolve(categoryRoot, `.${address}.${randomUUID()}`)

  try {
    await mkdir(staging, { mode: 0o700 })

    await writeFile(resolve(staging, 'record.json'), source, {
      flag: 'wx',
      mode: 0o600
    })

    await chmod(resolve(staging, 'record.json'), 0o400)
    await chmod(staging, 0o500)

    try {
      await rename(staging, leaf)
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(
        (error as NodeJS.ErrnoException).code ?? ''
      )) {
        throw error
      }

      await validateExistingRecord(leaf, source)
    }
  } catch (error) {
    throw new ResultError(
      'RECORD_CONFLICT',
      'Could not seal the derived result record',
      {
        cause: error,
        stage: 'normalization'
      }
    )
  } finally {
    try {
      await chmod(staging, 0o700)

      await rm(staging, {
        force: true,
        recursive: true
      })
    } catch {
      // A successfully renamed staging directory no longer exists.
    }
  }

  return {
    digest,
    record,
    recordPath
  }
}

export async function readStoredRecord<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>
>(
  recordPath: string,
  category: ResultRecordCategory,
  schema: TSchema
): Promise<StoredResultRecord<v.InferOutput<TSchema>>> {
  const location = parseManagedRecordPath(recordPath, category)
  const resultsMetadataPromise = lstat(location.resultsRoot)
  const runMetadataPromise = lstat(location.runRoot)
  const categoryMetadataPromise = lstat(location.categoryRoot)
  const leafMetadataPromise = lstat(location.leaf)
  const leafEntriesPromise = readdir(location.leaf)
  const recordMetadataPromise = lstat(location.absolutePath)
  const sourcePromise = readStableFile(location.absolutePath)

  const [
    resultsMetadata,
    runMetadata,
    categoryMetadata,
    leafMetadata,
    leafEntries,
    recordMetadata,
    source
  ] = await Promise.all(
    [
      resultsMetadataPromise,
      runMetadataPromise,
      categoryMetadataPromise,
      leafMetadataPromise,
      leafEntriesPromise,
      recordMetadataPromise,
      sourcePromise
    ] as const
  ).catch((error: unknown) => {
    if (error instanceof ResultError) {
      throw error
    }

    throw new ResultError('INVALID_INPUT', 'Result record is unavailable', {
      cause: error,
      stage: 'input'
    })
  })

  const managedParentsValid =
    !resultsMetadata.isSymbolicLink() &&
    resultsMetadata.isDirectory() &&
    (resultsMetadata.mode & 0o777) === 0o700 &&
    !runMetadata.isSymbolicLink() &&
    runMetadata.isDirectory() &&
    (runMetadata.mode & 0o777) === 0o700 &&
    !categoryMetadata.isSymbolicLink() &&
    categoryMetadata.isDirectory() &&
    (categoryMetadata.mode & 0o777) === 0o700

  const sealedLeafValid =
    !leafMetadata.isSymbolicLink() &&
    leafMetadata.isDirectory() &&
    (leafMetadata.mode & 0o777) === 0o500 &&
    leafEntries.length === 1 &&
    leafEntries[0] === 'record.json'

  const sealedRecordValid =
    !recordMetadata.isSymbolicLink() &&
    recordMetadata.isFile() &&
    (recordMetadata.mode & 0o777) === 0o400

  if (!managedParentsValid || !sealedLeafValid || !sealedRecordValid) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Result record is not sealed',
      { stage: 'input' }
    )
  }

  const digest = sha256(source)

  if (digest.slice(SHA256_PREFIX.length) !== location.address) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Result record does not match its content address',
      { stage: 'input' }
    )
  }

  let candidate: unknown

  try {
    candidate = JSON.parse(source.toString('utf8'))
  } catch (error) {
    throw new ResultError('INVALID_INPUT', 'Result record is not valid JSON', {
      cause: error,
      stage: 'input'
    })
  }

  const parsed = safeParse(schema, candidate)

  if (!parsed.success) {
    throw new ResultError(
      'INVALID_INPUT',
      'Result record does not satisfy its versioned schema',
      { stage: 'input' }
    )
  }

  return {
    digest,
    record: parsed.output,
    recordPath: location.absolutePath
  }
}
