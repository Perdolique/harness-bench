import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import * as v from 'valibot'
import { CompletionRunRecordSchema } from '@harness-bench/schemas'

import {
  RunError,
  readStableRunFile,
  type ExperimentPlan,
  type ExperimentAssignment,
  type ExperimentProgress,
  type ExperimentState,
  type ExperimentBlockState,
  type ExperimentRunState,
  type VerifiedExperimentRun,
  assignmentOrigin,
  BLOCK_WINDOW_MS,
  experimentHash,
  experimentPlanPath,
  readExperimentHistory,
  readExperimentPlan
} from '@harness-bench/core'

import { normalizeRun } from './normalize.ts'
import { readNormalizedRunRecord, type ReadNormalizedRunRecordResult } from './read.ts'
import type { ReadRegradedRunRecordResult, StoredScoringMigrationRecord } from './regrade-storage.ts'

/**
 * Integrity-verified local read model produced by `readExperimentComparisonSource`.
 * It is not a serialized input contract; consumers must not construct it from
 * untrusted data or persist its resolved local paths.
 */
export interface ExperimentComparisonRunRecord
  extends ReadNormalizedRunRecordResult {
  readonly regrade?: ReadRegradedRunRecordResult;
}

export interface ExperimentComparisonSource {
  readonly records: readonly ExperimentComparisonRunRecord[];
  readonly state: ExperimentState;
  readonly migration?: StoredScoringMigrationRecord;
}

export interface ReadExperimentComparisonSourceRuntime {
  readonly beforeRecordReread?: () => Promise<void>;
  readonly resultLocksHeld?: boolean;
}

export interface ReadExperimentStateRuntime {
  readonly resultLocksHeld?: boolean;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertReplacementAncestry(plan: ExperimentPlan, parent: ExperimentPlan): void {
  const replacedBlockId = plan.replaced_block

  if (replacedBlockId === null) throw new RunError('INVALID_EVIDENCE', 'Child experiment plan does not identify its replaced block')

  const replacedBlock = parent.experiment.blocks.find(({ block_id }) => block_id === replacedBlockId)

  if (replacedBlock === undefined) throw new RunError('INVALID_EVIDENCE', 'Replaced ancestor block is missing')

  const reusedBlock = plan.experiment.blocks.some(({ block_id }) => block_id === replacedBlockId) || plan.assignments.some(({ block_id }) => block_id === replacedBlockId)

  if (reusedBlock) throw new RunError('INVALID_EVIDENCE', 'Child experiment plan reuses its replaced block')

  const replacements = plan.experiment.blocks.filter(({ task_id, replicate }) => task_id === replacedBlock.task_id && replicate === replacedBlock.replicate)
  const replacement = replacements[0]

  if (replacements.length !== 1 || replacement === undefined) {
    throw new RunError('INVALID_EVIDENCE', 'Child experiment plan does not contain one fresh replacement block')
  }

  const parentAssignments = parent.assignments.filter(({ block_id }) => block_id === replacedBlockId)
  const replacementAssignments = plan.assignments.filter(({ block_id }) => block_id === replacement.block_id)
  const parentRunIds = new Set(parent.assignments.map(({ run_id }) => run_id))
  const parentAttemptIds = new Set(parent.assignments.map(({ attempt_id }) => attempt_id))
  const parentArms = parentAssignments.map(({ arm_id }) => arm_id).sort(compareText)
  const replacementArms = replacementAssignments.map(({ arm_id }) => arm_id).sort(compareText)

  const freshAssignments = replacementAssignments.every((assignment) => (
    assignment.origin_plan === null &&
    !parentRunIds.has(assignment.run_id) &&
    !parentAttemptIds.has(assignment.attempt_id)
  ))

  if (
    replacementAssignments.length !== parentAssignments.length ||
    !freshAssignments ||
    !isDeepStrictEqual(replacementArms, parentArms)
  ) {
    throw new RunError('INVALID_EVIDENCE', 'Child experiment replacement assignments are not fresh')
  }
}

export async function experimentHistoryWithParents(plan: ExperimentPlan, visited = new Set<string>()): Promise<readonly ExperimentProgress[]> {
  const digest = plan.experiment.plan_digest

  if (visited.has(digest)) throw new RunError('INVALID_EVIDENCE', 'Experiment ancestry contains a cycle')

  visited.add(digest)

  const own = await readExperimentHistory(plan)

  if (plan.parent_plan === null) return own.entries

  const parentPath = experimentPlanPath(plan.runs_directory, plan.parent_plan)
  const parent = await readExperimentPlan(parentPath)

  if (parent.experiment.experiment_id !== plan.experiment.experiment_id || parent.experiment.revision === plan.experiment.revision) throw new RunError('INVALID_EVIDENCE', 'Experiment ancestry identity differs')

  const parentHistory = await readExperimentHistory(parent)
  const boundary = plan.parent_progress === null ? -1 : parentHistory.entries.findIndex((entry) => experimentHash(entry) === plan.parent_progress)

  if (plan.parent_progress !== null && boundary < 0) throw new RunError('INVALID_EVIDENCE', 'Frozen parent progress is missing')

  const handoff = parentHistory.entries.slice(boundary + 1)

  if (handoff.length !== 1 || handoff[0]?.event.type !== 'superseded' || handoff[0].event.child_plan !== plan.experiment.plan_digest) {
    throw new RunError('INVALID_EVIDENCE', 'Parent-to-child plan handoff is missing or conflicted')
  }

  assertReplacementAncestry(plan, parent)

  const completeParent = await experimentHistoryWithParents(parent, visited)
  const inheritedLength = completeParent.length - parentHistory.entries.length
  const inherited = completeParent.slice(0, inheritedLength + boundary + 1)

  for (const assignment of plan.assignments) {
    if (assignment.origin_plan === null) continue

    const previous = parent.assignments.find(({ run_id }) => run_id === assignment.run_id)
    const expectedOrigin = previous?.origin_plan ?? parent.experiment.plan_digest

    if (previous === undefined || previous.block_id !== assignment.block_id || previous.arm_id !== assignment.arm_id || assignment.origin_plan !== expectedOrigin) throw new RunError('INVALID_EVIDENCE', 'Carried assignment does not belong to the parent plan')
  }

  return [...inherited, ...own.entries]
}
async function inspectRun(
  plan: ExperimentPlan,
  assignment: ExperimentAssignment,
  recover: boolean,
  recordedDigest: string | null,
  resultLocksHeld: boolean
): Promise<VerifiedExperimentRun | null> {
  const directory = resolve(plan.runs_directory, assignment.run_id)

  try {
    const metadata = await lstat(directory)

    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new RunError('INVALID_EVIDENCE', 'Experiment run path is unsafe')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && recordedDigest === null) return null

    throw error
  }

