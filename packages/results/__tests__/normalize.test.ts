import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResultError } from '../src/errors.ts'
import { normalizeRun as normalizeRunImplementation, normalizeRunWithRuntime } from '../src/normalize.ts'
import { withRunResultLock } from '../src/storage.ts'
import { createResultFixture, makeWritable, type FixtureClassification } from './fixture.ts'

let testRoot: string

beforeEach(async () => {
  testRoot = await mkdtemp('/tmp/harness-bench-results-normalize-')
})

afterEach(async () => {
  await makeWritable(testRoot)

  await rm(testRoot, {
    force: true,
    recursive: true
  })
})

function hash(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

async function sourceSnapshot(root: string): Promise<string> {
  const entries: unknown[] = []

  async function visit(path: string, relativePath: string): Promise<void> {
    const metadata = await lstat(path)

    if (metadata.isSymbolicLink()) {
      entries.push({
        kind: 'symlink',
        mode: metadata.mode & 0o777,
        path: relativePath,
        target: await readlink(path)
      })

      return
    }

    if (metadata.isDirectory()) {
      entries.push({
        kind: 'directory',
        mode: metadata.mode & 0o777,
        path: relativePath
      })

      for (const entry of (await readdir(path)).sort()) {
        await visit(
          resolve(path, entry),
          relativePath === '' ? entry : `${relativePath}/${entry}`
        )
      }

      return
    }

    const contents = metadata.isFile() ? await readFile(path) : Buffer.alloc(0)

    entries.push({
      digest: hash(contents),
      kind: metadata.isFile() ? 'file' : 'special',
      mode: metadata.mode & 0o777,
      path: relativePath,
      size: metadata.size
    })
  }

  await visit(root, '')

  return hash(Buffer.from(JSON.stringify(entries)))
}

async function normalizeRun(
  ...arguments_: Parameters<typeof normalizeRunImplementation>
): Promise<Awaited<ReturnType<typeof normalizeRunImplementation>>> {
  const before = await sourceSnapshot(arguments_[0])

  try {
    return await normalizeRunImplementation(...arguments_)
  } finally {
    expect(await sourceSnapshot(arguments_[0])).toBe(before)
  }
}

async function rewriteJson(
  path: string,
  mutate: (value: Record<string, unknown>) => void
): Promise<void> {
  await chmod(path, 0o600)

  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>

  mutate(value)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
  await chmod(path, 0o400)
}

describe('normalizeRun', () => {
  it('uses only the pinned provider-free deterministic integration fixture', async () => {
    const provenance = JSON.parse(
      await readFile(
        resolve(
          import.meta.dirname,
          '../../../tests/fixtures/results/harbor-0.23.0/provenance.json'
        ),
        'utf8'
      )
    ) as Record<string, unknown>

    expect(provenance).toEqual({
      fixture_kind: 'deterministic-fake-codex-integration',
      harbor_version: '0.23.0',
      harbor_source_revision: '1e5c5c6db929a10a140d05e606882c671ae20729',
      provider_calls: 0,
      contains_subscription_trajectory: false
    })
  })

  it('rejects a symlinked run source', async () => {
    const fixture = await createResultFixture(testRoot)
    const link = resolve(testRoot, 'run-link')

    await symlink(fixture.runDirectory, link)

    await expect(normalizeRun(link)).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
  })

  it('requires the run to be a direct child of the declared runs root', async () => {
    const fixture = await createResultFixture(testRoot)

    await expect(
      normalizeRun(fixture.runDirectory, { runsDirectory: testRoot })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('requires the directory basename to match the immutable run ID', async () => {
    const fixture = await createResultFixture(testRoot)
    const mismatched = resolve(fixture.runsDirectory, 'mismatched-run')

    await rename(fixture.runDirectory, mismatched)

    await expect(normalizeRun(mismatched)).rejects.toMatchObject({
      code: 'INTEGRITY_MISMATCH'
    })
  })

  it('rejects a raw path with a symlinked ancestor', async () => {
    const fixture = await createResultFixture(testRoot)
    const linked = resolve(fixture.runDirectory, 'linked')

    await chmod(fixture.runDirectory, 0o700)
    await symlink('.', linked)
    await chmod(fixture.runDirectory, 0o500)

    await rewriteJson(resolve(fixture.runDirectory, 'completion.json'), (value) => {
      value.raw_artifact_path = 'linked/raw'
    })

    await expect(normalizeRun(fixture.runDirectory)).rejects.toMatchObject({
      code: 'INTEGRITY_MISMATCH'
    })
  })

  it('normalizes sealed Harbor 0.23.0 evidence without changing source bytes or modes', async () => {
    const fixture = await createResultFixture(testRoot)
    const before = await sourceSnapshot(fixture.runDirectory)
    const result = await normalizeRun(fixture.runDirectory)
    const after = await sourceSnapshot(fixture.runDirectory)

    expect(result.kind).toBe('normalized')
    expect(after).toBe(before)

    if (result.kind !== 'normalized') {
      throw new Error('Expected a normalized fixture')
    }

    expect(result.record).toMatchObject({
      normalization_revision: '2',

      outcome: {
        classification: 'task_success',
        valid_grade: true
      },

      timings: {
        total_seconds: 10,

        agent_seconds: {
          status: 'known',
          value: 4
        },

        verifier_seconds: {
          status: 'known',
          value: 1
        }
      },

      usage: {
        input_tokens: {
          status: 'known',
          value: 12
        },

        output_tokens: {
          status: 'known',
          value: 5
        },

        upstream_api_price_estimate: {
          status: 'known',
          value: 0.25,
          currency: 'USD'
        },

        subscription_money: { status: 'not_applicable' }
      },

      merged_output_semantics: 'irreversibly_merged_stdout_stderr'
    })

    expect(result.record.references.map(({ role }) => role)).toEqual([
      'artifact_manifest',
      'atif_trajectory',
      'collected_patch',
      'collector_metadata',
      'harbor_job_result',
      'harbor_trial_log',
      'harbor_trial_result',
      'merged_agent_output',
      'native_rollout',
      'runner_process_control',
      'runner_stderr',
      'runner_stdout',
      'structured_score',
      'upstream_reward',
      'verifier_result'
    ])

    expect(result.resolvedReferences).toHaveLength(result.record.references.length)

    for (const item of result.resolvedReferences) {
      expect(isAbsolute(item.localPath)).toBe(true)
      expect(item.localPath.endsWith(`/${item.relativePath}`)).toBe(true)
      expect(item.relativePath.startsWith('/')).toBe(false)
    }

    expect((await lstat(result.recordPath)).mode & 0o777).toBe(0o400)
    expect((await lstat(resolve(result.recordPath, '..'))).mode & 0o777).toBe(0o500)
  })

  it('preserves a valid task failure as a numeric quality outcome', async () => {
    const fixture = await createResultFixture(testRoot, {
      classification: 'task_failure'
    })

    const result = await normalizeRun(fixture.runDirectory)

    expect(result.kind).toBe('normalized')

    if (result.kind === 'normalized') {
      expect(result.record.outcome).toMatchObject({
        classification: 'task_failure',
        valid_grade: true
      })

      expect(result.record.score.status).toBe('known')
    }
  })

  it.each([
    'agent_failure',
    'provider_failure',
    'runner_failure',
    'verifier_failure',
    'infrastructure_failure',
    'cancellation'
  ] as const)(
    'preserves %s as ungraded instead of inventing a numeric zero',
    async (classification: FixtureClassification) => {
      const fixture = await createResultFixture(testRoot, {
        classification,

        rawMutator: async (rawRoot) => {
          await rm(resolve(rawRoot, 'harbor/job/trial-fixture/agent'), {
            recursive: true
          })
        }
      })

      const result = await normalizeRun(fixture.runDirectory)

      expect(result.kind).toBe('normalized')

      if (result.kind === 'normalized') {
        expect(result.record.outcome).toEqual(
          expect.objectContaining({
            classification,
            valid_grade: false
          })
        )

        expect(result.record.score.status).toBe('unavailable')

        expect(result.record.evidence_availability).toEqual({
          native_rollout: 'unavailable',
          atif_trajectory: 'unavailable',
          merged_agent_output: 'unavailable'
        })
      }
    }
  )

  it.each([
    {
      name: 'known zero',

      agentResult: {
        n_input_tokens: 0,
        n_cache_tokens: 0,
        n_output_tokens: 0,
        cost_usd: 0
      },

      finalMetrics: {
        total_prompt_tokens: 0,
        total_completion_tokens: 0,
        total_cost_usd: 0
      },

      expected: {
        status: 'known',
        value: 0
      }
    },
    {
      name: 'absent',
      agentResult: undefined,
      finalMetrics: undefined,
      expected: { status: 'unknown' }
    }
  ])('preserves $name usage', async ({ agentResult, expected, finalMetrics }) => {
    const fixture = await createResultFixture(testRoot, {
      rawMutator: async (rawRoot) => {
        const resultPath = resolve(rawRoot, 'harbor/job/trial-fixture/result.json')

        const trajectoryPath = resolve(
          rawRoot,
          'harbor/job/trial-fixture/agent/trajectory.json'
        )

        await rewriteJson(resultPath, (value) => {
          if (agentResult === undefined) {
            delete value.agent_result
          } else {
            value.agent_result = agentResult
          }
        })

        await rewriteJson(trajectoryPath, (value) => {
          if (finalMetrics === undefined) {
            delete value.final_metrics
          } else {
            value.final_metrics = finalMetrics
          }
        })
      }
    })

    const result = await normalizeRun(fixture.runDirectory)

    if (result.kind !== 'normalized') {
      throw new Error('Expected normalization')
    }

    expect(result.record.usage.input_tokens).toMatchObject(expected)
    expect(result.record.usage.output_tokens).toMatchObject(expected)
    expect(result.record.usage.upstream_api_price_estimate).toMatchObject(expected)
  })

  it('keeps incomplete timing pairs unknown', async () => {
    const fixture = await createResultFixture(testRoot, {
      rawMutator: async (rawRoot) => {
        await rewriteJson(
          resolve(rawRoot, 'harbor/job/trial-fixture/result.json'),
          (value) => {
            value.agent_execution = { started_at: '2026-09-06T12:00:00Z' }
            delete value.verifier
          }
        )
      }
    })

    const result = await normalizeRun(fixture.runDirectory)

    if (result.kind !== 'normalized') {
      throw new Error('Expected normalization')
    }

    expect(result.record.timings.agent_seconds.status).toBe('unknown')
    expect(result.record.timings.verifier_seconds.status).toBe('unknown')
  })

  it.each([
    ['Harbor version', { harborVersion: '0.22.0' }],
    ['ATIF version', {
      rawMutator: async (rawRoot: string) => {
        await rewriteJson(
          resolve(rawRoot, 'harbor/job/trial-fixture/agent/trajectory.json'),
          (value) => {
            value.schema_version = 'ATIF-v1.8'
          }
        )
      }
    }]
  ] as const)('rejects an unknown %s', async (_name, options) => {
    const fixture = await createResultFixture(testRoot, options)

    await expect(normalizeRun(fixture.runDirectory)).rejects.toMatchObject({
      code: 'INCOMPATIBLE_VERSION'
    })
  })

  it.each([
    ['name', 'another-agent'],
    ['version', '0.154.1'],
    ['model_name', 'different-model']
  ] as const)('rejects ATIF agent %s drift', async (field, value) => {
    const fixture = await createResultFixture(testRoot, {
      rawMutator: async (rawRoot) => {
        await rewriteJson(
          resolve(rawRoot, 'harbor/job/trial-fixture/agent/trajectory.json'),
          (trajectory) => {
            const agent = trajectory.agent as Record<string, unknown>

            agent[field] = value
          }
        )
      }
    })

    await expect(normalizeRun(fixture.runDirectory)).rejects.toMatchObject({
      code: 'INCOMPATIBLE_EVIDENCE'
    })
  })

  it.each([
    'quiescence',
    'collection',
    'exact_manifest',
    'hashes'
  ] as const)('rejects a mismatched %s evidence digest', async (field) => {
    const fixture = await createResultFixture(testRoot)
    const completionPath = resolve(fixture.runDirectory, 'completion.json')

    await rewriteJson(completionPath, (completion) => {
      const collection = completion.collection as Record<
        string,
        { evidence_digest: { value: string } }
      >

      const proof = collection[field]

      if (proof === undefined) {
        throw new Error(`Missing ${field} fixture proof`)
      }

      proof.evidence_digest.value = `sha256:${'f'.repeat(64)}`
    })

    await expect(normalizeRun(fixture.runDirectory)).rejects.toMatchObject({
      code: 'INCOMPATIBLE_EVIDENCE'
    })
  })

  it('rejects a valid grade after collected patch evidence is removed', async () => {
    const fixture = await createResultFixture(testRoot)

    const patchPath = resolve(
      fixture.runDirectory,
      'raw/harbor/job/trial-fixture/artifacts/trusted-collector/workspace.patch'
    )

    const collectorRoot = resolve(patchPath, '..')

    await chmod(collectorRoot, 0o700)
    await rm(patchPath)
    await chmod(collectorRoot, 0o500)

    const manifestPath = resolve(fixture.runDirectory, 'raw-manifest.json')

    await chmod(manifestPath, 0o600)

    const entries = JSON.parse(await readFile(manifestPath, 'utf8')) as Array<{
      path: string;
    }>

    const updatedEntries = entries.filter(
      (entry) => !entry.path.endsWith('/workspace.patch')
    )

    await writeFile(manifestPath, `${JSON.stringify(updatedEntries, null, 2)}\n`)
    await chmod(manifestPath, 0o400)

    await rewriteJson(
      resolve(fixture.runDirectory, 'completion.json'),
      (completion) => {
        const source = Buffer.from(`${JSON.stringify(updatedEntries, null, 2)}\n`)

        completion.raw_artifact_manifest_digest = `sha256:${hash(source)}`
      }
    )

    await expect(normalizeRun(fixture.runDirectory)).rejects.toMatchObject({
      code: 'INCOMPATIBLE_EVIDENCE'
    })
  })

  it.each([
    ['malformed timestamp', async (rawRoot: string) => {
      await rewriteJson(
        resolve(rawRoot, 'harbor/job/trial-fixture/result.json'),
        (value) => {
          value.agent_execution = {
            started_at: 'not-a-timestamp',
            finished_at: '2026-09-06T12:00:03Z'
          }
        }
      )
    }],
    ['invalid calendar timestamp', async (rawRoot: string) => {
      await rewriteJson(
        resolve(rawRoot, 'harbor/job/trial-fixture/result.json'),
        (value) => {
          value.agent_execution = {
            started_at: '2026-02-30T12:00:00Z',
            finished_at: '2026-03-01T12:00:03Z'
          }
        }
      )
    }],
    ['reversed timestamp', async (rawRoot: string) => {
      await rewriteJson(
        resolve(rawRoot, 'harbor/job/trial-fixture/result.json'),
        (value) => {
          value.verifier = {
            started_at: '2026-09-06T12:00:06Z',
            finished_at: '2026-09-06T12:00:05Z'
          }
        }
      )
    }],
    ['ATIF total mismatch', async (rawRoot: string) => {
      await rewriteJson(
        resolve(rawRoot, 'harbor/job/trial-fixture/agent/trajectory.json'),
        (value) => {
          const metrics = value.final_metrics as Record<string, unknown>

          metrics.total_prompt_tokens = 999
        }
      )
    }],
    ['reward mismatch', async (rawRoot: string) => {
      await rewriteJson(
        resolve(rawRoot, 'harbor/job/trial-fixture/verifier/reward.json'),
        (value) => {
          value.direct_behavior = 0
        }
      )
    }],
    ['score identity mismatch', async (rawRoot: string) => {
      await rewriteJson(
        resolve(rawRoot, 'harbor/job/trial-fixture/verifier/score.json'),
        (value) => {
          value.run_id = 'different-run'
        }
      )
    }]
  ] as const)('rejects %s as incompatible evidence', async (_name, mutator) => {
    const fixture = await createResultFixture(testRoot, { rawMutator: mutator })

    await expect(normalizeRun(fixture.runDirectory)).rejects.toMatchObject({
      code: 'INCOMPATIBLE_EVIDENCE'
    })
  })

  it('rejects a raw byte mutation against the manifest', async () => {
    const fixture = await createResultFixture(testRoot)

    const path = resolve(
      fixture.runDirectory,
      'raw/harbor/job/trial-fixture/agent/codex.txt'
    )

    await chmod(path, 0o600)
    await writeFile(path, 'mutated raw evidence\n')
    await chmod(path, 0o400)

    await expect(normalizeRun(fixture.runDirectory)).rejects.toMatchObject({
      code: 'INTEGRITY_MISMATCH'
    })
  })

  it('rejects a raw mode mutation even when bytes still match', async () => {
    const fixture = await createResultFixture(testRoot)

    const path = resolve(
      fixture.runDirectory,
      'raw/harbor/job/trial-fixture/agent/codex.txt'
    )

    await chmod(path, 0o600)

    await expect(normalizeRun(fixture.runDirectory)).rejects.toMatchObject({
      code: 'SOURCE_NOT_SEALED'
    })
  })

  it('rejects a task outcome missing any required Codex evidence surface', async () => {
    const fixture = await createResultFixture(testRoot, {
      rawMutator: async (rawRoot) => {
        await rm(resolve(
          rawRoot,
          'harbor/job/trial-fixture/agent/trajectory.json'
        ))
      }
    })

    await expect(normalizeRun(fixture.runDirectory)).rejects.toMatchObject({
      code: 'INCOMPATIBLE_EVIDENCE'
    })
  })

  it('rejects an extra raw file missing from the manifest', async () => {
    const fixture = await createResultFixture(testRoot)
    const rawRoot = resolve(fixture.runDirectory, 'raw')

    await chmod(rawRoot, 0o700)
    await writeFile(resolve(rawRoot, 'extra.txt'), 'extra\n', { mode: 0o400 })
    await chmod(rawRoot, 0o500)

    await expect(normalizeRun(fixture.runDirectory)).rejects.toMatchObject({
      code: 'INTEGRITY_MISMATCH'
    })
  })

  it('rejects a missing manifest entry even when linkage is updated', async () => {
    const fixture = await createResultFixture(testRoot)
    const manifestPath = resolve(fixture.runDirectory, 'raw-manifest.json')
    const completionPath = resolve(fixture.runDirectory, 'completion.json')

    await chmod(manifestPath, 0o600)

    const entries = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown[]

    entries.pop()
    await writeFile(manifestPath, `${JSON.stringify(entries, null, 2)}\n`)
    await chmod(manifestPath, 0o400)

    await rewriteJson(completionPath, (value) => {
      value.raw_artifact_manifest_digest = `sha256:${hash(
        Buffer.from(JSON.stringify(entries, null, 2) + '\n')
      )}`
    })

    await expect(normalizeRun(fixture.runDirectory)).rejects.toMatchObject({
      code: 'INTEGRITY_MISMATCH'
    })
  })

  it.each(['reserved', 'symlink', 'special'] as const)(
    'rejects a nested %s raw entry',
    async (kind) => {
      const fixture = await createResultFixture(testRoot)

      const agentRoot = resolve(
        fixture.runDirectory,
        'raw/harbor/job/trial-fixture/agent'
      )

      await chmod(agentRoot, 0o700)

      if (kind === 'reserved') {
        await writeFile(
          resolve(agentRoot, 'sha256-manifest.json'),
          '{}\n',
          { mode: 0o400 }
        )
      } else if (kind === 'symlink') {
        await symlink('codex.txt', resolve(agentRoot, 'unsafe-link'))
      } else {
        execFileSync('mkfifo', [resolve(agentRoot, 'unsafe-fifo')])
      }

      await chmod(agentRoot, 0o500)

      await expect(normalizeRun(fixture.runDirectory)).rejects.toMatchObject({
        code: 'INTEGRITY_MISMATCH'
      })
    }
  )

  it('writes only a safe restriction when a credential sentinel is found', async () => {
    const sentinel = 'sk-fixtureCredentialSentinel1234567890'

    const fixture = await createResultFixture(testRoot, {
      rawMutator: async (rawRoot) => {
        await writeFile(resolve(rawRoot, 'sentinel.txt'), `${sentinel}\n`)
      }
    })

    const before = await sourceSnapshot(fixture.runDirectory)
    const result = await normalizeRun(fixture.runDirectory)
    const after = await sourceSnapshot(fixture.runDirectory)

    expect(result.kind).toBe('restricted')
    expect(after).toBe(before)

    if (result.kind !== 'restricted') {
      throw new Error('Expected restriction')
    }

    expect(result.record.restriction).toMatchObject({
      category: 'credential_detected',
      publication: 'blocked',
      rotation_or_revocation: 'pending',
      disposition: 'pending'
    })

    expect(result.record).not.toHaveProperty('retention')

    const derived = await readFile(result.recordPath, 'utf8')

    expect(derived).not.toContain(sentinel)
  })

  it('restricts scanner-detectable credentials in immutable run metadata', async () => {
    const sentinel = 'sk-fixtureMetadataSentinel1234567890'

    const fixture = await createResultFixture(testRoot, {
      requestedModel: sentinel
    })

    const result = await normalizeRun(fixture.runDirectory)

    expect(result.kind).toBe('restricted')

    if (result.kind !== 'restricted') {
      throw new Error('Expected metadata restriction')
    }

    expect(result.record.restriction.findings).toContainEqual({
      category: 'provider_token',
      path: 'initial.json'
    })

    expect(await readFile(result.recordPath, 'utf8')).not.toContain(sentinel)
  })

  it('does not seal a restriction while the run result lock is held', async () => {
    const fixture = await createResultFixture(testRoot, {
      requestedModel: 'sk-fixtureLockedSentinel1234567890'
    })

    let finalSnapshotReached = false

    await withRunResultLock(
      fixture.runsDirectory,
      'fixture-run',
      async () => {
        await expect(
          normalizeRunWithRuntime(
            fixture.runDirectory,
            { runsDirectory: fixture.runsDirectory },
            {
              now: () => new Date('2026-09-06T13:00:00Z'),

              beforeFinalSnapshot: async () => {
                finalSnapshotReached = true
              }
            }
          )
        ).rejects.toMatchObject({ code: 'RECORD_CONFLICT' })
      }
    )

    expect(finalSnapshotReached).toBe(false)

    await expect(
      readdir(resolve(fixture.runsDirectory, '.results/fixture-run'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('turns an issue-7 quarantined source into a restriction', async () => {
    const fixture = await createResultFixture(testRoot, { quarantined: true })
    const result = await normalizeRun(fixture.runDirectory)

    expect(result.kind).toBe('restricted')

    if (result.kind === 'restricted') {
      expect(result.record.restriction.category).toBe('raw_quarantined')
    }
  })

  it('fails closed when the source changes before the final snapshot', async () => {
    const fixture = await createResultFixture(testRoot)

    const path = resolve(
      fixture.runDirectory,
      'raw/harbor/job/trial-fixture/agent/codex.txt'
    )

    await expect(
      normalizeRunWithRuntime(
        fixture.runDirectory,
        { runsDirectory: fixture.runsDirectory },
        {
          now: () => new Date('2026-09-06T13:00:00Z'),

          beforeFinalSnapshot: async () => {
            await chmod(path, 0o600)
            await writeFile(path, 'changed during normalization\n')
            await chmod(path, 0o400)
          }
        }
      )
    ).rejects.toBeInstanceOf(ResultError)
  })
})
