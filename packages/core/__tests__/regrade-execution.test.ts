import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskDocument } from '@harness-bench/schemas'
import { inspectRunTree } from '../src/run.ts'

import {
  executeHarborRegrade,
  HarborRegradeExecutionError,
  harborRegradeFailureDiagnostic,
  preflightHarborRegrade
} from '../src/regrade-execution.ts'

import type { ResolvedScoringMigrationTarget } from '../src/regrade-plan.ts'
import type { HarborRegradeExecutionContext } from '../src/run-execution.ts'
import { inspectTaskSource } from '../src/task.ts'
import { fixtureScore } from '../../../tests/fixtures/doctor/score.ts'
import { notificationRetryTask } from '../../../tests/fixtures/rubric/notification-retry.ts'

const digest = (character: string): string => `sha256:${character.repeat(64)}`
let root: string

beforeEach(async () => {
  root = await mkdtemp('/tmp/harness-bench-regrade-execution-')
})

afterEach(async () => {
  await rm(root, {
    force: true,
    recursive: true
  })
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, '..'), {
    recursive: true,
    mode: 0o700
  })

  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

async function preflightFixture(): Promise<{
  readonly sourceRunDirectory: string;
  readonly target: ResolvedScoringMigrationTarget;
}> {
  const sourceRunDirectory = resolve(root, 'source-run')

  const rawFixture = resolve(
    import.meta.dirname,
    '../../../tests/fixtures/results/harbor-0.22.0/raw'
  )

  await cp(rawFixture, resolve(sourceRunDirectory, 'raw'), { recursive: true })

  const pristineSourcePath = resolve(sourceRunDirectory, 'inputs/task-source')

  await mkdir(pristineSourcePath, { recursive: true })
  await writeFile(resolve(pristineSourcePath, 'README.md'), 'fixture source\n')

  const pristineSource = await inspectTaskSource(pristineSourcePath)

  await writeFile(resolve(sourceRunDirectory, 'src-auth-marker'), 'safe\n')
  await mkdir(resolve(sourceRunDirectory, 'src/auth'), { recursive: true })
  await writeFile(resolve(sourceRunDirectory, 'src/auth/login.ts'), 'export {}\n')

  const trial = resolve(
    sourceRunDirectory,
    'raw/harbor/job/trial-fixture'
  )

  const resultPath = resolve(trial, 'result.json')
  const result = JSON.parse(await readFile(resultPath, 'utf8'))

  Object.assign(result, {
    id: 'trial-fixture',
    step_results: null,
    environment_setup: {},
    agent_setup: {},
    agent_info: { name: 'codex' }
  })

  await Promise.all([
    writeJson(resolve(trial, 'config.json'), {}),
    writeJson(resolve(trial, 'lock.json'), {
      task: {
        name: 'fixture-task',
        digest: digest('a'),
        type: 'local'
      }
    }),
    writeJson(resultPath, result)
  ])

  const targetRoot = resolve(root, 'target')
  const documentPath = resolve(targetRoot, 'task.json')
  const packagePath = resolve(targetRoot, 'package')
  const targetTask = structuredClone(notificationRetryTask) as TaskDocument

  Object.assign(targetTask, {
    task_id: 'fixture-task',
    source_digest: pristineSource.digest
  })

  Object.assign(targetTask.scoring, {
    revision: '2',
    rubric_revision: '2'
  })

  targetTask.rubric = [
    {
      ...targetTask.rubric[0]!,
      obligation_id: 'direct',
      evidence_paths: ['README.md']
    },
    {
      ...targetTask.rubric[1]!,
      obligation_id: 'contracts',
      evidence_paths: ['README.md'],
      weight: 1
    },
    {
      ...targetTask.rubric.find(({ facet }) => facet === 'regression')!,
      obligation_id: 'regression',
      evidence_paths: ['README.md']
    },
    {
      ...targetTask.rubric.find(({ facet }) => facet === 'scope_integrity')!,
      obligation_id: 'scope',
      evidence_paths: ['README.md']
    }
  ]

  const document = `${JSON.stringify(targetTask, null, 2)}\n`

  await mkdir(targetRoot, { mode: 0o700 })
  await writeFile(documentPath, document)
  await mkdir(packagePath, { mode: 0o700 })
  await mkdir(resolve(packagePath, 'environment'), { mode: 0o700 })

  await writeFile(
    resolve(packagePath, 'task.toml'),
    '[environment]\ndocker_image = "source-agent"\n\n[verifier]\n\n[verifier.environment]\ndocker_image = "source-verifier"\n'
  )

  await writeFile(
    resolve(packagePath, 'environment/docker-compose.yaml'),
    'services:\n  collector:\n    image: source-collector\n'
  )

  const packageSnapshot = await inspectRunTree(packagePath)

  const target = {
    documentDigest: digestBytes(document),
    documentPath,
    packageDigest: packageSnapshot.digest,

    packageInspection: {
      imageReferences: {},

      runtimeControls: {
        agent_user: 'pwuser',
        verifier_timeout_seconds: 60
      }
    },

    packagePath,
    packageSnapshot,
    sourceTask: {} as TaskDocument,
    targetTask,
    taskId: 'fixture-task'
  } as unknown as ResolvedScoringMigrationTarget

  return {
    sourceRunDirectory,
    target
  }
}