  const completionPath = resolve(directory, 'completion.json')

  try { await lstat(completionPath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && recordedDigest === null) return null

    throw error
  }

  const normalizedRoot = resolve(plan.runs_directory, '.results', assignment.run_id, 'normalized')
  let names: string[] = []

  try { names = await readdir(normalizedRoot) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  if (recordedDigest === null && names.length > 1) {
    throw new RunError('INVALID_EVIDENCE', 'Experiment run has ambiguous normalized results')
  }

  const address = recordedDigest?.slice(7) ?? names.sort(compareText)[0]
  let recordPath: string

  if (address === undefined) {
    if (!recover) return null

    const normalized = await normalizeRun(directory)

    if (normalized.kind !== 'normalized') throw new RunError('INVALID_EVIDENCE', 'Experiment run is restricted; owner action required')

    recordPath = normalized.recordPath
  } else {
    if (!/^[a-f0-9]{64}$/.test(address)) throw new RunError('INVALID_EVIDENCE', 'Invalid normalized result address')

    recordPath = resolve(normalizedRoot, address, 'record.json')
  }

  const verified = await readNormalizedRunRecord(
    recordPath,
    resultLocksHeld ? { resultLockHeld: true } : {}
  )

  const record = verified.record

  if (recordedDigest !== null && verified.digest !== recordedDigest) throw new RunError('INVALID_EVIDENCE', 'Recorded normalized result identity differs')

  const origin = await assignmentOrigin(plan, assignment)
  const block = origin.experiment.blocks.find(({ block_id }) => block_id === assignment.block_id)
  const arm = origin.experiment.arms.find(({ arm_id }) => arm_id === assignment.arm_id)
  const taskReference = origin.experiment.tasks.find(({ task_id }) => task_id === block?.task_id)
  const sameTask = record.identities.task.revision === taskReference?.revision && record.identities.task.source_digest === taskReference.source_digest
  const observedSuiteDigest = experimentHash(record.identities.suite)
  const expectedSuiteDigest = experimentHash(origin.experiment.suite)
  const sameSuite = observedSuiteDigest === expectedSuiteDigest
  const reference = record.identities.experiment
  const sameRun = record.identities.run.run_id === assignment.run_id && record.identities.run.attempt_id === assignment.attempt_id && record.identities.run.attempt === assignment.attempt
  const sameExperiment = reference.plan_digest === origin.experiment.plan_digest && reference.experiment_id === origin.experiment.experiment_id && reference.experiment_revision === origin.experiment.revision
  const sameBlock = reference.block_id === assignment.block_id && reference.arm_id === assignment.arm_id && reference.replicate === block?.replicate && record.identities.task.id === block?.task_id
  const observedStackDigest = experimentHash(record.identities.stack)
  const expectedStackDigest = experimentHash(arm?.stack)
  const sameStack = observedStackDigest === expectedStackDigest
  const observedHarnessDigest = experimentHash(record.identities.harness)
  const expectedHarnessDigest = experimentHash(arm?.harness)
  const sameHarness = observedHarnessDigest === expectedHarnessDigest
  const immutableAssignmentMatches = sameTask && sameSuite && sameRun && sameExperiment && sameBlock && sameStack && sameHarness

  if (!immutableAssignmentMatches) {
    throw new RunError('INVALID_EVIDENCE', 'Run does not match its original immutable assignment')
  }

  const completionBytes = await readStableRunFile(completionPath)
  const completionDigest = `sha256:${createHash('sha256').update(completionBytes).digest('hex')}`

  if (completionDigest !== record.source_digests.completion_record) throw new RunError('INVALID_EVIDENCE', 'Completion changed during experiment inspection')

  const completion = v.parse(CompletionRunRecordSchema, JSON.parse(completionBytes.toString()))
  const provider = record.identities.agent.observed_provider_identity

  return {
    classification: record.outcome.classification,
    valid_grade: record.outcome.valid_grade,
    completed_at: completion.completed_at,
    normalized_digest: verified.digest,
    normalized_path: recordPath,
    observed_provider: provider.status === 'known' ? provider.value : null
  }
}
function isIncompleteAttempt(run: ExperimentRunState): boolean {
  if (run.status === 'interrupted') return true

  if (run.result === null) return false

  const isTaskClassification = ['task_success', 'task_failure'].includes(run.result.classification)

  return !run.result.valid_grade || !isTaskClassification
}
function deriveBlockState(blockId: string, taskId: string, replicate: number, history: readonly ExperimentProgress[], assignedRuns: readonly ExperimentRunState[], now: Date): ExperimentBlockState {
  const starts = assignedRuns.flatMap(({ started_at }) => started_at === null ? [] : [started_at]).sort()
  const first = starts[0] ?? null
  const firstTime = first === null ? null : Date.parse(first)
  const deadline = firstTime === null ? null : new Date(firstTime + BLOCK_WINDOW_MS).toISOString()
  const explicit = history.findLast(({ event }) => event.type === 'invalidated' && event.block_id === blockId)
  const completions = assignedRuns.flatMap(({ result }) => result === null ? [] : [result.completed_at]).sort()
  const allVerified = assignedRuns.every(({ status }) => status === 'verified')
  const lastCompletion = completions.at(-1) ?? null
  const completedAt = allVerified ? lastCompletion : null
  const observedProviders = assignedRuns.flatMap(({ result }) => result?.observed_provider == null ? [] : [result.observed_provider])
  const providers = new Set(observedProviders)
  const hasIncompleteAttempt = assignedRuns.some(isIncompleteAttempt)
  const effectiveCompletion = completedAt ?? now.toISOString()
  const effectiveCompletionTime = Date.parse(effectiveCompletion)
  const deadlineTime = deadline === null ? null : Date.parse(deadline)
  const deadlineExceeded = deadlineTime !== null && effectiveCompletionTime > deadlineTime
  let cause: ExperimentBlockState['cause'] = null
  let reason: string | null = null

  // Recorded owner evidence is authoritative over conditions derived during inspection.
  if (explicit?.event.type === 'invalidated') {
    cause = explicit.event.cause
    reason = explicit.event.reason
  } else if (deadlineExceeded) {
    cause = 'deadline_exceeded'
    reason = 'Block exceeded its 24-hour window'
  } else if (providers.size > 1) {
    cause = 'provider_changed'
    reason = 'Verified provider identities differ within the block'
  } else if (hasIncompleteAttempt) {
    cause = 'incomplete'
    reason = 'Block contains an interrupted or technically failed attempt'
  }

  let status: ExperimentBlockState['status'] = 'planned'

  if (cause !== null) status = 'invalidated'
  else if (allVerified) status = 'completed'
  else if (first !== null) status = 'in_progress'

  return {
    block_id: blockId,
    task_id: taskId,
    replicate,
    first_started_at: first,
    deadline_at: deadline,
    completed_at: completedAt ?? (explicit?.at ?? null),
    status,
    cause,
    reason,
    runs: assignedRuns
  }
}
export function deriveExperimentState(plan: ExperimentPlan, history: readonly ExperimentProgress[], runs: readonly ExperimentRunState[], now: Date, excludedBlocks: readonly ExperimentBlockState[] = []): ExperimentState {
  const blocks = plan.experiment.blocks.map((block) => {
    const assignedRuns = runs.filter(({ assignment }) => assignment.block_id === block.block_id)

    return deriveBlockState(block.block_id, block.task_id, block.replicate, history, assignedRuns, now)
  })

  const superseded = history.some(({ event, plan_digest }) => plan_digest === plan.experiment.plan_digest && event.type === 'superseded')

  return {
    plan,
    blocks,
    excluded_blocks: excludedBlocks,
    superseded
  }
}
async function readRunState(
  plan: ExperimentPlan,
  assignment: ExperimentAssignment,
  history: readonly ExperimentProgress[],
  recover: boolean,
  resultLocksHeld: boolean
): Promise<ExperimentRunState> {
  const starts = history.filter(({ event }) => event.type === 'started' && event.run_id === assignment.run_id)
  const finishes = history.filter(({ event }) => event.type === 'finished' && event.run_id === assignment.run_id)

  if (starts.length > 1 || finishes.length > 1 || finishes.length > starts.length) throw new RunError('INVALID_EVIDENCE', 'Duplicate or unstarted experiment attempt')

  const start = starts[0]
  const finish = finishes[0]

  if (start?.event.type === 'started' && start.event.block_id !== assignment.block_id) throw new RunError('INVALID_EVIDENCE', 'Run start belongs to another block')

  if (finish?.event.type === 'finished' && finish.event.block_id !== assignment.block_id) throw new RunError('INVALID_EVIDENCE', 'Run finish belongs to another block')

  if (start !== undefined && finish !== undefined && finish.sequence <= start.sequence) throw new RunError('INVALID_EVIDENCE', 'Run finish does not follow its recorded start')

  const digest = finish?.event.type === 'finished' ? finish.event.normalized_digest : null

  const result = finish !== undefined || recover
    ? await inspectRun(plan, assignment, recover, digest, resultLocksHeld)
    : null

  if (result !== null && start === undefined) throw new RunError('INVALID_EVIDENCE', 'Run exists without a recorded experiment start')

  if (result !== null && start !== undefined && Date.parse(result.completed_at) < Date.parse(start.at)) throw new RunError('INVALID_EVIDENCE', 'Completion predates the recorded experiment start')

  const status = result !== null ? 'verified' : start === undefined ? 'pending' : 'interrupted'

  return {
    assignment,
    status,
    started_at: start?.at ?? null,
    result
  }
}
async function readExcludedBlocks(
  plan: ExperimentPlan,
  history: readonly ExperimentProgress[],
  recover: boolean,
  now: Date,
  resultLocksHeld: boolean
): Promise<readonly ExperimentBlockState[]> {
  const newestFirst: ExperimentBlockState[] = []
  const attempts = new Set<string>()
  let descendant = plan

  while (descendant.parent_plan !== null) {
    const parentPath = experimentPlanPath(descendant.runs_directory, descendant.parent_plan)
    const parent = await readExperimentPlan(parentPath)
    const replacedBlock = descendant.replaced_block

    if (replacedBlock === null || !parent.experiment.blocks.some(({ block_id }) => block_id === replacedBlock)) {
      throw new RunError('INVALID_EVIDENCE', 'Replaced ancestor block is missing')
    }

    const assignments = parent.assignments.filter(({ block_id }) => block_id === replacedBlock)

    const uniqueAssignments = assignments.filter(({ attempt_id }) => {
      if (attempts.has(attempt_id)) return false

      attempts.add(attempt_id)

      return true
    })

    const runs: ExperimentRunState[] = []

    for (const assignment of uniqueAssignments) {
      runs.push(await readRunState(
        parent,
        assignment,
        history,
        recover,
        resultLocksHeld
      ))
    }

    const parentBlock = parent.experiment.blocks.find(({ block_id }) => block_id === replacedBlock)!

    newestFirst.push(deriveBlockState(replacedBlock, parentBlock.task_id, parentBlock.replicate, history, runs, now))

    descendant = parent
  }

  return newestFirst.reverse()
}
export async function readExperimentState(
  plan: ExperimentPlan,
  recover = false,
  now = new Date(),
  runtime: ReadExperimentStateRuntime = {}
): Promise<ExperimentState> {
  const history = await experimentHistoryWithParents(plan)
  const runs: ExperimentRunState[] = []

  for (const assignment of plan.assignments) {
    runs.push(await readRunState(
      plan,
      assignment,
      history,
      recover,
      runtime.resultLocksHeld === true
    ))
  }

  const excludedBlocks = await readExcludedBlocks(
    plan,
    history,
    recover,
    now,
    runtime.resultLocksHeld === true
  )

  return deriveExperimentState(plan, history, runs, now, excludedBlocks)
}

export async function readExperimentComparisonSource(
  plan: ExperimentPlan,
  now = new Date(),
  runtime: ReadExperimentComparisonSourceRuntime = {}
): Promise<ExperimentComparisonSource> {
  const state = await readExperimentState(
    plan,
    false,
    now,
    runtime.resultLocksHeld === true ? { resultLocksHeld: true } : {}
  )

  const runStates = [
    ...state.blocks.flatMap(({ runs }) => runs),
    ...state.excluded_blocks.flatMap(({ runs }) => runs)
  ]

  const uniqueResults = new Map<string, ExperimentRunState>()

  for (const run of runStates) {
    if (run.result === null) continue

    const attemptId = run.assignment.attempt_id
    const previous = uniqueResults.get(attemptId)

    if (previous !== undefined) throw new RunError('INVALID_EVIDENCE', 'Experiment attempt appears in multiple comparison roles')

    uniqueResults.set(attemptId, run)
  }

  const records: ReadNormalizedRunRecordResult[] = []

  await runtime.beforeRecordReread?.()

  for (const runState of uniqueResults.values()) {
    const result = runState.result!

    const readRuntime = runtime.resultLocksHeld === undefined
      ? {}
      : { resultLockHeld: runtime.resultLocksHeld }

    const source = await readNormalizedRunRecord(
      result.normalized_path,
      readRuntime
    )

    const run = source.record.identities.run
    const experiment = source.record.identities.experiment
    const assignment = runState.assignment
    const block = [...state.blocks, ...state.excluded_blocks].find(({ block_id }) => block_id === assignment.block_id)

    const identityMatches = (
      run.run_id === assignment.run_id &&
      run.attempt_id === assignment.attempt_id &&
      run.attempt === assignment.attempt &&
      run.attempt_id === source.initialRecord.identity.attempt_id &&
      run.run_id === source.initialRecord.identity.run_id &&
      experiment.block_id === assignment.block_id &&
      experiment.arm_id === assignment.arm_id &&
      experiment.replicate === block?.replicate &&
      source.record.identities.task.id === block?.task_id
    )

    const sourceMatches = source.digest === result.normalized_digest && source.recordPath === result.normalized_path

    if (!identityMatches || !sourceMatches) {
      throw new RunError('INVALID_EVIDENCE', 'Experiment comparison source differs from verified state')
    }

    records.push(source)
  }

  records.sort((left, right) => compareText(left.record.identities.run.attempt_id, right.record.identities.run.attempt_id))

  return {
    records,
    state
  }
}
