import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { experimentHash, runDispositionReservationPath, writeExperimentRecord } from '@harness-bench/core'
import * as v from 'valibot'
import { disposeRun, disposeRunWithRuntime } from '../src/dispose.ts'
import { exportSanitizedResult as exportSanitizedResultImplementation } from '../src/export.ts'
import { normalizeRun } from '../src/normalize.ts'
import { RunTombstoneV1Schema } from '../src/schemas.ts'
import { sha256, withRunResultLock, writeContentAddressedRecord } from '../src/storage.ts'
import { createResultFixture, makeWritable } from './fixture.ts'

let testRoot: string

beforeEach(async () => {
  testRoot = await mkdtemp('/tmp/harness-bench-results-export-')
})

afterEach(async () => {
  await makeWritable(testRoot)

  await rm(testRoot, {
    force: true,
    recursive: true
  })
})

async function normalizedFixture(options = {}) {
  const fixture = await createResultFixture(testRoot, options)
  const before = await sourceRecordSnapshot(fixture.runDirectory)
  const normalized = await normalizeRun(fixture.runDirectory)

  expect(await sourceRecordSnapshot(fixture.runDirectory)).toBe(before)

  if (normalized.kind !== 'normalized') {
    throw new Error('Expected a normalized fixture')
  }

  return {
    fixture,
    normalized
  }
}

interface MigrationEntryFixture {
  readonly attemptId: string;
  readonly digest: string;
  readonly runId: string;
}

async function installMigration(
  runsDirectory: string,
  entries: readonly MigrationEntryFixture[]
): Promise<{ readonly digest: string; readonly leaf: string }> {
  const evaluator = {
    verifier_revision: '2',
    verifier_image_digest: `sha256:${'a'.repeat(64)}`,

    verifier_network_enforcement_sidecar_digest: {
      status: 'not_applicable',
      reason: 'Docker network mode none is direct'
    },

    scoring_revision: '2',
    rubric_revision: '2',
    rubric_digest: `sha256:${'f'.repeat(64)}`
  } as const

  const migration = {
    document_type: 'scoring_migration',
    schema_version: 1,
    migration_revision: '1',
    record_type: 'migration',
    created_at: '2026-09-06T14:00:00.000Z',

    identity: {
      migration_id: 'fixture-migration',
      revision: '2',
      definition_digest: `sha256:${'b'.repeat(64)}`
    },

    experiment: {
      experiment_id: 'fixture-experiment',
      experiment_revision: '1',
      plan_digest: `sha256:${'c'.repeat(64)}`
    },

    targets: [{
      task_id: 'fixture-task',
      task_document_digest: `sha256:${'d'.repeat(64)}`,
      task_package_digest: `sha256:${'e'.repeat(64)}`,

      source_evaluator: {
        ...evaluator,
        scoring_revision: '1',
        rubric_revision: '1',
        rubric_digest: `sha256:${'9'.repeat(64)}`
      },

      target_evaluator: evaluator
    }],

    entries: entries.map((entry) => ({
      run_id: entry.runId,
      attempt_id: entry.attemptId,
      source_normalized_digest: entry.digest,
      status: 'retained_technical' as const,
      classification: 'agent_failure' as const
    })),

    regrade_provider_calls: 0
  } as const

  const migrationDigest = experimentHash(migration)

  const migrationLeaf = resolve(
    runsDirectory,
    '.experiments/migrations',
    migrationDigest.slice(7)
  )

  await mkdir(migrationLeaf, {
    recursive: true,
    mode: 0o700
  })

  await writeExperimentRecord(resolve(migrationLeaf, 'record.json'), migration)
  await chmod(migrationLeaf, 0o500)

  return {
    digest: migrationDigest,
    leaf: migrationLeaf
  }
}

async function sourceRecordSnapshot(runDirectory: string) {
  const entries: unknown[] = []

  async function visit(path: string): Promise<void> {
    const metadata = await lstat(path)
    const relativePath = relative(runDirectory, path).split('\\').join('/')

    if (metadata.isDirectory()) {
      entries.push({
        kind: 'directory',
        mode: metadata.mode & 0o777,
        path: relativePath
      })

      for (const entry of (await readdir(path)).sort()) {
        await visit(resolve(path, entry))
      }

      return
    }

    const contents = await readFile(path)

    entries.push({
      digest: createHash('sha256').update(contents).digest('hex'),
      kind: 'file',
      mode: metadata.mode & 0o777,
      path: relativePath,
      size: metadata.size
    })
  }

  await visit(runDirectory)

  return createHash('sha256')
    .update(JSON.stringify(entries))
    .digest('hex')
}

