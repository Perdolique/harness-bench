import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CompletionRunRecordSchema, InitialRunRecordSchema } from '@harness-bench/schemas'
import * as v from 'valibot'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResultError } from '../src/errors.ts'
import { normalizeRun } from '../src/normalize.ts'
import { readNormalizedRunRecord } from '../src/read.ts'
import { serializeRecord, sha256, writeContentAddressedRecord } from '../src/storage.ts'
import { createResultFixture, makeWritable } from './fixture.ts'

let root: string

beforeEach(async () => { root = await mkdtemp('/tmp/harness-bench-report-read-') })

afterEach(async () => {
  await makeWritable(root)

  await rm(root, {
    recursive: true,
    force: true
  })
})

async function prepared() {
  const fixture = await createResultFixture(root)
  const result = await normalizeRun(fixture.runDirectory)

  if (result.kind !== 'normalized') throw new Error('Expected normalized fixture')

  return result
}

async function inventory(directory: string): Promise<string> {
  const entries: unknown[] = []

  for (const name of (await readdir(directory)).sort()) {
    const path = resolve(directory, name)
    const stat = await lstat(path)
    const value = stat.isDirectory() ? await inventory(path) : sha256(await readFile(path))

    entries.push([name, stat.mode, value])
  }

  return JSON.stringify(entries)
}

async function replaceSealedFile(path: string, source: string | Buffer): Promise<void> {
  await chmod(path, 0o600)
  await writeFile(path, source)
  await chmod(path, 0o400)
}

async function expectBlockedWithoutEcho(recordPath: string, sentinel: string): Promise<void> {
  const error = await readNormalizedRunRecord(recordPath).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(ResultError)

  if (!(error instanceof ResultError)) throw new Error('Expected a result error')

  expect(error.code).toBe('EXPORT_BLOCKED')
  expect(error.message).not.toContain(sentinel)
  expect(String(error)).not.toContain(sentinel)
  expect(JSON.stringify(error)).not.toContain(sentinel)
}

