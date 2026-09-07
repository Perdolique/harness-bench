import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExperimentDocumentSchema } from '@harness-bench/schemas'
import * as v from 'valibot'

import {
  appendExperimentProgress,
  assignmentIds,
  experimentPlanDigest,
  readExperimentHistory,
  saveExperimentPlan,
  type ExperimentPlan
} from '@harness-bench/core'

import { readExperimentComparisonSource, readExperimentState } from '../src/experiment.ts'
import { normalizeRun } from '../src/normalize.ts'
import { renderExperimentReport } from '../../reporting/src/experiment.ts'
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

async function prepared(recordStart = true) {
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

  if (recordStart) {
    await appendExperimentProgress(plan, {
      type: 'started',
      run_id: 'fixture-a',
      block_id: 'fixture-block'
    }, '2026-09-06T12:00:00.000Z')
  }

  return {
    plan,
    fixture
  }
}
async function publishRerun(parent: ExperimentPlan, revision: string): Promise<ExperimentPlan> {
  const recovered = await readExperimentState(parent, true, now)
  const beforeLinkage = await readExperimentHistory(parent)

  for (const run of recovered.blocks.flatMap(({ runs }) => runs)) {
    if (run.result === null) continue

    const linked = beforeLinkage.entries.some(({ event }) => event.type === 'finished' && event.run_id === run.assignment.run_id)

    if (linked) continue

    await appendExperimentProgress(parent, {
      type: 'finished',
      block_id: run.assignment.block_id,
      run_id: run.assignment.run_id,
      normalized_digest: run.result.normalized_digest
    }, now.toISOString())
  }

  const history = await readExperimentHistory(parent)
  const child = structuredClone(parent)
  const replacedBlock = parent.experiment.blocks[0]!.block_id
  const replacementBlock = `fixture-block-r${revision}`

  child.definition.revision = revision
  child.experiment.revision = revision
  child.parent_plan = parent.experiment.plan_digest
  child.parent_progress = history.digest
  child.replaced_block = replacedBlock
  child.experiment.blocks[0]!.block_id = replacementBlock

  for (const entry of child.experiment.execution_order) entry.block_id = replacementBlock

  child.assignments = parent.assignments.map(({ arm_id }) => assignmentIds(child.experiment.experiment_id, revision, replacementBlock, arm_id))
  child.experiment.plan_digest = experimentPlanDigest(child)

  await saveExperimentPlan(child)

  await appendExperimentProgress(parent, {
    type: 'superseded',
    child_plan: child.experiment.plan_digest
  }, now.toISOString())

  return child
}
async function addCompletedAttempt(plan: ExperimentPlan, classification: 'task_success' | 'task_failure', reason: string): Promise<void> {
  const assignment = plan.assignments[0]!
  const block = plan.experiment.blocks[0]!

  await createResultFixture(root, {
    runId: assignment.run_id,
    private: false,
    classification,

    experiment: {
      experiment_id: plan.experiment.experiment_id,
      experiment_revision: plan.experiment.revision,
      plan_digest: plan.experiment.plan_digest,
      arm_id: assignment.arm_id,
      block_id: assignment.block_id,
      replicate: block.replicate
    }
  })

  await appendExperimentProgress(plan, {
    type: 'started',
    run_id: assignment.run_id,
    block_id: assignment.block_id
  }, '2026-09-06T12:00:00.000Z')

  const recovered = await readExperimentState(plan, true, now)
  const result = recovered.blocks[0]!.runs[0]!.result!

  await appendExperimentProgress(plan, {
    type: 'finished',
    block_id: assignment.block_id,
    run_id: assignment.run_id,
    normalized_digest: result.normalized_digest
  }, '2026-09-06T12:00:30.000Z')

  await appendExperimentProgress(plan, {
    type: 'invalidated',
    block_id: assignment.block_id,
    cause: 'incomplete',
    reason
  }, '2026-09-06T12:01:00.000Z')
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

  it('keeps an unlinked normalized result out of read-only comparison evidence', async () => {
    const { plan } = await prepared()
    const recovered = await readExperimentState(plan, true, now)

    expect(recovered.blocks[0]!.runs[0]!.status).toBe('verified')

    const source = await readExperimentComparisonSource(plan, now)

    expect(source.records).toStrictEqual([])
    expect(source.state.blocks[0]!.runs[0]!.status).toBe('interrupted')
    expect(source.state.blocks[0]!.runs[0]!.result).toBeNull()
  })

  it('rejects a finished event linked to another block', async () => {
    const { plan, fixture } = await prepared()
    const normalized = await normalizeRun(fixture.runDirectory)

    if (normalized.kind !== 'normalized') throw new Error('Expected normalized fixture')

    await appendExperimentProgress(plan, {
      type: 'finished',
      run_id: 'fixture-a',
      block_id: 'different-block',
      normalized_digest: normalized.digest
    }, now.toISOString())

    await expect(readExperimentComparisonSource(plan, now)).rejects.toMatchObject({
      code: 'INVALID_EVIDENCE'
    })
  })

  it('rejects a finished event recorded before its start', async () => {
    const { plan, fixture } = await prepared(false)
    const normalized = await normalizeRun(fixture.runDirectory)

    if (normalized.kind !== 'normalized') throw new Error('Expected normalized fixture')

    await appendExperimentProgress(plan, {
      type: 'finished',
      run_id: 'fixture-a',
      block_id: 'fixture-block',
      normalized_digest: normalized.digest
    }, '2026-09-06T12:00:00.000Z')

    await appendExperimentProgress(plan, {
      type: 'started',
      run_id: 'fixture-a',
      block_id: 'fixture-block'
    }, '2026-09-06T12:01:00.000Z')

    await expect(readExperimentComparisonSource(plan, now)).rejects.toMatchObject({
      code: 'INVALID_EVIDENCE'
    })
  })

  it('rejects ambiguous normalized addresses during recovery', async () => {
    const { plan, fixture } = await prepared()
    const normalized = await normalizeRun(fixture.runDirectory)

    if (normalized.kind !== 'normalized') throw new Error('Expected normalized fixture')

    const normalizedRoot = resolve(plan.runs_directory, '.results/fixture-a/normalized')

    await mkdir(resolve(normalizedRoot, 'f'.repeat(64)), { mode: 0o500 })

    await expect(readExperimentState(plan, true, now)).rejects.toMatchObject({
      code: 'INVALID_EVIDENCE'
    })
  })

  it('returns sealed initial and completion sources for verified comparison runs', async () => {
    const { plan } = await prepared()
    const recovered = await readExperimentState(plan, true, now)
    const result = recovered.blocks[0]!.runs[0]!.result!

    await appendExperimentProgress(plan, {
      type: 'finished',
      run_id: 'fixture-a',
      block_id: 'fixture-block',
      normalized_digest: result.normalized_digest
    }, now.toISOString())

    const source = await readExperimentComparisonSource(plan, now)

    expect(source.records).toHaveLength(1)
    expect(source.records[0]!.initialRecord.identity.run_id).toBe('fixture-a')
    expect(source.records[0]!.completionRecord.identity.run_id).toBe('fixture-a')
    expect(source.records[0]!.digest).toBe(result.normalized_digest)
  })

  it('rereads the sealed normalized source after state inspection', async () => {
    const { plan } = await prepared()
    const recovered = await readExperimentState(plan, true, now)
    const result = recovered.blocks[0]!.runs[0]!.result!

    await appendExperimentProgress(plan, {
      type: 'finished',
      run_id: 'fixture-a',
      block_id: 'fixture-block',
      normalized_digest: result.normalized_digest
    }, now.toISOString())

    await expect(readExperimentComparisonSource(plan, now, {
      beforeRecordReread: async () => {
        await chmod(result.normalized_path, 0o600)
        await writeFile(result.normalized_path, '{}')
        await chmod(result.normalized_path, 0o400)
      }
    })).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
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

  it('retains unique excluded attempts and their original evidence across repeated reruns', async () => {
    const { plan: firstPlan } = await prepared()

    await appendExperimentProgress(firstPlan, {
      type: 'invalidated',
      block_id: firstPlan.experiment.blocks[0]!.block_id,
      cause: 'provider_changed',
      reason: 'First revision provider identity changed'
    }, '2026-09-06T12:01:00.000Z')

    const secondPlan = await publishRerun(firstPlan, '2')

    await addCompletedAttempt(secondPlan, 'task_failure', 'Second revision stopped after a technical failure')

    const currentPlan = await publishRerun(secondPlan, '3')
    const state = await readExperimentState(currentPlan, true, now)
    const excludedAttempts = state.excluded_blocks.flatMap(({ runs }) => runs)

    expect(state.blocks).toHaveLength(1)
    expect(state.blocks[0]?.runs.every(({ status }) => status === 'pending')).toBe(true)

    expect(state.excluded_blocks.map(({ block_id }) => block_id)).toStrictEqual([
      firstPlan.experiment.blocks[0]!.block_id,
      secondPlan.experiment.blocks[0]!.block_id
    ])

    expect(state.excluded_blocks.map(({ cause, reason }) => ({
      cause,
      reason
    }))).toStrictEqual([
      {
        cause: 'provider_changed',
        reason: 'First revision provider identity changed'
      },
      {
        cause: 'incomplete',
        reason: 'Second revision stopped after a technical failure'
      }
    ])

    expect(excludedAttempts).toHaveLength(4)
    expect(new Set(excludedAttempts.map(({ assignment }) => assignment.attempt_id)).size).toBe(4)

    expect(excludedAttempts.map(({ assignment }) => assignment)).toStrictEqual([
      ...firstPlan.assignments,
      ...secondPlan.assignments
    ])

    expect(excludedAttempts[0]?.result?.classification).toBe('task_success')
    expect(excludedAttempts[0]?.result?.normalized_path).toContain(`/.results/${firstPlan.assignments[0]!.run_id}/normalized/`)
    expect(excludedAttempts[2]?.result?.classification).toBe('task_failure')
    expect(excludedAttempts[2]?.result?.normalized_path).toContain(`/.results/${secondPlan.assignments[0]!.run_id}/normalized/`)

    const comparisonSource = await readExperimentComparisonSource(currentPlan, now)
    const sourceRunIds = comparisonSource.records.map(({ record }) => record.identities.run.run_id)

    expect(sourceRunIds).toStrictEqual([
      firstPlan.assignments[0]!.run_id,
      secondPlan.assignments[0]!.run_id
    ].sort())

    const report = renderExperimentReport(state)

    expect(report).toContain(`Excluded predecessor block ${firstPlan.experiment.blocks[0]!.block_id}: invalidated`)
    expect(report).toContain('Excluded: provider_changed; First revision provider identity changed')
    expect(report).toContain(`${firstPlan.assignments[0]!.run_id} | attempt 1: ${firstPlan.assignments[0]!.attempt_id}`)
    expect(report).toContain(excludedAttempts[0]!.result!.normalized_path)
    expect(report).toContain('task_failure, valid grade: true')
    expect(report).toContain('Remaining scheduled invocations: 2')

    const supersededReport = renderExperimentReport({
      ...state,
      superseded: true
    })

    expect(supersededReport).toContain('Remaining scheduled invocations: 0')
  })

  it('rejects replacement assignments that reuse sealed parent identities', async () => {
    const { plan: parent } = await prepared()

    await appendExperimentProgress(parent, {
      type: 'invalidated',
      block_id: parent.experiment.blocks[0]!.block_id,
      cause: 'provider_changed',
      reason: 'Known provider change'
    }, '2026-09-06T12:01:00.000Z')

    const parentHistory = await readExperimentHistory(parent)
    const child = structuredClone(parent)
    const replacedBlock = parent.experiment.blocks[0]!.block_id
    const replacementBlock = 'fresh-block-with-stale-runs'

    child.definition.revision = '2'
    child.experiment.revision = '2'
    child.parent_plan = parent.experiment.plan_digest
    child.parent_progress = parentHistory.digest
    child.replaced_block = replacedBlock
    child.experiment.blocks[0]!.block_id = replacementBlock

    for (const entry of child.experiment.execution_order) entry.block_id = replacementBlock

    for (const assignment of child.assignments) {
      assignment.block_id = replacementBlock
      assignment.origin_plan = null
    }

    child.experiment.plan_digest = experimentPlanDigest(child)

    await saveExperimentPlan(child)

    await appendExperimentProgress(parent, {
      type: 'superseded',
      child_plan: child.experiment.plan_digest
    }, now.toISOString())

    await expect(readExperimentState(child, false, now)).rejects.toMatchObject({
      code: 'INVALID_EVIDENCE'
    })
  })

})
