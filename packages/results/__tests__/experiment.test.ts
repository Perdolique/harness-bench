import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExperimentDocumentSchema } from '@harness-bench/schemas'
import * as v from 'valibot'

import {
  appendExperimentProgress,
  experimentPlanDigest,
  saveExperimentPlan,
  type ExperimentPlan
} from '@harness-bench/core'

import { readExperimentState } from '../src/experiment.ts'
import { normalizeRun } from '../src/normalize.ts'
import { createResultFixture, makeWritable } from './fixture.ts'

let root: string
const now = new Date('2026-09-06T12:02:00.000Z')

beforeEach(async () => { root = await mkdtemp('/tmp/experiment-results-test-') })

afterEach(async () => {
  await makeWritable(root)

  await rm(root, {
    recursive: true,
    force: true
  })
})

async function prepared() {
  const examplePath = resolve(import.meta.dirname, '../../schemas/examples/valid/experiment.json')
  const raw = JSON.parse(await readFile(examplePath, 'utf8'))

  raw.suite = {
    id: 'fixture-suite',
    revision: '1',
    digest: `sha256:${'b'.repeat(64)}`
  }
  raw.experiment_id = 'fixture-experiment'; raw.repeats = 1
  raw.arms = raw.arms.slice(0, 2)
  raw.arms[0].arm_id = 'a'
  raw.arms[1].arm_id = 'b'
  raw.arms[0].stack = {
    id: 'fixture-stack',
    revision: '1',
    digest: `sha256:${'a'.repeat(64)}`
  }
  raw.arms[0].harness = {
    id: 'fixture-harness',
    revision: '1',
    digest: `sha256:${'a'.repeat(64)}`
  }
  raw.tasks = [{
    task_id: 'fixture-task',
    revision: '1',
    source_digest: `sha256:${'b'.repeat(64)}`
  }]
  raw.blocks = [{
    block_id: 'fixture-block',
    task_id: 'fixture-task',
    replicate: 1,
    runs: [],

    first_started_at: {
      status: 'unknown',
      reason: 'Not started'
    },

    deadline_at: {
      status: 'unknown',
      reason: 'Not started'
    },

    completed_at: {
      status: 'unknown',
      reason: 'Not completed'
    },

    completion_status: 'planned',
    contemporaneity: { status: 'pending' }
  }]
  raw.execution_order = ['a', 'b'].map((arm_id, index) => ({
    sequence: index + 1,
    block_id: 'fixture-block',
    task_id: 'fixture-task',
    replicate: 1,
    arm_id
  }))

  const experiment = v.parse(ExperimentDocumentSchema, raw)
  const runsDirectory = resolve(root, 'runs')

  const plan: ExperimentPlan = {
    document_type: 'experiment_plan',
    schema_version: 1,

    definition: {
      document_type: 'experiment_definition',
      schema_version: 1,
      experiment_id: 'fixture-experiment',
      revision: '1',
      analysis_revision: '1',
      suite: '/tmp/suite.json',

      arms: ['a', 'b'].map((arm_id) => ({
        arm_id,
        treatment: arm_id,
        stack: '/tmp/stack.json',
        harness_document: '/tmp/harness.json',
        harness_bundle: '/tmp/bundle'
      })),

      tasks: [{
        document: '/tmp/task.json',
        source: '/tmp/source',
        package: '/tmp/package'
      }],

      repeats: 1,
      ordering_seed: 42,
      budget: experiment.budget,
      requested_concurrency: 1
    },

    experiment,
    runs_directory: runsDirectory,
    parent_plan: null,
    parent_progress: null,
    replaced_block: null,
    stacks: [],
    inputs: [],

    assignments: ['a', 'b'].map((arm_id) => ({
      block_id: 'fixture-block',
      arm_id,
      run_id: `fixture-${arm_id}`,
      attempt_id: `fixture-${arm_id}-attempt-1`,
      attempt: 1,
      origin_plan: null
    }))
  }

  // Fixture harness identity is independent from its stack identity.
  plan.experiment.arms[0]!.harness.digest = `sha256:${'d'.repeat(64)}`
  plan.experiment.plan_digest = experimentPlanDigest(plan)

  await saveExperimentPlan(plan)

  const fixture = await createResultFixture(root, {
    runId: 'fixture-a',
    private: false,

    experiment: {
      experiment_id: 'fixture-experiment',
      experiment_revision: '1',
      plan_digest: plan.experiment.plan_digest,
      arm_id: 'a',
      block_id: 'fixture-block',
      replicate: 1
    }
  })

  const initial = JSON.parse(await readFile(resolve(fixture.runDirectory, 'initial.json'), 'utf8'))

  expect(initial.harness).toEqual(plan.experiment.arms[0]!.harness)

  await appendExperimentProgress(plan, {
    type: 'started',
    run_id: 'fixture-a',
    block_id: 'fixture-block'
  }, '2026-09-06T12:00:00.000Z')

  return {
    plan,
    fixture
  }
}

describe('verified experiment results', () => {
  it('recovers normalization, retains the result identity and reads partial state without writes', async () => {
    const { plan } = await prepared()
    const first = await readExperimentState(plan, true, now)

    expect(first.blocks[0]?.runs[0]?.status).toBe('verified')
    expect(first.blocks[0]?.runs[1]?.status).toBe('pending')
    expect(first.blocks[0]?.status).toBe('in_progress')

    const result = first.blocks[0]!.runs[0]!.result!

    await appendExperimentProgress(plan, {
      type: 'finished',
      run_id: 'fixture-a',
      block_id: 'fixture-block',
      normalized_digest: result.normalized_digest
    }, now.toISOString())

    const directory = resolve(plan.runs_directory, '.results/fixture-a/normalized')
    const before = await readdir(directory)
    const second = await readExperimentState(plan, true, now)

    expect(second.blocks[0]?.runs[0]?.result?.normalized_digest).toBe(result.normalized_digest)
    await readExperimentState(plan, false, now)
    expect(await readdir(directory)).toEqual(before)
  })

  it('rejects changed raw evidence instead of skipping the completed run', async () => {
    const { plan, fixture } = await prepared()

    await normalizeRun(fixture.runDirectory)

    const path = resolve(fixture.runDirectory, 'raw/runner/harbor.stdout.log')

    await chmod(path, 0o600)
    await writeFile(path, 'changed')
    await chmod(path, 0o400)
    await expect(readExperimentState(plan, true, now)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
  })

  it('rejects a valid result linked to a different immutable assignment', async () => {
    const { plan } = await prepared()
    const forged = structuredClone(plan)

    forged.experiment.revision = 'different'

    await expect(readExperimentState(forged, true, now)).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  })

  it('refuses a disappeared completed run instead of turning it into pending work', async () => {
    const { plan, fixture } = await prepared()
    const state = await readExperimentState(plan, true, now)
    const result = state.blocks[0]!.runs[0]!.result!

    await appendExperimentProgress(plan, {
      type: 'finished',
      run_id: 'fixture-a',
      block_id: 'fixture-block',
      normalized_digest: result.normalized_digest
    }, now.toISOString())

    await makeWritable(fixture.runDirectory)
    await rm(fixture.runDirectory, { recursive: true })
    await expect(readExperimentState(plan, true, now)).rejects.toMatchObject({ code: 'ENOENT' })
  })

})