describe(readNormalizedRunRecord, () => {
  it('accepts the canonical depth-first raw manifest order', async () => {
    const fixture = await createResultFixture(root, {
      rawMutator: async (rawRoot) => {
        await mkdir(resolve(rawRoot, 'alpha'))
        await writeFile(resolve(rawRoot, 'alpha/file.txt'), 'nested\n')
        await writeFile(resolve(rawRoot, 'alpha.json'), '{}\n')
      }
    })

    const normalized = await normalizeRun(fixture.runDirectory)

    if (normalized.kind !== 'normalized') throw new Error('Expected normalized fixture')

    const result = await readNormalizedRunRecord(normalized.recordPath)

    expect(result.record).toStrictEqual(normalized.record)
  })

  it('resolves verifier logs from the manifest and rejects tampered log bytes', async () => {
    const fixture = await createResultFixture(root, {
      rawMutator: async (rawRoot) => {
        await writeFile(resolve(rawRoot, 'harbor/job/trial-fixture/verifier/test-stdout.txt'), 'verification complete\n')
      }
    })

    const normalized = await normalizeRun(fixture.runDirectory)

    if (normalized.kind !== 'normalized') throw new Error('Expected normalized fixture')

    const result = await readNormalizedRunRecord(normalized.recordPath)
    const log = resolve(normalized.runDirectory, 'raw/harbor/job/trial-fixture/verifier/test-stdout.txt')

    expect(result.verifierLogPaths).toStrictEqual([log])
    await chmod(log, 0o600)
    await writeFile(log, 'tampered')
    await chmod(log, 0o400)
    await expect(readNormalizedRunRecord(normalized.recordPath)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
  })

  it('reads all retained paths and leaves the entire managed tree unchanged', async () => {
    const normalized = await prepared()
    const before = await inventory(root)
    const result = await readNormalizedRunRecord(normalized.recordPath)

    expect(result.record).toStrictEqual(normalized.record)
    expect(result.digest).toBe(normalized.digest)
    expect(result.resolvedReferences).toStrictEqual(normalized.resolvedReferences)
    expect(await inventory(root)).toBe(before)
    expect(sha256(await readFile(result.rawManifestPath))).toBe(result.record.source_digests.raw_manifest)

    for (const reference of result.record.references) {
      const path = resolve(result.runDirectory, reference.path)

      expect(sha256(await readFile(path))).toBe(reference.digest)
    }
  })

  it.each(['initial.json', 'completion.json', 'raw-manifest.json'])('rejects changed %s', async (name) => {
    const normalized = await prepared()
    const path = resolve(normalized.runDirectory, name)

    await chmod(path, 0o600)
    await writeFile(path, '{}\n')
    await chmod(path, 0o400)
    await expect(readNormalizedRunRecord(normalized.recordPath)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
  })

  it.each(['missing', 'bytes', 'mode', 'symlink', 'parent-symlink'] as const)('rejects %s evidence', async (mutation) => {
    const normalized = await prepared()
    const reference = normalized.resolvedReferences.find((item) => item.role === 'collected_patch')

    if (!reference) throw new Error('Missing patch')

    const path = reference.localPath
    const parent = resolve(path, '..')

    switch (mutation) {
      case 'mode':
        await chmod(path, 0o600)

        break
      case 'bytes':
        await replaceSealedFile(path, 'mutated\n')

        break
      case 'parent-symlink': {
        const upper = resolve(parent, '..')

        await chmod(upper, 0o700)
        await makeWritable(parent)
        await rm(parent, { recursive: true })
        await symlink(root, parent)
        await chmod(upper, 0o500)

        break
      }
      case 'missing':
        await chmod(parent, 0o700)
        await rm(path)
        await chmod(parent, 0o500)

        break
      case 'symlink':
        await chmod(parent, 0o700)
        await rm(path)
        await symlink(normalized.recordPath, path)
        await chmod(parent, 0o500)

        break
      default:
        mutation satisfies never
    }

    await expect(readNormalizedRunRecord(normalized.recordPath)).rejects.toThrow()
  })

  it('rejects a removed raw manifest', async () => {
    const normalized = await prepared()

    await chmod(normalized.runDirectory, 0o700)
    await rm(resolve(normalized.runDirectory, 'raw-manifest.json'))
    await chmod(normalized.runDirectory, 0o500)
    await expect(readNormalizedRunRecord(normalized.recordPath)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('rejects a normalized address with different bytes', async () => {
    const normalized = await prepared()

    await chmod(normalized.recordPath, 0o600)
    await writeFile(normalized.recordPath, '{}\n')
    await chmod(normalized.recordPath, 0o400)
    await expect(readNormalizedRunRecord(normalized.recordPath)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
  })

  it('rejects an identity that differs from its managed run', async () => {
    const normalized = await prepared()
    const other = await writeContentAddressedRecord(resolve(normalized.runDirectory, '..'), 'other-run', 'normalized', normalized.record)

    await expect(readNormalizedRunRecord(other.recordPath)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
  })

  it.each(['size', 'digest', 'executable', 'path'])('rejects a reference with conflicting %s', async (field) => {
    const normalized = await prepared()
    const record = structuredClone(normalized.record)
    const reference = record.references.find((item) => item.role === 'collected_patch')

    if (reference === undefined) throw new Error('Expected patch reference')

    if (field === 'size') reference.size += 1

    if (field === 'digest') reference.digest = `sha256:${'0'.repeat(64)}`

    if (field === 'executable') reference.executable = !reference.executable

    if (field === 'path') reference.path = 'other/workspace.patch'

    const runsRoot = resolve(normalized.runDirectory, '..')
    const stored = await writeContentAddressedRecord(runsRoot, 'fixture-run', 'normalized', record)

    await expect(readNormalizedRunRecord(stored.recordPath)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
  })

  it('rejects a normalized schema with an invalid composite', async () => {
    const normalized = await prepared()
    const record = structuredClone(normalized.record)

    if (record.score.status !== 'known') throw new Error('Expected score')

    record.score.document.composite = {
      status: 'value',
      value: 0.5
    }

    const runsRoot = resolve(normalized.runDirectory, '..')
    const stored = await writeContentAddressedRecord(runsRoot, 'fixture-run', 'normalized', record)

    await expect(readNormalizedRunRecord(stored.recordPath)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it.each(['restrictions', 'lock'])('blocks %s state without writing a record', async (state) => {
    const normalized = await prepared()
    const runsRoot = resolve(normalized.runDirectory, '..')

    const target = state === 'lock'
      ? resolve(runsRoot, '.results/.locks/fixture-run.lock')
      : resolve(runsRoot, '.results/fixture-run/restrictions/finding')

    await mkdir(resolve(target, '..'), {
      recursive: true,
      mode: 0o700
    })

    await writeFile(target, '', { mode: 0o600 })

    const before = await inventory(root)

    await expect(readNormalizedRunRecord(normalized.recordPath)).rejects.toThrow()
    expect(await inventory(root)).toBe(before)
  })

  it('rejects credential-bearing normalized metadata without echoing it', async () => {
    const normalized = await prepared()
    const record = structuredClone(normalized.record)
    const sentinel = 'sk-proj-' + 'x'.repeat(60)

    record.identities.agent.requested_model = sentinel

    const stored = await writeContentAddressedRecord(resolve(normalized.runDirectory, '..'), 'fixture-run', 'normalized', record)

    await expectBlockedWithoutEcho(stored.recordPath, sentinel)
  })

  it.each(['duplicate-key', 'escaped-value'] as const)('blocks credentials in %s JSON bytes', async (representation) => {
    const normalized = await prepared()
    const original = await readFile(normalized.recordPath, 'utf8')
    const sentinel = 'sk-proj-' + 'x'.repeat(60)

    const replacement = representation === 'duplicate-key'
      ? `"requested_model": "${sentinel}", "requested_model": "gpt-5.6-luna"`
      : `"requested_model": "\\u0073${sentinel.slice(1)}"`

    const source = original.replace(/"requested_model": "[^"]+"/, replacement)
    const digest = sha256(source)
    const address = digest.slice(7)
    const leaf = resolve(normalized.recordPath, '../..', address)
    const recordPath = resolve(leaf, 'record.json')

    expect(source).not.toBe(original)
    expect(source.includes(sentinel)).toBe(representation === 'duplicate-key')
    await mkdir(leaf, { mode: 0o700 })
    await writeFile(recordPath, source, { mode: 0o400 })
    await chmod(leaf, 0o500)
    await expectBlockedWithoutEcho(recordPath, sentinel)
  })

  it.each(['initial.json', 'completion.json'] as const)('rejects schema-invalid %s even with a matching source digest', async (name) => {
    const normalized = await prepared()
    const record = structuredClone(normalized.record)
    const source = '{}\n'
    const path = resolve(normalized.runDirectory, name)
    const field = name === 'initial.json' ? 'initial_record' : 'completion_record'

    await replaceSealedFile(path, source)

    record.source_digests[field] = sha256(source)

    const runsRoot = resolve(normalized.runDirectory, '..')
    const stored = await writeContentAddressedRecord(runsRoot, 'fixture-run', 'normalized', record)

    await expect(readNormalizedRunRecord(stored.recordPath)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it.each(['identity', 'initial-link', 'manifest-link', 'collector', 'verifier', 'lifecycle'] as const)('rejects resealed completion with conflicting %s', async (mutation) => {
    const normalized = await prepared()
    const path = resolve(normalized.runDirectory, 'completion.json')
    const source = await readFile(path, 'utf8')
    const candidate: unknown = JSON.parse(source)
    const completion = v.parse(CompletionRunRecordSchema, candidate)
    const record = structuredClone(normalized.record)

    switch (mutation) {
      case 'identity': completion.identity.attempt_id = 'other-attempt'; break
      case 'initial-link': completion.initial_manifest_digest = `sha256:${'0'.repeat(64)}`; break
      case 'manifest-link': completion.raw_artifact_manifest_digest = `sha256:${'0'.repeat(64)}`; break
      case 'collector': completion.collection.collector_revision = 'other'; break
      case 'verifier': completion.verifier.verifier_revision = 'other'; break
      case 'lifecycle': completion.completed_at = '2026-09-05T12:00:00.000Z'; break
      default: mutation satisfies never
    }

    const serialized = serializeRecord(completion)

    await replaceSealedFile(path, serialized)

    record.source_digests.completion_record = sha256(serialized)

    const runsRoot = resolve(normalized.runDirectory, '..')
    const stored = await writeContentAddressedRecord(runsRoot, 'fixture-run', 'normalized', record)

    await expect(readNormalizedRunRecord(stored.recordPath)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
  })

  it('rejects a resealed initial record whose stack differs from normalized identity', async () => {
    const normalized = await prepared()
    const initialPath = resolve(normalized.runDirectory, 'initial.json')
    const completionPath = resolve(normalized.runDirectory, 'completion.json')
    const initialSource = await readFile(initialPath, 'utf8')
    const completionSource = await readFile(completionPath, 'utf8')
    const initialCandidate: unknown = JSON.parse(initialSource)
    const completionCandidate: unknown = JSON.parse(completionSource)
    const initial = v.parse(InitialRunRecordSchema, initialCandidate)
    const completion = v.parse(CompletionRunRecordSchema, completionCandidate)
    const record = structuredClone(normalized.record)

    initial.stack.id = 'other-stack'

    const initialBytes = serializeRecord(initial)
    const initialDigest = sha256(initialBytes)

    completion.initial_manifest_digest = initialDigest

    const completionBytes = serializeRecord(completion)

    await replaceSealedFile(initialPath, initialBytes)
    await replaceSealedFile(completionPath, completionBytes)

    record.source_digests.initial_record = initialDigest
    record.source_digests.completion_record = sha256(completionBytes)

    const runsRoot = resolve(normalized.runDirectory, '..')
    const stored = await writeContentAddressedRecord(runsRoot, 'fixture-run', 'normalized', record)

    await expect(readNormalizedRunRecord(stored.recordPath)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
  })

  it.each(['revision', 'termination', 'retention', 'timing'] as const)('rejects normalized %s that disagrees with authoritative metadata', async (mutation) => {
    const normalized = await prepared()
    const record = structuredClone(normalized.record)

    switch (mutation) {
      case 'revision': record.revisions.collector_revision = 'other'; break
      case 'termination':
        record.outcome.termination = {
          kind: 'cancelled',
          reason: 'Different outcome'
        }
        break
      case 'retention':
        record.retention = {
          classification: 'private',
          default_days: 90,
          expires_at: '2026-12-01T12:00:00.000Z'
        }
        break
      case 'timing': record.timings.total_seconds += 1; break
      default: mutation satisfies never
    }

    const runsRoot = resolve(normalized.runDirectory, '..')
    const stored = await writeContentAddressedRecord(runsRoot, 'fixture-run', 'normalized', record)

    await expect(readNormalizedRunRecord(stored.recordPath)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
  })

  it.each(['initial.json', 'completion.json', 'raw-manifest.json', 'evidence', 'unreferenced-raw', 'verifier-log', 'normalized', 'run-mode', 'lock', 'restriction'] as const)(
    'rejects %s changes between inspection and the final snapshot', async (mutation) => {
      const fixture = await createResultFixture(root, {
        rawMutator: async (rawRoot) => {
          const log = resolve(rawRoot, 'harbor/job/trial-fixture/verifier/test-stdout.txt')

          await writeFile(log, 'verification complete\n')
        }
      })

      const normalized = await normalizeRun(fixture.runDirectory)

      if (normalized.kind !== 'normalized') throw new Error('Expected normalized fixture')

      let mutated = false

      const reading = readNormalizedRunRecord(normalized.recordPath, {
        beforeFinalSnapshot: async () => {
          switch (mutation) {
            case 'initial.json':
            case 'completion.json':
            case 'raw-manifest.json': {
              const path = resolve(normalized.runDirectory, mutation)

              await replaceSealedFile(path, '{}\n')

              break
            }
            case 'evidence': {
              const reference = normalized.resolvedReferences.find((item) => item.role === 'collected_patch')

              if (reference === undefined) throw new Error('Expected patch reference')

              await replaceSealedFile(reference.localPath, 'changed\n')

              break
            }
            case 'unreferenced-raw': {
              const trialLog = resolve(
                normalized.runDirectory,
                'raw/harbor/job/trial-fixture/trial.log'
              )

              await replaceSealedFile(trialLog, 'changed\n')

              break
            }
            case 'verifier-log': {
              const log = resolve(normalized.runDirectory, 'raw/harbor/job/trial-fixture/verifier/test-stdout.txt')

              await replaceSealedFile(log, 'changed\n')

              break
            }
            case 'normalized':
              await replaceSealedFile(normalized.recordPath, '{}\n')

              break
            case 'run-mode':
              await chmod(normalized.runDirectory, 0o700)

              break
            case 'lock':
            case 'restriction':
              {
              const runsRoot = resolve(normalized.runDirectory, '..')

              const target = mutation === 'lock'
                ? resolve(runsRoot, '.results/.locks/fixture-run.lock')
                : resolve(runsRoot, '.results/fixture-run/restrictions/finding')

              const parent = resolve(target, '..')

              await mkdir(parent, {
                recursive: true,
                mode: 0o700
              })

              await writeFile(target, '', { mode: 0o600 })

              break
            }
            default: mutation satisfies never
          }

          mutated = true
        }
      })

      const code = mutation === 'lock' ? 'RECORD_CONFLICT' : mutation === 'restriction' ? 'EXPORT_BLOCKED' : 'INTEGRITY_MISMATCH'

      await expect(reading).rejects.toMatchObject({ code })
      expect(mutated).toBe(true)
    }
  )

  it('rejects an arbitrary file instead of accepting unmanaged JSON', async () => {
    await expect(readNormalizedRunRecord(resolve(root, 'record.json'))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
