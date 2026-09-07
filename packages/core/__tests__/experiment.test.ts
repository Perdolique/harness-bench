import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixture, makeHarness, writeJson } from './run-fixture.ts'
import { planExperiment, seededOrder, BLOCK_WINDOW_MS } from '../src/experiment-plan.ts'

import {
  appendExperimentProgress,
  experimentHash,
  experimentPlanDigest,
  readExperimentHistory,
  readExperimentPlan,
  saveExperimentPlan
} from '../src/experiment-storage.ts'

import { executeExperiment, invalidateExperimentBlock, rerunExperimentBlock } from '../src/experiment-execution.ts'
import { acquireExecutionLock, subscriptionLockPath } from '../src/execution-lock.ts'
import type { InvalidationCause } from '../src/experiment-contracts.ts'
import type { ExperimentRuntime, ExperimentRunState, VerifiedExperimentRun } from '../src/experiment-state.ts'
import { deriveExperimentState, experimentHistoryWithParents } from '../../results/src/experiment.ts'
import { runCli } from '../../../apps/benchctl/src/cli.ts'

vi.mock('../src/execution-lock.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/execution-lock.ts')>()

  return {
    ...original,
    subscriptionLockPath: () => `/tmp/harness-bench-experiment-test-${process.pid}.lock`
  }
})

const roots: string[] = []
let clock = new Date('2026-09-07T08:00:00.000Z')

async function cleanup(path: string): Promise<void> {
  const metadata = await lstat(path)

  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    await chmod(path, 0o700)

    for (const name of await readdir(path)) await cleanup(resolve(path, name))
  } else if (!metadata.isSymbolicLink()) await chmod(path, 0o600)
}

beforeAll(async () => {
  const root = await mkdtemp('/tmp/experiment-fake-codex-')

  roots.push(root)

  const binary = resolve(root, 'codex')

  await writeFile(binary, `#!/bin/sh
case "$1" in
  --version) echo 'codex-cli 0.153.2';;
  --strict-config) echo '{"checks":{"config.load":{"status":"ok"}}}';;
  exec) echo 'unknown configuration field zzzzzzzzzzzzzzzzzzzzzzzzzzzz_harness_bench_strict_config_control' >&2; exit 2;;
  mcp) echo '[]';;
  *) exit 9;;
esac
`, { mode: 0o700 })

  process.env.HARNESS_BENCH_TEST_CODEX_BINARY = binary
})

afterAll(async () => {
  delete process.env.HARNESS_BENCH_TEST_CODEX_BINARY

  for (const root of roots) {
    await cleanup(root)

    await rm(root, {
    recursive: true,
    force: true
  })
  }
})

async function setup(threeArms = false, repeats = 1) {
  const test = await fixture()

  roots.push(test.root)

  const original = JSON.parse(await readFile(test.options.experiment, 'utf8'))
  const other = JSON.parse(await readFile(test.options.harnessDocuments[1]!, 'utf8'))

  const definition = {
    document_type: 'experiment_definition',
    schema_version: 1,
    experiment_id: 'matrix',
    revision: '1',
    analysis_revision: '1',
    suite: test.options.suite,
    repeats,
    ordering_seed: 42,
    budget: original.budget,
    requested_concurrency: 1,

    arms: [
      {
      arm_id: 'a',
      treatment: 'A',
      stack: test.options.stackDocuments[0],
      harness_document: test.options.harnessDocuments[0],
      harness_bundle: test.options.harnessBundle
    },
      {
      arm_id: 'b',
      treatment: 'B',
      stack: test.options.stackDocuments[1],
      harness_document: test.options.harnessDocuments[1],
      harness_bundle: resolve(test.root, 'harness-b-store', other.digest.slice(7))
    }
    ],

    tasks: [{
      document: test.options.taskDocuments[0],
      source: test.options.taskSource,
      package: test.options.taskPackage
    }]
  }

  if (threeArms) {
    const harness = await makeHarness(test.root, 'harness-c', 'C instructions.\n')
    const stack = JSON.parse(await readFile(test.options.stackDocuments[0]!, 'utf8'))

    stack.stack_id = 'stack-c'; stack.digest = experimentHash('stack-c')
    stack.harness = {
      id: harness.manifest.harness_id,
      revision: '1',
      digest: harness.manifest.digest
    }

    const stackPath = resolve(test.root, 'stack-c.json')
    const harnessPath = resolve(test.root, 'harness-c.json')

    await writeJson(stackPath, stack)
    await writeJson(harnessPath, harness.manifest)

    definition.arms.push({
      arm_id: 'c',
      treatment: 'C',
      stack: stackPath,
      harness_document: harnessPath,
      harness_bundle: harness.bundlePath
    })
  }

  const path = resolve(test.root, 'definition.json')

  await writeJson(path, definition)

  const plan = await planExperiment(path, test.options.runsDirectory)

  return {
    test,
    definition,
    path,
    plan
  }
}
function fakeRuntime(results = new Map<string, VerifiedExperimentRun>()) {
  const execute = vi.fn(async (resolved) => {
    results.set(resolved.run_id, {
      classification: 'task_success',
      valid_grade: true,
      completed_at: clock.toISOString(),
      normalized_digest: experimentHash(resolved.run_id),
      normalized_path: '/tmp/verified-fixture.json',
      observed_provider: null
    })
  })

  const runtime: ExperimentRuntime = {
    now: () => clock,
    execute,

    readState: async (plan) => {
      const history = await experimentHistoryWithParents(plan)

      const runs: ExperimentRunState[] = plan.assignments.map((assignment) => {
        const start = history.find(({ event }) => event.type === 'started' && event.run_id === assignment.run_id)
        const result = results.get(assignment.run_id) ?? null

        return {
          assignment,
          started_at: start?.at ?? null,
          status: result !== null ? 'verified' : start === undefined ? 'pending' : 'interrupted',
          result
        }
      })

      return deriveExperimentState(plan, history, runs, clock)
    }
  }

  return {
    runtime,
    execute,
    results
  }
}

