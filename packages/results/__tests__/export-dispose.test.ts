import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { disposeRun, disposeRunWithRuntime } from '../src/dispose.ts'
import { exportSanitizedResult as exportSanitizedResultImplementation } from '../src/export.ts'
import { normalizeRun } from '../src/normalize.ts'
import { writeContentAddressedRecord } from '../src/storage.ts'
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
        scanner_revision: 'credential-patterns-v1',
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
    const { normalized } = await normalizedFixture({ requestedModel: sentinel })

    await expect(
      exportSanitizedResult(normalized.recordPath)
    ).rejects.toMatchObject({ code: 'EXPORT_BLOCKED' })

    const exportRoot = resolve(
      normalized.recordPath,
      '../../../exports'
    )

    await expect(readdir(exportRoot)).rejects.toMatchObject({ code: 'ENOENT' })
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
          beforeTombstoneInstall: async () => {
            throw new Error('injected final install failure')
          }
        }
      )
    ).rejects.toMatchObject({ code: 'DISPOSITION_FAILED' })

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
  })
})