async function exportSanitizedResult(
  ...arguments_: Parameters<typeof exportSanitizedResultImplementation>
): Promise<Awaited<ReturnType<typeof exportSanitizedResultImplementation>>> {
  const normalizedPath = resolve(arguments_[0])
  const runRoot = dirname(dirname(dirname(normalizedPath)))
  const runsRoot = dirname(dirname(runRoot))
  const runDirectory = resolve(runsRoot, basename(runRoot))
  const before = await sourceRecordSnapshot(runDirectory)

  try {
    return await exportSanitizedResultImplementation(...arguments_)
  } finally {
    expect(await sourceRecordSnapshot(runDirectory)).toBe(before)
  }
}

describe('exportSanitizedResult', () => {
  it('rebuilds and seals a metadata-only allowlisted export', async () => {
    const { fixture, normalized } = await normalizedFixture()
    const before = await sourceRecordSnapshot(fixture.runDirectory)

    const result = await exportSanitizedResult(normalized.recordPath, {
      now: new Date('2026-09-06T14:00:00Z')
    })

    const after = await sourceRecordSnapshot(fixture.runDirectory)

    expect(result.record).toMatchObject({
      document_type: 'sanitized_run_export',
      source_normalized_digest: normalized.digest,

      outcome: {
        classification: 'task_success',
        valid_grade: true
      },

      redaction_report: {
        scanner_revision: 'credential-patterns-v4',
        credential_findings: 0,
        content_bytes_included: false,
        local_paths_included: false,
        publication_authorized: false
      }
    })

    expect(after).toEqual(before)

    const source = await readFile(result.recordPath, 'utf8')

    expect(source).not.toContain(fixture.runDirectory)
    expect(source).not.toContain('workspace.patch')
    expect(source).not.toContain('codex.txt')
    expect(source).not.toContain('trajectory.json')
    expect(source).not.toContain('Not measured by this fixture')
    expect(source).not.toContain('normalized fixture')
    expect(source).not.toMatch(/"path"\s*:/)
    expect(source).not.toMatch(/"reason"\s*:/)
    expect((await lstat(result.recordPath)).mode & 0o777).toBe(0o400)
    expect((await lstat(resolve(result.recordPath, '..'))).mode & 0o777).toBe(0o500)
  })

  it('rechecks the exact normalized content address', async () => {
    const { normalized } = await normalizedFixture()

    await chmod(normalized.recordPath, 0o600)
    await writeFile(normalized.recordPath, '{}\n')
    await chmod(normalized.recordPath, 0o400)

    await expect(
      exportSanitizedResult(normalized.recordPath)
    ).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
  })

  it('rejects a content-addressed record with inconsistent derived relationships', async () => {
    const { fixture, normalized } = await normalizedFixture()

    const inconsistent = {
      ...normalized.record,

      outcome: {
        ...normalized.record.outcome,
        valid_grade: false
      }
    }

    const stored = await writeContentAddressedRecord(
      fixture.runsDirectory,
      'fixture-run',
      'normalized',
      inconsistent
    )

    await expect(
      exportSanitizedResult(stored.recordPath)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('rejects extra files in a content-addressed leaf', async () => {
    const { normalized } = await normalizedFixture()
    const leaf = resolve(normalized.recordPath, '..')

    await chmod(leaf, 0o700)
    await writeFile(resolve(leaf, 'unexpected.json'), '{}\n', { mode: 0o400 })
    await chmod(leaf, 0o500)

    await expect(
      exportSanitizedResult(normalized.recordPath)
    ).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
  })

  it('blocks export when restriction state exists', async () => {
    const { normalized } = await normalizedFixture()

    const restrictionRoot = resolve(
      normalized.recordPath,
      '../../../restrictions',
      '1'.repeat(64)
    )

    await mkdir(restrictionRoot, {
      recursive: true,
      mode: 0o700
    })

    await expect(
      exportSanitizedResult(normalized.recordPath)
    ).rejects.toMatchObject({ code: 'EXPORT_BLOCKED' })
  })

  it('scans the finished export bytes before sealing', async () => {
    const sentinel = 'sk-exportCredentialSentinel1234567890'
    const { fixture, normalized } = await normalizedFixture()

    const unsafeRecord = {
      ...normalized.record,

      identities: {
        ...normalized.record.identities,

        agent: {
          ...normalized.record.identities.agent,
          requested_model: sentinel
        }
      }
    }

    const stored = await writeContentAddressedRecord(
      fixture.runsDirectory,
      'fixture-run',
      'normalized',
      unsafeRecord
    )

    await expect(
      exportSanitizedResult(stored.recordPath)
    ).rejects.toMatchObject({ code: 'EXPORT_BLOCKED' })

    const exportRoot = resolve(
      normalized.recordPath,
      '../../../exports'
    )

    await expect(readdir(exportRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects path-bearing metadata before claiming local paths are absent', async () => {
    const { fixture, normalized } = await normalizedFixture()

    const pathBearingRecord = {
      ...normalized.record,

      identities: {
        ...normalized.record.identities,

        agent: {
          ...normalized.record.identities.agent,
          requested_model: '/Users/alice/private/model'
        }
      }
    }

    const stored = await writeContentAddressedRecord(
      fixture.runsDirectory,
      'fixture-run',
      'normalized',
      pathBearingRecord
    )

    await expect(
      exportSanitizedResult(stored.recordPath)
    ).rejects.toMatchObject({ code: 'EXPORT_BLOCKED' })

    const exportRoot = resolve(stored.recordPath, '../../../exports')

    await expect(readdir(exportRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not seal an export while the run result lock is held', async () => {
    const { fixture, normalized } = await normalizedFixture()

    await withRunResultLock(
      fixture.runsDirectory,
      'fixture-run',
      async () => {
        await chmod(dirname(normalized.recordPath), 0o700)
        await chmod(normalized.recordPath, 0o600)
        await rm(normalized.recordPath)

        await expect(
          exportSanitizedResult(normalized.recordPath)
        ).rejects.toMatchObject({ code: 'RECORD_CONFLICT' })
      }
    )

    const exportRoot = resolve(normalized.recordPath, '../../../exports')

    await expect(readdir(exportRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports a vanished normalized record as invalid input', async () => {
    const { normalized } = await normalizedFixture()

    await chmod(dirname(normalized.recordPath), 0o700)
    await chmod(normalized.recordPath, 0o600)
    await rm(normalized.recordPath)

    await expect(
      exportSanitizedResult(normalized.recordPath)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('disposeRun', () => {
  it.each([
    ['wrong confirmation', {
      confirmRunId: 'another-run',
      disposition: 'delete' as const,
      reason: 'owner-request' as const
    }],
    ['premature expiry', {
      confirmRunId: 'fixture-run',
      disposition: 'delete' as const,
      reason: 'retention-expired' as const,
      now: new Date('2026-09-07T00:00:00Z')
    }]
  ])('rejects %s', async (_name, options) => {
    const fixture = await createResultFixture(testRoot)

    await expect(disposeRun(fixture.runDirectory, options)).rejects.toMatchObject({
      code: 'LIFECYCLE_REJECTED'
    })

    await expect(lstat(fixture.runDirectory)).resolves.toMatchObject({})

    if (_name === 'wrong confirmation') {
      await expect(
        lstat(resolve(fixture.runsDirectory, '.results'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('rejects deletion of a public record', async () => {
    const fixture = await createResultFixture(testRoot, { private: false })

    await expect(
      disposeRun(fixture.runDirectory, {
        confirmRunId: 'fixture-run',
        disposition: 'delete',
        reason: 'owner-request'
      })
    ).rejects.toMatchObject({ code: 'LIFECYCLE_REJECTED' })
  })

  it('rejects credential disposition without restriction state', async () => {
    const fixture = await createResultFixture(testRoot)

    await expect(
      disposeRun(fixture.runDirectory, {
        confirmRunId: 'fixture-run',
        credentialAction: 'revoked',
        disposition: 'delete',
        reason: 'credential-detected'
      })
    ).rejects.toMatchObject({ code: 'LIFECYCLE_REJECTED' })
  })

  it('rejects an impossible incident expiry before normalization', async () => {
    const fixture = await createResultFixture(testRoot)

    await expect(
      disposeRun(fixture.runDirectory, {
        confirmRunId: 'fixture-run',
        credentialAction: 'revoked',
        disposition: 'incident-retain',
        incidentExpiresAt: '2027-02-30T14:00:00Z',
        now: new Date('2026-09-06T14:00:00Z'),
        reason: 'credential-detected'
      })
    ).rejects.toMatchObject({ code: 'LIFECYCLE_REJECTED' })

    await expect(
      lstat(resolve(fixture.runsDirectory, '.results'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed before deletion when a derived record is tampered', async () => {
    const { fixture, normalized } = await normalizedFixture()

    await chmod(normalized.recordPath, 0o600)
    await writeFile(normalized.recordPath, '{}\n')
    await chmod(normalized.recordPath, 0o400)

    await expect(
      disposeRun(fixture.runDirectory, {
        confirmRunId: 'fixture-run',
        disposition: 'delete',
        now: new Date('2026-09-06T14:00:00Z'),
        reason: 'owner-request'
      })
    ).rejects.toMatchObject({ code: 'DISPOSITION_FAILED' })

    expect(await readdir(fixture.runDirectory)).toContain('initial.json')
    expect(await readFile(normalized.recordPath, 'utf8')).toBe('{}\n')
  })

  it('rejects unexpected managed derived inventory before deletion', async () => {
    const { fixture, normalized } = await normalizedFixture()
    const runResults = resolve(normalized.recordPath, '../../../')

    await writeFile(resolve(runResults, 'unexpected.txt'), 'unexpected\n', {
      mode: 0o600
    })

    await expect(
      disposeRun(fixture.runDirectory, {
        confirmRunId: 'fixture-run',
        disposition: 'delete',
        reason: 'owner-request'
      })
    ).rejects.toMatchObject({ code: 'DISPOSITION_FAILED' })

    expect(await readdir(fixture.runDirectory)).toContain('initial.json')
  })

  it('rejects an unsealed empty managed category before deletion', async () => {
    const { fixture } = await normalizedFixture()

    const exportRoot = resolve(
      fixture.runsDirectory,
      '.results/fixture-run/exports'
    )

    await mkdir(exportRoot, { mode: 0o700 })
    await chmod(exportRoot, 0o755)

    await expect(
      disposeRun(fixture.runDirectory, {
        confirmRunId: 'fixture-run',
        disposition: 'delete',
        reason: 'owner-request'
      })
    ).rejects.toMatchObject({ code: 'DISPOSITION_FAILED' })

    await expect(lstat(fixture.runDirectory)).resolves.toMatchObject({})
  })

  it.each([
    ['owner request', 'owner-request' as const, new Date('2026-09-07T00:00:00Z')],
    ['expired retention', 'retention-expired' as const, new Date('2027-01-01T00:00:00Z')]
  ])('deletes private bytes for %s and installs one immutable tombstone', async (
    _name,
    reason,
    now
  ) => {
    const fixture = await createResultFixture(testRoot)

    const result = await disposeRun(fixture.runDirectory, {
      confirmRunId: 'fixture-run',
      disposition: 'delete',
      reason,
      now
    })

    expect(result.record).toMatchObject({
      reason,
      disposition: 'delete',
      deleted_from_managed_storage: true,
      external_copies_status: 'not_managed'
    })

    expect(await readdir(fixture.runDirectory)).toEqual([
      result.digest.slice('sha256:'.length)
    ])

    expect((await lstat(fixture.runDirectory)).mode & 0o777).toBe(0o500)
    expect((await lstat(result.recordPath)).mode & 0o777).toBe(0o400)

    await expect(
      lstat(resolve(fixture.runsDirectory, '.results', 'fixture-run'))
    ).rejects.toMatchObject({ code: 'ENOENT' })

    const tombstone = await readFile(result.recordPath, 'utf8')

    expect(tombstone).not.toContain('workspace.patch')
    expect(tombstone).not.toContain('trajectory')
    expect(tombstone).not.toContain('prompt')
  })

  it('deletes referencing migration manifests and records their digests', async () => {
    const { fixture, normalized } = await normalizedFixture()

    const migration = await installMigration(fixture.runsDirectory, [{
      attemptId: 'fixture-run-attempt-1',
      digest: normalized.digest,
      runId: 'fixture-run'
    }])

    const result = await disposeRun(fixture.runDirectory, {
      confirmRunId: 'fixture-run',
      disposition: 'delete',
      now: new Date('2026-09-06T14:00:00Z'),
      reason: 'owner-request'
    })

    expect(result.record.derived_record_digests).toContain(migration.digest)
    await expect(lstat(migration.leaf)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes disposition across runs that share one migration manifest', async () => {
    const first = await normalizedFixture({ runId: 'fixture-run-a' })
    const second = await normalizedFixture({ runId: 'fixture-run-b' })

    const migration = await installMigration(first.fixture.runsDirectory, [
      {
        attemptId: 'fixture-run-a-attempt-1',
        digest: first.normalized.digest,
        runId: 'fixture-run-a'
      },
      {
        attemptId: 'fixture-run-b-attempt-1',
        digest: second.normalized.digest,
        runId: 'fixture-run-b'
      }
    ])

    let continueFirst: () => void = () => undefined
    let reportFirstStaged: () => void = () => undefined

    const firstCanContinue = new Promise<void>((resolvePromise) => {
      continueFirst = resolvePromise
    })

    const firstStaged = new Promise<void>((resolvePromise) => {
      reportFirstStaged = resolvePromise
    })

    const firstDisposition = disposeRunWithRuntime(
      first.fixture.runDirectory,
      {
        confirmRunId: 'fixture-run-a',
        disposition: 'delete',
        reason: 'owner-request'
      },
      {
        afterStage: async () => {
          reportFirstStaged()

          await firstCanContinue
        }
      }
    )

    await firstStaged

    await expect(
      disposeRun(second.fixture.runDirectory, {
        confirmRunId: 'fixture-run-b',
        disposition: 'delete',
        reason: 'owner-request'
      })
    ).rejects.toMatchObject({ code: 'EXECUTION_FAILED' })

    continueFirst()

    const disposed = await firstDisposition

    expect(disposed.record.derived_record_digests).toContain(migration.digest)
    await expect(lstat(migration.leaf)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(second.fixture.runDirectory)).resolves.toMatchObject({})
  })

  it('requires credential attestation and can delete restricted bytes', async () => {
    const fixture = await createResultFixture(testRoot, {
      private: false,

      rawMutator: async (rawRoot) => {
        await writeFile(
          resolve(rawRoot, 'credential.txt'),
          'api_key=fixtureCredentialValue123456\n'
        )
      }
    })

    await expect(
      disposeRun(fixture.runDirectory, {
        confirmRunId: 'fixture-run',
        disposition: 'delete',
        reason: 'credential-detected'
      })
    ).rejects.toMatchObject({ code: 'LIFECYCLE_REJECTED' })

    const result = await disposeRun(fixture.runDirectory, {
      confirmRunId: 'fixture-run',
      credentialAction: 'rotated',
      disposition: 'delete',
      reason: 'credential-detected'
    })

    expect(result.record.owner_attestation.credential_action).toBe('rotated')
    expect(result.record.retention_classification).toBe('private')

    expect(await readFile(result.recordPath, 'utf8')).not.toContain(
      'fixtureCredentialValue123456'
    )
  })

  it('retains quarantined bytes only with a new future incident expiry', async () => {
    const fixture = await createResultFixture(testRoot, {
      private: true,
      quarantined: true
    })

    await expect(
      disposeRun(fixture.runDirectory, {
        confirmRunId: 'fixture-run',
        credentialAction: 'revoked',
        disposition: 'incident-retain',
        incidentExpiresAt: '2026-09-06T13:00:00Z',
        now: new Date('2026-09-06T14:00:00Z'),
        reason: 'credential-detected'
      })
    ).rejects.toMatchObject({ code: 'LIFECYCLE_REJECTED' })

    const result = await disposeRun(fixture.runDirectory, {
      confirmRunId: 'fixture-run',
      credentialAction: 'revoked',
      disposition: 'incident-retain',
      incidentExpiresAt: '2026-10-06T14:00:00Z',
      now: new Date('2026-09-06T14:00:00Z'),
      reason: 'credential-detected'
    })

    expect(result.record).toMatchObject({
      disposition: 'incident-retain',
      deleted_from_managed_storage: false,

      incident_expires_at: {
        status: 'known',
        value: '2026-10-06T14:00:00Z'
      }
    })

    expect((await lstat(fixture.runDirectory)).mode & 0o777).toBe(0o500)
    expect((await lstat(result.recordPath)).mode & 0o777).toBe(0o400)

    const ownerIncident = {
      ...result.record,
      reason: 'owner-request',

      owner_attestation: {
        ...result.record.owner_attestation,
        credential_action: 'not_applicable'
      }
    }

    const expiredIncident = {
      ...result.record,

      incident_expires_at: {
        status: 'known',
        value: '2026-01-01T00:00:00Z'
      }
    }

    expect(v.safeParse(RunTombstoneV1Schema, ownerIncident).success).toBe(false)
    expect(v.safeParse(RunTombstoneV1Schema, expiredIncident).success).toBe(false)
  })

  it('installs the durable reservation before moving the canonical run', async () => {
    const fixture = await createResultFixture(testRoot)

    const reservationPath = runDispositionReservationPath(
      fixture.runsDirectory,
      'fixture-run'
    )

    let reservationObserved = false

    await expect(
      disposeRunWithRuntime(
        fixture.runDirectory,
        {
          confirmRunId: 'fixture-run',
          disposition: 'delete',
          reason: 'owner-request'
        },
        {
          afterSourceStage: async () => {
            reservationObserved = (await lstat(reservationPath)).isFile()

            await expect(lstat(fixture.runDirectory)).rejects.toMatchObject({
              code: 'ENOENT'
            })

            throw new Error('injected source-stage failure')
          }
        }
      )
    ).rejects.toMatchObject({ code: 'DISPOSITION_FAILED' })

    expect(reservationObserved).toBe(true)
    expect(await readdir(fixture.runDirectory)).toContain('initial.json')
    await expect(lstat(reservationPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores restricted state and emits no false tombstone after a staged failure', async () => {
    const fixture = await createResultFixture(testRoot)

    await expect(
      disposeRunWithRuntime(
        fixture.runDirectory,
        {
          confirmRunId: 'fixture-run',
          disposition: 'delete',
          reason: 'owner-request',
          now: new Date('2026-09-06T14:00:00Z')
        },
        {
          afterStage: async () => {
            throw new Error('injected disposal failure')
          }
        }
      )
    ).rejects.toMatchObject({ code: 'DISPOSITION_FAILED' })

    expect(await readdir(fixture.runDirectory)).toContain('initial.json')
    expect((await lstat(fixture.runDirectory)).mode & 0o777).toBe(0o500)

    expect(await readdir(fixture.runsDirectory)).not.toContain(
      expect.stringMatching(/^\.tombstone-/)
    )
  })

  it('reserves the run ID and preserves sealed recovery state after a final install failure', async () => {
    const fixture = await createResultFixture(testRoot)
    let failure: unknown

    try {
      await disposeRunWithRuntime(
        fixture.runDirectory,
        {
          confirmRunId: 'fixture-run',
          disposition: 'delete',
          reason: 'owner-request',
          now: new Date('2026-09-06T14:00:00Z')
        },
        {
          beforeTombstoneInstall: async () => {
            throw new Error('injected final install failure')
          }
        }
      )
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      code: 'DISPOSITION_FAILED',

      recoveryPaths: expect.arrayContaining([
        'fixture-run',
        '.run-reservations/fixture-run'
      ])
    })

    expect(await readdir(fixture.runDirectory)).toEqual([])
    expect((await lstat(fixture.runDirectory)).mode & 0o777).toBe(0o500)

    const recoveryDirectory = (await readdir(fixture.runsDirectory)).find(
      (entry) => entry.startsWith('.tombstone-fixture-run-')
    )

    expect(recoveryDirectory).toBeDefined()

    if (recoveryDirectory === undefined) {
      throw new Error('Expected sealed tombstone recovery state')
    }

    expect(
      (await lstat(resolve(fixture.runsDirectory, recoveryDirectory))).mode &
        0o777
    ).toBe(0o500)

    const recoveryRoot = resolve(fixture.runsDirectory, recoveryDirectory)
    const addresses = await readdir(recoveryRoot)

    expect(addresses).toHaveLength(1)

    const address = addresses[0]

    if (address === undefined) {
      throw new Error('Expected one sealed tombstone address')
    }

    const leaf = resolve(recoveryRoot, address)
    const recordPath = resolve(leaf, 'record.json')
    const source = await readFile(recordPath)
    const parsed = v.parse(RunTombstoneV1Schema, JSON.parse(source.toString('utf8')))

    expect((await lstat(leaf)).mode & 0o777).toBe(0o500)
    expect((await lstat(recordPath)).mode & 0o777).toBe(0o400)
    expect(sha256(source)).toBe(`sha256:${address}`)
    expect(parsed.identity.run_id).toBe('fixture-run')
    expect(parsed.deleted_from_managed_storage).toBe(true)

    const reservationPath = runDispositionReservationPath(
      fixture.runsDirectory,
      'fixture-run'
    )

    expect((await lstat(reservationPath)).mode & 0o777).toBe(0o400)
  })
})
