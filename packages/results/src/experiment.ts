import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
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
import { readNormalizedRunRecord } from './read.ts'

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
async function inspectRun(plan: ExperimentPlan, assignment: ExperimentAssignment, recover: boolean, recordedDigest: string | null): Promise<VerifiedExperimentRun | null> {
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

  let address = recordedDigest?.slice(7) ?? names.sort()[0]
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

  const verified = await readNormalizedRunRecord(recordPath)
  const record = verified.record

  if (recordedDigest !== null && verified.digest !== recordedDigest) throw new RunError('INVALID_EVIDENCE', 'Recorded normalized result identity differs')

  const origin = await assignmentOrigin(plan, assignment)
  const block = origin.experiment.blocks.find(({ block_id }) => block_id === assignment.block_id)
  const arm = origin.experiment.arms.find(({ arm_id }) => arm_id === assignment.arm_id)
  const taskReference = origin.experiment.tasks.find(({ task_id }) => task_id === block?.task_id)
  const sameTask = record.identities.task.revision === taskReference?.revision && record.identities.task.source_digest === taskReference.source_digest
  const sameSuite = experimentHash(record.identities.suite) === experimentHash(origin.experiment.suite)
  const reference = record.identities.experiment

  if (!sameTask || !sameSuite || record.identities.run.run_id !== assignment.run_id || record.identities.run.attempt_id !== assignment.attempt_id || record.identities.run.attempt !== assignment.attempt || reference.plan_digest !== origin.experiment.plan_digest || reference.experiment_id !== origin.experiment.experiment_id || reference.experiment_revision !== origin.experiment.revision || reference.block_id !== assignment.block_id || reference.arm_id !== assignment.arm_id || reference.replicate !== block?.replicate || record.identities.task.id !== block?.task_id || experimentHash(record.identities.stack) !== experimentHash(arm?.stack) || experimentHash(record.identities.harness) !== experimentHash(arm?.harness)) {
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
export function deriveExperimentState(plan: ExperimentPlan, history: readonly ExperimentProgress[], runs: readonly ExperimentRunState[], now: Date): ExperimentState {
  const blocks: ExperimentBlockState[] = plan.experiment.blocks.map((block) => {
    const assignedRuns = runs.filter(({ assignment }) => assignment.block_id === block.block_id)
    const starts = assignedRuns.flatMap(({ started_at }) => started_at === null ? [] : [started_at]).sort()
    const first = starts[0] ?? null
    const deadline = first === null ? null : new Date(Date.parse(first) + BLOCK_WINDOW_MS).toISOString()
    const explicit = history.findLast(({ event }) => event.type === 'invalidated' && event.block_id === block.block_id)
    const completions = assignedRuns.flatMap(({ result }) => result === null ? [] : [result.completed_at]).sort()
    const allVerified = assignedRuns.every(({ status }) => status === 'verified')
    const completedAt = allVerified ? completions.at(-1) ?? null : null
    const providers = new Set(assignedRuns.flatMap(({ result }) => result?.observed_provider == null ? [] : [result.observed_provider]))
    let cause: ExperimentBlockState['cause'] = null
    let reason: string | null = null

    if (explicit?.event.type === 'invalidated') {
      cause = explicit.event.cause
      reason = explicit.event.reason
    } else if (deadline !== null && Date.parse(completedAt ?? now.toISOString()) > Date.parse(deadline)) {
      cause = 'deadline_exceeded'; reason = 'Block exceeded its 24-hour window'
    } else if (providers.size > 1) {
      cause = 'provider_changed'; reason = 'Verified provider identities differ within the block'
    } else if (assignedRuns.some(({ status, result }) => status === 'interrupted' || (result !== null && (!result.valid_grade || !['task_success', 'task_failure'].includes(result.classification))))) {
      cause = 'incomplete'; reason = 'Block contains an interrupted or technically failed attempt'
    }

    const status = cause !== null ? 'invalidated' : allVerified ? 'completed' : first === null ? 'planned' : 'in_progress'

    return {
      block_id: block.block_id,
      first_started_at: first,
      deadline_at: deadline,
      completed_at: completedAt ?? (explicit?.at ?? null),
      status,
      cause,
      reason,
      runs: assignedRuns
    }
  })

  const superseded = history.some(({ event, plan_digest }) => plan_digest === plan.experiment.plan_digest && event.type === 'superseded')

  return {
    plan,
    blocks,
    superseded
  }
}
export async function readExperimentState(plan: ExperimentPlan, recover = false, now = new Date()): Promise<ExperimentState> {
  const history = await experimentHistoryWithParents(plan)
  const runs: ExperimentRunState[] = []

  for (const assignment of plan.assignments) {
    const starts = history.filter(({ event }) => event.type === 'started' && event.run_id === assignment.run_id)
    const finishes = history.filter(({ event }) => event.type === 'finished' && event.run_id === assignment.run_id)

    if (starts.length > 1 || finishes.length > 1 || finishes.length > starts.length) throw new RunError('INVALID_EVIDENCE', 'Duplicate or unstarted experiment attempt')

    const start = starts[0]
    const finish = finishes[0]

    if (start?.event.type === 'started' && start.event.block_id !== assignment.block_id) throw new RunError('INVALID_EVIDENCE', 'Run start belongs to another block')

    const digest = finish?.event.type === 'finished' ? finish.event.normalized_digest : null
    const result = await inspectRun(plan, assignment, recover, digest)

    if (result !== null && start === undefined) throw new RunError('INVALID_EVIDENCE', 'Run exists without a recorded experiment start')

    if (result !== null && start !== undefined && Date.parse(result.completed_at) < Date.parse(start.at)) throw new RunError('INVALID_EVIDENCE', 'Completion predates the recorded experiment start')

    const status = result !== null ? 'verified' : start === undefined ? 'pending' : 'interrupted'

    runs.push({
      assignment,
      status,
      started_at: start?.at ?? null,
      result
    })
  }

  return deriveExperimentState(plan, history, runs, now)
}