async function writeInvalidRegradeTrial(
  context: HarborRegradeExecutionContext,
  target: ResolvedScoringMigrationTarget
): Promise<void> {
  const sourceResult = JSON.parse(
    await readFile(resolve(context.sourceTrial, 'result.json'), 'utf8')
  )

  const sourceLock = JSON.parse(
    await readFile(resolve(context.sourceTrial, 'lock.json'), 'utf8')
  )

  const trial = resolve(context.trialsDirectory, 'regrade-trial')

  await mkdir(resolve(trial, 'verifier'), { recursive: true })

  await cp(resolve(context.sourceTrial, 'agent'), resolve(trial, 'agent'), {
    recursive: true
  })

  await cp(
    resolve(context.sourceTrial, 'artifacts'),
    resolve(trial, 'artifacts'),
    { recursive: true }
  )

  await writeJson(resolve(trial, 'config.json'), {
    source_trial: {
      action: 'regrade',
      path: context.sourceTrial,
      trial_id: sourceResult.id,
      type: 'local'
    }
  })

  await writeJson(resolve(trial, 'lock.json'), {
    source_trial: {
      action: 'regrade',
      path: context.sourceTrial,
      task: sourceLock.task,
      trial_id: sourceResult.id,
      type: 'local'
    },

    task: {
      digest: digest('f'),
      name: sourceLock.task.name
    },

    verifier: {
      environment_mode: 'separate',
      env: { HARBOR_RUN_ID: context.runId }
    }
  })

  await writeJson(resolve(trial, 'result.json'), {
    agent_execution: null,
    agent_info: sourceResult.agent_info,
    agent_result: sourceResult.agent_result,
    agent_setup: null,
    environment_setup: null,
    exception_info: null,
    step_results: null,
    verifier_environment_mode: 'separate',

    verifier: {
      started_at: '2026-09-11T10:00:00.000Z',
      finished_at: '2026-09-11T10:00:01.000Z'
    }
  })

  const result = fixtureScore(context.runId, {
    contracts: true,
    direct: true,
    regression: true,
    scope: true
  }, {
    credentialsAbsent: true,
    networkIsolated: true
  })

  const verifierResult = JSON.parse(result.verifierSource)

  verifierResult.checks.extra = {
    credit: 1,
    detail: 'Unexpected but structurally valid check',
    facet: 'direct_behavior',
    passed: true
  }

  const verifierSource = `${JSON.stringify(verifierResult, null, 2)}\n`

  Object.assign(result.score, {
    verifier_result_digest: digestBytes(verifierSource),
    scoring_revision: target.targetTask.scoring.revision,
    rubric_revision: target.targetTask.scoring.rubric_revision
  })

  Object.assign(result.score.harbor_reward.numeric_values, {
    provider_calls: 0
  })

  await writeFile(
    resolve(trial, 'verifier/verifier-result.json'),
    verifierSource
  )

  await writeJson(resolve(trial, 'verifier/score.json'), result.score)
}

