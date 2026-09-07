import { lstat } from 'node:fs/promises'
import { RunError } from './run-errors.ts'
import { subscriptionLockPath } from './execution-lock.ts'

import {
  assignmentIds,
  assignmentOptions,
  assignmentOrigin,
  changedInputCause,
  experimentInputBlocks,
  experimentInputMatches,
  experimentAssignmentSnapshot,
  resolvedExperimentInputs,
  verifyExperimentInputs
} from './experiment-plan.ts'

import {
  appendExperimentProgress,
  experimentHash,
  experimentPlanDigest,
  experimentPlanPath,
  lockExperiment,
  readExperimentHistory,
  readExperimentPlan,
  saveExperimentPlan,
  writeExperimentRecord
} from './experiment-storage.ts'

import { resolveRunPlan, type ResolvedRunPlan } from './run.ts'
import type { ExperimentPlan, InvalidationCause } from './experiment-contracts.ts'
import type { ExperimentRuntime, ExperimentState } from './experiment-state.ts'

async function assertNoSubscriptionLease(): Promise<void> {
  try { await lstat(subscriptionLockPath()) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return

    throw error
  }

  throw new RunError('EXECUTION_FAILED', 'Subscription lease is active or stale; inspect processes before trusted recovery')
}
async function recordRecoveredRuns(plan: ExperimentPlan, state: ExperimentState, at: string): Promise<void> {
  const own = await readExperimentHistory(plan)

  for (const block of state.blocks) {
    for (const run of block.runs) {
      if (run.result === null) continue

      const recorded = own.entries.some(({ event }) => event.type === 'finished' && event.run_id === run.assignment.run_id)

      // A carried completion already has provenance in the frozen parent history.
      const startedHere = own.entries.some(({ event }) => event.type === 'started' && event.run_id === run.assignment.run_id)

      if (recorded || !startedHere) continue

      await appendExperimentProgress(plan, {
        type: 'finished',
        block_id: block.block_id,
        run_id: run.assignment.run_id,
        normalized_digest: run.result.normalized_digest
      }, at)
    }
  }
}
async function invalidateInputBlocks(plan: ExperimentPlan, input: ExperimentPlan['inputs'][number], cause: InvalidationCause, reason: string, at: string): Promise<void> {
  const blocks = await experimentInputBlocks(plan, input)

  for (const blockId of blocks) await appendExperimentProgress(plan, {
    type: 'invalidated',
    block_id: blockId,
    cause,
    reason
  }, at)
}
async function checkExperimentInputs(plan: ExperimentPlan, at: string): Promise<boolean> {
  for (const input of plan.inputs) {
    let cause: InvalidationCause

    try {
      const matches = await experimentInputMatches(input)

      if (matches) continue

      cause = await changedInputCause(plan, input)
    } catch (error) {
      await invalidateInputBlocks(plan, input, 'incomplete', 'Frozen inputs could not be verified; inspect the input error before creating a new revision', at)

      throw error
    }

    await invalidateInputBlocks(plan, input, cause, 'Frozen experiment inputs changed; create a new revision', at)

    return true
  }

  return false
}
export async function executeExperiment(path: string, resume: boolean, runtime: ExperimentRuntime): Promise<ExperimentState> {
  const plan = await readExperimentPlan(path)
  const release = await lockExperiment(plan)

  try {
    await assertNoSubscriptionLease()

    const history = await readExperimentHistory(plan)

    if (!resume && history.entries.length > 0) throw new RunError('DESTINATION_EXISTS', 'Experiment has started; use resume')

    let state = await runtime.readState(plan, true)

    if (state.superseded) throw new RunError('EXECUTION_FAILED', 'Experiment was superseded; use its child plan')

    await recordRecoveredRuns(plan, state, runtime.now().toISOString())

    for (const assignment of plan.assignments) {
      state = await runtime.readState(plan, true)

      const block = state.blocks.find(({ block_id }) => block_id === assignment.block_id)!
      const run = block.runs.find(({ assignment: item }) => item.run_id === assignment.run_id)!

      if (block.status === 'invalidated') {
        const events = await readExperimentHistory(plan)
        const recorded = events.entries.some(({ event }) => event.type === 'invalidated' && event.block_id === block.block_id)

        if (!recorded) await appendExperimentProgress(plan, {
          type: 'invalidated',
          block_id: block.block_id,
          cause: block.cause!,
          reason: block.reason!
        }, runtime.now().toISOString())

        continue
      }

      if (run.status === 'verified') continue

      const changed = await checkExperimentInputs(plan, runtime.now().toISOString())

      if (changed) return runtime.readState(plan, true)

      const origin = await assignmentOrigin(plan, assignment)
      const at = runtime.now().toISOString()
      const snapshot = experimentAssignmentSnapshot(origin, assignment, block.first_started_at ?? at)
      const options = assignmentOptions(origin, assignment)
      let resolved: ResolvedRunPlan

      try {
        resolved = await resolveRunPlan(options, snapshot)
      } catch (error) {
        await appendExperimentProgress(plan, {
          type: 'invalidated',
          block_id: block.block_id,
          cause: 'incomplete',
          reason: 'Assignment resolution failed after input verification; inspect restricted diagnostics before creating a new revision'
        }, runtime.now().toISOString())

        throw error
      }

      const observedInputs = resolvedExperimentInputs(resolved)
      const changedDuringResolution = observedInputs.find((input) => !plan.inputs.some((expected) => expected.kind === input.kind && expected.path === input.path && expected.digest === input.digest))

      if (changedDuringResolution !== undefined) {
        const cause = await changedInputCause(plan, changedDuringResolution)

        await invalidateInputBlocks(plan, changedDuringResolution, cause, 'Inputs changed while resolving the assignment', runtime.now().toISOString())

        return runtime.readState(plan, true)
      }

      await appendExperimentProgress(plan, {
        type: 'started',
        block_id: block.block_id,
        run_id: assignment.run_id
      }, at)

      await writeExperimentRecord(options.experiment, snapshot)

      try {
        await runtime.execute(resolved)
      } catch (error) {
        await appendExperimentProgress(plan, {
          type: 'invalidated',
          block_id: block.block_id,
          cause: 'incomplete',
          reason: 'Execution stopped before a verified completion; inspect restricted run diagnostics'
        }, runtime.now().toISOString())

        throw error
      }

      state = await runtime.readState(plan, true)

      const completedBlock = state.blocks.find(({ block_id }) => block_id === block.block_id)!
      const completedRun = completedBlock.runs.find(({ assignment: item }) => item.run_id === assignment.run_id)!

      if (completedRun.result === null) throw new RunError('INVALID_EVIDENCE', 'Execution did not produce a verified result')

      await appendExperimentProgress(plan, {
        type: 'finished',
        block_id: block.block_id,
        run_id: assignment.run_id,
        normalized_digest: completedRun.result.normalized_digest
      }, runtime.now().toISOString())

      const changedAfterRun = await checkExperimentInputs(plan, runtime.now().toISOString())

      if (changedAfterRun) return runtime.readState(plan, true)

      if (completedBlock.status === 'invalidated') {
        await appendExperimentProgress(plan, {
          type: 'invalidated',
          block_id: block.block_id,
          cause: completedBlock.cause!,
          reason: completedBlock.reason!
        }, runtime.now().toISOString())

        return runtime.readState(plan, true)
      }
    }

    return runtime.readState(plan, true)
  } finally { await release() }
}
export async function invalidateExperimentBlock(path: string, blockId: string, cause: InvalidationCause, reason: string, at = new Date().toISOString()): Promise<void> {
  const plan = await readExperimentPlan(path)
  const release = await lockExperiment(plan)

  try {
    const history = await readExperimentHistory(plan)

    if (history.entries.some(({ event }) => event.type === 'superseded')) throw new RunError('EXECUTION_FAILED', 'Experiment was superseded')

    if (!plan.experiment.blocks.some(({ block_id }) => block_id === blockId)) throw new RunError('INVALID_DOCUMENT', 'Unknown block ID')

    await appendExperimentProgress(plan, {
      type: 'invalidated',
      block_id: blockId,
      cause,
      reason
    }, at)
  } finally { await release() }
}
export async function rerunExperimentBlock(path: string, blockId: string, revision: string, runtime: Pick<ExperimentRuntime, 'readState' | 'now'>): Promise<string> {
  const parent = await readExperimentPlan(path)
  const release = await lockExperiment(parent)

  try {
    await assertNoSubscriptionLease()

    const state = await runtime.readState(parent, true)

    if (state.superseded) throw new RunError('EXECUTION_FAILED', 'Experiment was superseded')

    if (revision === '' || revision === parent.experiment.revision) throw new RunError('INVALID_DOCUMENT', 'A new nonempty experiment revision is required')

    const block = state.blocks.find(({ block_id }) => block_id === blockId)

    if (block === undefined || block.status !== 'invalidated') throw new RunError('INVALID_DOCUMENT', 'Only an invalidated whole block can be rerun')

    const changed = await verifyExperimentInputs(parent)

    if (changed !== undefined) throw new RunError('INPUT_CHANGED', 'Inputs changed; plan a new definition revision')

    await recordRecoveredRuns(parent, state, runtime.now().toISOString())

    const history = await readExperimentHistory(parent)
    const child = structuredClone(parent)

    child.definition.revision = revision
    child.experiment.revision = revision
    child.parent_plan = parent.experiment.plan_digest
    child.parent_progress = history.digest
    child.replaced_block = blockId

    const hash = experimentHash([blockId, revision])
    const newBlockId = `block-${hash.slice(7)}`
    const target = child.experiment.blocks.find(({ block_id }) => block_id === blockId)!

    target.block_id = newBlockId

    for (const entry of child.experiment.execution_order) if (entry.block_id === blockId) entry.block_id = newBlockId

    child.assignments = parent.assignments.map((assignment) => {
      if (assignment.block_id === blockId) return assignmentIds(child.experiment.experiment_id, revision, newBlockId, assignment.arm_id)

      return {
        ...assignment,
        origin_plan: assignment.origin_plan ?? parent.experiment.plan_digest
      }
    })
    child.experiment.plan_digest = experimentPlanDigest(child)

    let childPath: string

    try {
      childPath = await saveExperimentPlan(child)
    } catch (error) {
      if (!(error instanceof RunError) || error.code !== 'DESTINATION_EXISTS') throw error

      // Recover only the exact sealed child left by a failed parent handoff.
      childPath = experimentPlanPath(child.runs_directory, child.experiment.plan_digest)

      try {
        await readExperimentPlan(childPath)
      } catch (cause) {
        throw new RunError('DESTINATION_EXISTS', 'Experiment revision already exists with different content; use a new revision', { cause })
      }
    }

    await appendExperimentProgress(parent, {
      type: 'superseded',
      child_plan: child.experiment.plan_digest
    }, runtime.now().toISOString())

    return childPath
  } finally { await release() }
}
