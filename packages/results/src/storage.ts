import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type * as v from 'valibot'
import { safeParse } from 'valibot'
import { ResultError } from './errors.ts'

const SHA256_PREFIX = 'sha256:'

export type ResultRecordCategory =
  | 'exports'
  | 'normalized'
  | 'restrictions'

export interface StoredResultRecord<TRecord> {
  readonly digest: string;
  readonly record: TRecord;
  readonly recordPath: string;
}

export function sha256(contents: Uint8Array | string): string {
  return `${SHA256_PREFIX}${createHash('sha256').update(contents).digest('hex')}`
}

export function serializeRecord(record: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
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

    if (
      !before.isFile() ||
      !after.isFile() ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.dev !== current.dev ||
      after.ino !== current.ino
    ) {
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

async function ensureManagedDirectory(path: string): Promise<void> {
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
  const absolutePath = resolve(recordPath)
  const leaf = dirname(absolutePath)
  const categoryRoot = dirname(leaf)
  const runRoot = dirname(categoryRoot)
  const resultsRoot = dirname(runRoot)
  const address = basename(leaf)

  if (
    basename(absolutePath) !== 'record.json' ||
    basename(categoryRoot) !== category ||
    !/^[a-f0-9]{64}$/.test(address)
  ) {
    throw new ResultError(
      'INVALID_INPUT',
      'Result record path does not match the managed layout',
      { stage: 'input' }
    )
  }

  const [
    resultsMetadata,
    runMetadata,
    categoryMetadata,
    leafMetadata,
    leafEntries,
    recordMetadata,
    source
  ] = await Promise.all([
    lstat(resultsRoot),
    lstat(runRoot),
    lstat(categoryRoot),
    lstat(leaf),
    readdir(leaf),
    lstat(absolutePath),
    readStableFile(absolutePath)
  ])

  if (
    resultsMetadata.isSymbolicLink() ||
    !resultsMetadata.isDirectory() ||
    (resultsMetadata.mode & 0o777) !== 0o700 ||
    runMetadata.isSymbolicLink() ||
    !runMetadata.isDirectory() ||
    (runMetadata.mode & 0o777) !== 0o700 ||
    categoryMetadata.isSymbolicLink() ||
    !categoryMetadata.isDirectory() ||
    (categoryMetadata.mode & 0o777) !== 0o700 ||
    leafMetadata.isSymbolicLink() ||
    !leafMetadata.isDirectory() ||
    (leafMetadata.mode & 0o777) !== 0o500 ||
    leafEntries.length !== 1 ||
    leafEntries[0] !== 'record.json' ||
    recordMetadata.isSymbolicLink() ||
    !recordMetadata.isFile() ||
    (recordMetadata.mode & 0o777) !== 0o400
  ) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Result record is not sealed',
      { stage: 'input' }
    )
  }

  const digest = sha256(source)

  if (digest.slice(SHA256_PREFIX.length) !== address) {
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
    recordPath: absolutePath
  }
}