function digestBytes(source: string): string {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`
}

const preflightRuntime = {
  assertPinnedImages: vi.fn(async () => {
    await Promise.resolve()
  })
}

describe('preflightHarborRegrade', () => {
  it('accepts a completed source containing an ordinary src/auth directory', async () => {
    const fixture = await preflightFixture()

    await expect(
      preflightHarborRegrade(fixture, preflightRuntime)
    ).resolves.toBeUndefined()

    expect(preflightRuntime.assertPinnedImages).toHaveBeenLastCalledWith(
      fixture.target.targetTask,
      fixture.target.packageInspection.imageReferences,
      'pwuser'
    )
  })

  it.each([
    'failed-artifact',
    'multistep-source',
    'missing-config',
    'target-drift',
    'credential-finding'
  ] as const)('rejects %s before execution', async (mutation) => {
    const fixture = await preflightFixture()

    const trial = resolve(
      fixture.sourceRunDirectory,
      'raw/harbor/job/trial-fixture'
    )

    if (mutation === 'failed-artifact') {
      const path = resolve(trial, 'artifacts/manifest.json')
      const manifest = JSON.parse(await readFile(path, 'utf8'))

      manifest[0].status = 'failed'

      await writeJson(path, manifest)
    }

    if (mutation === 'multistep-source') {
      const path = resolve(trial, 'result.json')
      const result = JSON.parse(await readFile(path, 'utf8'))

      result.step_results = []

      await writeJson(path, result)
    }

    if (mutation === 'missing-config') {
      await rm(resolve(trial, 'config.json'))
    }

    if (mutation === 'target-drift') {
      await writeFile(resolve(fixture.target.packagePath, 'changed'), 'changed\n')
    }

    if (mutation === 'credential-finding') {
      await writeFile(
        resolve(fixture.sourceRunDirectory, 'credential.txt'),
        'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345\n'
      )
    }

    await expect(
      preflightHarborRegrade(fixture, preflightRuntime)
    ).rejects.toMatchObject({
      code: expect.stringMatching(/INVALID|INPUT_CHANGED/)
    })
  })

  it('rejects target rubric evidence absent from the retained pristine source', async () => {
    const fixture = await preflightFixture()

    fixture.target.targetTask.rubric[0]!.evidence_paths = [
      'src/missing-evidence.ts'
    ]

    await expect(
      preflightHarborRegrade(fixture, preflightRuntime)
    ).rejects.toMatchObject({
      code: 'INVALID_EVIDENCE',
      message: 'Regrade rubric evidence is absent from the pristine source'
    })

    expect(preflightRuntime.assertPinnedImages).not.toHaveBeenCalled()
  })
})

describe('harborRegradeFailureDiagnostic', () => {
  it.each([
    [{
      cancelled: true,
      timedOut: false,
      signal: null,
      exitCode: null
    }, 'cancellation', 'cancelled'],
    [{
      cancelled: false,
      timedOut: true,
      signal: 'SIGKILL',
      exitCode: null
    }, 'verifier_failure', 'timeout'],
    [{
      cancelled: false,
      timedOut: false,
      signal: 'SIGTERM',
      exitCode: null
    }, 'infrastructure_failure', 'error'],
    [{
      cancelled: false,
      timedOut: false,
      signal: null,
      exitCode: 2
    }, 'verifier_failure', 'error']
  ] as const)(
    'preserves %# process failure taxonomy',
    (outcome, classification, terminationKind) => {
      const diagnostic = harborRegradeFailureDiagnostic(outcome, 120)

      expect(diagnostic).toMatchObject({
        classification,
        process: outcome,
        termination: { kind: terminationKind }
      })
    }
  )

  it('returns no diagnostic for a clean verifier exit', () => {
    expect(harborRegradeFailureDiagnostic({
      cancelled: false,
      timedOut: false,
      signal: null,
      exitCode: 0
    }, 120)).toBeNull()
  })
})

describe('executeHarborRegrade', () => {
  it('fails as verifier_failure when target-rubric evidence does not match', async () => {
    const fixture = await preflightFixture()
    const staging = resolve(root, 'staging')

    await mkdir(staging, { mode: 0o700 })

    const execution = executeHarborRegrade(
      {
        migrationDefinitionDigest: digest('e'),
        runId: 'fixture-run',
        sourceRunDirectory: fixture.sourceRunDirectory,
        staging,
        target: fixture.target
      },
      {
        assertPinnedImages: preflightRuntime.assertPinnedImages,

        runHarbor: async (context) => {
          await writeInvalidRegradeTrial(context, fixture.target)

          return {
            cancelled: false,
            exitCode: 0,
            signal: null,
            timedOut: false
          }
        }
      }
    )

    await expect(execution).rejects.toBeInstanceOf(
      HarborRegradeExecutionError
    )

    await expect(execution).rejects.toMatchObject({
      diagnostic: {
        classification: 'verifier_failure',

        termination: {
          kind: 'error',
          reason: 'Regrade score does not satisfy the target task rubric contract'
        }
      }
    })
  })

  it.each(['source-root', 'agent-tree'] as const)(
    'rejects a %s mutation even when Harbor already failed',
    async (mutation) => {
      const fixture = await preflightFixture()
      const staging = resolve(root, 'staging')

      await mkdir(staging, { mode: 0o700 })

      await expect(
        executeHarborRegrade(
          {
            migrationDefinitionDigest: digest('e'),
            runId: 'fixture-run',
            sourceRunDirectory: fixture.sourceRunDirectory,
            staging,
            target: fixture.target
          },
          {
            assertPinnedImages: preflightRuntime.assertPinnedImages,

            runHarbor: async () => {
              const path = mutation === 'source-root'
                ? resolve(fixture.sourceRunDirectory, 'changed-after-preflight')
                : resolve(
                    fixture.sourceRunDirectory,
                    'raw/harbor/job/trial-fixture/agent/changed-after-preflight'
                  )

              await writeFile(path, 'changed\n')

              return {
                cancelled: false,
                exitCode: 2,
                signal: null,
                timedOut: false
              }
            }
          }
        )
      ).rejects.toMatchObject({
        code: 'INVALID_EVIDENCE',
        message: 'Source run changed during verifier-only regrade'
      })
    }
  )
})