describe('experiment planning and execution', () => {
  it('freezes seeded three-arm repeated blocks and CLI dry-run writes nothing', async () => {
    const { plan, path, test, definition } = await setup(true, 2)

    expect(plan.assignments).toHaveLength(6)
    expect(new Set(plan.assignments.map(({ run_id }) => run_id)).size).toBe(6)
    expect(plan.experiment.blocks.every(({ completion_status, runs }) => completion_status === 'planned' && runs.length === 0)).toBe(true)

    for (let index = 0; index < 6; index += 3) expect(new Set(plan.assignments.slice(index, index + 3).map(({ block_id }) => block_id)).size).toBe(1)

    definition.arms.reverse()
    await writeJson(path, definition)
    expect(await planExperiment(path, test.options.runsDirectory)).toEqual(plan)

    const io = {
      stdout: vi.fn(),
      stderr: vi.fn()
    }

    expect(await runCli(['experiment', 'plan', path, '--runs-dir', test.options.runsDirectory, '--dry-run'], io)).toBe(0)
    expect(io.stdout.mock.calls.flat().join('')).toContain('New assignments: 6')
    await expect(lstat(test.options.runsDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(seededOrder(['c', 'b', 'a'], 42, 'test', (id) => id)).toEqual(seededOrder(['a', 'b', 'c'], 42, 'test', (id) => id))
  })

  it('rejects unsupported concurrency and input changes before any execution', async () => {
    const { plan, path, definition } = await setup()

    definition.requested_concurrency = 2

    await writeJson(path, definition)
    await expect(planExperiment(path, plan.runs_directory)).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' })

    const saved = await saveExperimentPlan(plan)
    const { runtime, execute } = fakeRuntime()
    const stackPath = plan.definition.arms[0]!.stack
    const stack = JSON.parse(await readFile(stackPath, 'utf8'))

    stack.agent.requested_model = 'changed-model'

    await writeJson(stackPath, stack)

    const state = await executeExperiment(saved, false, runtime)

    expect(execute).not.toHaveBeenCalled()
    expect(state.blocks[0]?.cause).toBe('model_changed')
  })

  it('runs sequentially, accepts task failure and skips verified IDs on resume', async () => {
    const { plan } = await setup()
    const saved = await saveExperimentPlan(plan)
    const { runtime, execute, results } = fakeRuntime()

    execute.mockImplementation(async (resolved) => {
      results.set(resolved.run_id, {
        classification: 'task_failure',
        valid_grade: true,
        completed_at: clock.toISOString(),
        normalized_digest: experimentHash(resolved.run_id),
        normalized_path: '/tmp/verified.json',
        observed_provider: null
      })
    })

    const completed = await executeExperiment(saved, false, runtime)

    expect(completed.blocks[0]?.status).toBe('completed')
    expect(execute).toHaveBeenCalledTimes(2)
    await executeExperiment(saved, true, runtime)
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(executeExperiment(saved, false, runtime)).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' })
  })

  it('stops on technical failure, resumes other blocks and reruns the entire failed block with new IDs', async () => {
    const { plan } = await setup(false, 2)
    const saved = await saveExperimentPlan(plan)
    const { runtime, execute, results } = fakeRuntime()
    const normal = execute.getMockImplementation()!

    execute.mockImplementationOnce(async (resolved) => {
      results.set(resolved.run_id, {
        classification: 'provider_failure',
        valid_grade: false,
        completed_at: clock.toISOString(),
        normalized_digest: experimentHash(resolved.run_id),
        normalized_path: '/tmp/failed.json',
        observed_provider: null
      })
    })

    const stopped = await executeExperiment(saved, false, runtime)

    expect(execute).toHaveBeenCalledTimes(1)
    expect(stopped.blocks[0]?.status).toBe('invalidated')
    execute.mockImplementation(normal)
    await executeExperiment(saved, true, runtime)
    expect(execute).toHaveBeenCalledTimes(3)

    const childPath = await rerunExperimentBlock(saved, plan.assignments[0]!.block_id, '2', runtime)

    expect(execute).toHaveBeenCalledTimes(3)

    const child = await readExperimentPlan(childPath)
    const replacements = child.assignments.filter(({ origin_plan }) => origin_plan === null)

    expect(replacements).toHaveLength(2)
    expect(replacements.every(({ run_id }) => !plan.assignments.some((old) => old.run_id === run_id))).toBe(true)
    await executeExperiment(childPath, false, runtime)
    expect(execute).toHaveBeenCalledTimes(5)
    await expect(executeExperiment(saved, true, runtime)).rejects.toMatchObject({ code: 'EXECUTION_FAILED' })
    expect(results.size).toBe(5)
  })

  it('recovers a completion missing its progress append without another invocation', async () => {
    const { plan } = await setup()
    const saved = await saveExperimentPlan(plan)
    const { runtime, execute, results } = fakeRuntime()
    const first = plan.assignments[0]!

    await appendExperimentProgress(plan, {
      type: 'started',
      block_id: first.block_id,
      run_id: first.run_id
    }, clock.toISOString())

    results.set(first.run_id, {
      classification: 'task_success',
      valid_grade: true,
      completed_at: clock.toISOString(),
      normalized_digest: experimentHash(first.run_id),
      normalized_path: '/tmp/recovered.json',
      observed_provider: null
    })

    const state = await executeExperiment(saved, true, runtime)

    expect(execute).toHaveBeenCalledTimes(1)
    expect(state.blocks[0]?.status).toBe('completed')
    expect((await readExperimentHistory(plan)).entries.filter(({ event }) => event.type === 'finished')).toHaveLength(2)
  })

  it('never reuses an interrupted ID and rejects a concurrent subscription lease', async () => {
    const { plan } = await setup()
    const saved = await saveExperimentPlan(plan)
    const first = plan.assignments[0]!

    await appendExperimentProgress(plan, {
      type: 'started',
      block_id: first.block_id,
      run_id: first.run_id
    }, clock.toISOString())

    const { runtime, execute } = fakeRuntime()
    const lease = await acquireExecutionLock(subscriptionLockPath())

    try { await expect(executeExperiment(saved, true, runtime)).rejects.toMatchObject({ code: 'EXECUTION_FAILED' }) } finally { await lease() }

    const state = await executeExperiment(saved, true, runtime)

    expect(execute).not.toHaveBeenCalled()
    expect(state.blocks[0]?.cause).toBe('incomplete')
  })

  it.each([0, 1])('checks completion against the 24-hour deadline plus %i ms', async (late) => {
    clock = new Date('2026-09-07T08:00:00.000Z')

    const { plan } = await setup()
    const saved = await saveExperimentPlan(plan)
    const { runtime, execute } = fakeRuntime()
    const normal = execute.getMockImplementation()!

    execute.mockImplementation(async (resolved) => {
      if (execute.mock.calls.length === 2) clock = new Date(clock.getTime() + BLOCK_WINDOW_MS + late)

      await normal(resolved)
    })

    const state = await executeExperiment(saved, false, runtime)

    expect(state.blocks[0]?.status).toBe(late === 0 ? 'completed' : 'invalidated')

    if (late) expect(state.blocks[0]?.cause).toBe('deadline_exceeded')
  })

  it.each<InvalidationCause>(['model_changed', 'cli_changed', 'provider_changed', 'runner_changed', 'harbor_config_changed', 'harness_changed'])('retains explicit %s evidence and prevents execution', async (cause) => {
    const { plan } = await setup()
    const saved = await saveExperimentPlan(plan)
    const block = plan.assignments[0]!.block_id

    await invalidateExperimentBlock(saved, block, cause, 'Known owner observation', clock.toISOString())

    const { runtime, execute } = fakeRuntime()
    const state = await executeExperiment(saved, true, runtime)

    expect(state.blocks[0]?.cause).toBe(cause)
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects mutated plan bytes and conflicting progress records', async () => {
    const { plan } = await setup()
    const saved = await saveExperimentPlan(plan)

    await chmod(saved, 0o600)

    const changed = structuredClone(plan)

    changed.assignments[0]!.run_id = 'forged'
    changed.assignments[0]!.attempt_id = 'forged-attempt-1'

    await writeJson(saved, changed)
    await chmod(saved, 0o400)
    await expect(readExperimentPlan(saved)).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
    expect(experimentPlanDigest(changed)).not.toBe(plan.experiment.plan_digest)
  })

  it('covers every task/replicate block without relying on binding order', async () => {
    const { definition, path, test } = await setup(false, 2)
    const task = JSON.parse(await readFile(test.options.taskDocuments[0]!, 'utf8'))

    task.task_id = 'task-z'

    const secondTaskPath = resolve(test.root, 'task-z.json')

    await writeJson(secondTaskPath, task)

    definition.tasks.unshift({
      document: secondTaskPath,
      source: test.options.taskSource,
      package: test.options.taskPackage
    })

    const suite = JSON.parse(await readFile(definition.suite, 'utf8'))

    suite.tasks.push({
      task_id: 'task-z',
      revision: task.revision,
      source_digest: task.source_digest
    })

    await writeJson(definition.suite, suite)
    await writeJson(path, definition)

    const plan = await planExperiment(path, test.options.runsDirectory)

    expect(plan.assignments).toHaveLength(8)
    expect(plan.experiment.blocks).toHaveLength(4)
    definition.tasks.reverse()
    await writeJson(path, definition)
    expect(await planExperiment(path, test.options.runsDirectory)).toEqual(plan)
  })

  it('excludes a block whose verified provider identities change', async () => {
    const { plan } = await setup()
    const saved = await saveExperimentPlan(plan)
    const { runtime, execute, results } = fakeRuntime()

    execute.mockImplementation(async (resolved) => {
      results.set(resolved.run_id, {
        classification: 'task_success',
        valid_grade: true,
        completed_at: clock.toISOString(),
        normalized_digest: experimentHash(resolved.run_id),
        normalized_path: '/tmp/verified.json',
        observed_provider: String(execute.mock.calls.length)
      })
    })

    const state = await executeExperiment(saved, false, runtime)

    expect(state.blocks[0]?.cause).toBe('provider_changed')
    expect(results.size).toBe(2)
  })

  it('expires a paused block before invoking its remaining arm', async () => {
    const { plan } = await setup()
    const saved = await saveExperimentPlan(plan)
    const { runtime, execute, results } = fakeRuntime()
    const first = plan.assignments[0]!
    const before = new Date(clock.getTime() - BLOCK_WINDOW_MS - 1).toISOString()

    await appendExperimentProgress(plan, {
      type: 'started',
      block_id: first.block_id,
      run_id: first.run_id
    }, before)

    results.set(first.run_id, {
      classification: 'task_success',
      valid_grade: true,
      completed_at: before,
      normalized_digest: experimentHash(first.run_id),
      normalized_path: '/tmp/verified.json',
      observed_provider: null
    })

    const state = await executeExperiment(saved, true, runtime)

    expect(state.blocks[0]?.cause).toBe('deadline_exceeded')
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects duplicate revision publication and a non-invalidated block rerun', async () => {
    const { plan } = await setup()
    const saved = await saveExperimentPlan(plan)

    await expect(saveExperimentPlan(plan)).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' })

    const { runtime } = fakeRuntime()

    await expect(rerunExperimentBlock(saved, plan.assignments[0]!.block_id, '2', runtime)).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' })
  })

  it('reports planned state read-only and routes explicit invalidation through the CLI', async () => {
    const { plan } = await setup()
    const saved = await saveExperimentPlan(plan)

    const io = {
      stdout: vi.fn(),
      stderr: vi.fn()
    }

    expect(await runCli(['experiment', 'report', saved], io)).toBe(0)
    expect(io.stdout.mock.calls.flat().join('')).toContain('Remaining scheduled invocations: 2')
    expect((await readExperimentHistory(plan)).entries).toHaveLength(0)
    expect(await runCli(['experiment', 'invalidate', saved, '--block', plan.assignments[0]!.block_id, '--cause', 'model_changed', '--reason', 'Known test observation'], io)).toBe(0)
    expect((await readExperimentHistory(plan)).entries[0]?.event.type).toBe('invalidated')
    expect(await runCli(['experiment', 'invalidate', saved, '--block', 'missing', '--cause', 'made_up', '--reason', 'Test'], io)).toBe(2)
  })

})
