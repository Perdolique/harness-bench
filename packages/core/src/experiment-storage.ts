import { createHash, randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import * as v from 'valibot'

import {
  ExperimentPlanSchema,
  ExperimentProgressSchema,
  type ExperimentEvent,
  type ExperimentPlan,
  type ExperimentProgress
} from './experiment-contracts.ts'

import { acquireExecutionLock } from './execution-lock.ts'
import { readStableRunFile } from './run.ts'
import { RunError } from './run-errors.ts'
import { scanCredentialBytes } from './secret-scan.ts'

export const EMPTY_PLAN_DIGEST = `sha256:${'0'.repeat(64)}`
export function experimentHash(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, entry: unknown) => {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const sorted = Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)

      return Object.fromEntries(sorted)
    }

    return entry
  })

  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`
}
export function experimentPlanDigest(plan: ExperimentPlan): string {
  const experiment = {
    ...plan.experiment,
    plan_digest: EMPTY_PLAN_DIGEST
  }

  const payload = {
    ...plan,
    experiment
  }

  return experimentHash(payload)
}
export function experimentPlanPath(runsDirectory: string, digest: string): string {
  return resolve(runsDirectory, '.experiments', 'plans', digest.slice(7), 'plan.json')
}
export async function ensureExperimentDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  const metadata = await lstat(path)

  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700 || metadata.uid !== process.getuid?.()) {
    throw new RunError('INVALID_EVIDENCE', 'Experiment storage must be an owner-only directory')
  }
}
export async function prepareExperimentStorage(runsDirectory: string): Promise<string> {
  if (!isAbsolute(runsDirectory)) throw new RunError('INVALID_DOCUMENT', 'runs-dir must be absolute')

  await ensureExperimentDirectory(runsDirectory)

  const root = resolve(runsDirectory, '.experiments')

  await ensureExperimentDirectory(root)

  for (const name of ['plans', 'progress', 'snapshots', '.locks']) {
    const path = resolve(root, name)

    await ensureExperimentDirectory(path)
  }

  return root
}
export async function writeExperimentRecord(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  const findings = scanCredentialBytes(bytes, { path: 'experiment-record.json' })

  if (findings.length > 0) throw new RunError('INVALID_EVIDENCE', 'Experiment metadata contains a credential pattern')

  const temporary = `${path}.${randomUUID()}.tmp`

  await writeFile(temporary, bytes, {
    flag: 'wx',
    mode: 0o600
  })

  try {
    await chmod(temporary, 0o400)
    await link(temporary, path)
  } finally {
    await unlink(temporary)
  }
}
export async function readExperimentRecord(path: string): Promise<unknown> {
  const metadata = await lstat(path)

  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o400) {
    throw new RunError('INVALID_EVIDENCE', 'Experiment record is not sealed')
  }

  const bytes = await readStableRunFile(path)

  if (scanCredentialBytes(bytes, { path: 'experiment-record.json' }).length > 0) {
    throw new RunError('INVALID_EVIDENCE', 'Experiment metadata contains a credential pattern')
  }

  return JSON.parse(bytes.toString()) as unknown
}
export async function readExperimentPlan(path: string): Promise<ExperimentPlan> {
  const document = await readExperimentRecord(path)
  const parsed = v.safeParse(ExperimentPlanSchema, document)

  if (!parsed.success) throw new RunError('INVALID_DOCUMENT', 'Invalid experiment plan')

  const plan = parsed.output

  assertExperimentPlanStructure(plan)

  const digest = experimentPlanDigest(plan)
  const expectedPath = experimentPlanPath(plan.runs_directory, digest)

  if (resolve(path) !== expectedPath || plan.experiment.plan_digest !== digest) {
    throw new RunError('INVALID_EVIDENCE', 'Experiment plan identity or content address differs')
  }

  let parent = dirname(path)

  while (true) {
    const metadata = await lstat(parent)

    if (metadata.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700) {
      throw new RunError('INVALID_EVIDENCE', 'Experiment storage parent is unsafe')
    }

    if (parent === plan.runs_directory) break

    const next = dirname(parent)

    if (next === parent) throw new RunError('INVALID_EVIDENCE', 'Experiment storage root is unreachable')

    parent = next
  }

  return plan
}
export async function saveExperimentPlan(plan: ExperimentPlan): Promise<string> {
  v.parse(ExperimentPlanSchema, plan)
  assertExperimentPlanStructure(plan)

  if (experimentPlanDigest(plan) !== plan.experiment.plan_digest) throw new RunError('INVALID_EVIDENCE', 'Plan digest differs')

  await prepareExperimentStorage(plan.runs_directory)

  const plansRoot = resolve(plan.runs_directory, '.experiments', 'plans')
  const existingNames = await readdir(plansRoot)

  for (const name of existingNames) {
    if (!/^[a-f0-9]{64}$/.test(name)) throw new RunError('INVALID_EVIDENCE', 'Invalid plan storage entry')

    const existingPath = resolve(plansRoot, name, 'plan.json')
    let existing: ExperimentPlan

    try { existing = await readExperimentPlan(existingPath) } catch (error) {
      throw new RunError('INVALID_EVIDENCE', 'Existing plan is incomplete or corrupt; trusted recovery is required', { cause: error })
    }

    if (existing.experiment.experiment_id === plan.experiment.experiment_id && existing.experiment.revision === plan.experiment.revision) {
      throw new RunError('DESTINATION_EXISTS', 'Experiment revision already exists; use a new revision')
    }
  }

  const path = experimentPlanPath(plan.runs_directory, plan.experiment.plan_digest)

  await ensureExperimentDirectory(dirname(path))
  await writeExperimentRecord(path, plan)

  return path
}
export async function lockExperiment(plan: ExperimentPlan): Promise<() => Promise<void>> {
  const root = await prepareExperimentStorage(plan.runs_directory)
  const family = experimentHash(plan.experiment.experiment_id)
  const path = resolve(root, '.locks', family.slice(7))

  return acquireExecutionLock(path)
}
export interface ExperimentHistory {
  readonly entries: readonly ExperimentProgress[];
  readonly digest: string | null;
}
export async function readExperimentHistory(plan: ExperimentPlan): Promise<ExperimentHistory> {
  const directory = resolve(plan.runs_directory, '.experiments', 'progress', plan.experiment.plan_digest.slice(7))
  let names: string[]

  try {
    const metadata = await lstat(directory)

    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) throw new RunError('INVALID_EVIDENCE', 'Unsafe experiment history')

    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {
      entries: [],
      digest: null
    }

    throw error
  }

  names.sort()

  const entries: ExperimentProgress[] = []
  let digest: string | null = null

  for (const [index, name] of names.entries()) {
    const path = resolve(directory, name)
    const raw = await readExperimentRecord(path)
    const parsed = v.safeParse(ExperimentProgressSchema, raw)

    if (!parsed.success) throw new RunError('INVALID_EVIDENCE', 'Invalid experiment progress record')

    const record = parsed.output
    const recordDigest = experimentHash(record)
    const expectedName = `${String(index + 1).padStart(8, '0')}-${recordDigest.slice(7)}.json`

    if (name !== expectedName || record.sequence !== index + 1 || record.previous_digest !== digest || record.plan_digest !== plan.experiment.plan_digest) {
      throw new RunError('INVALID_EVIDENCE', 'Experiment progress chain differs')
    }

    entries.push(record)

    digest = recordDigest
  }

  return {
    entries,
    digest
  }
}

// Callers hold the experiment-family lease across state inspection and append.
export async function appendExperimentProgress(plan: ExperimentPlan, event: ExperimentEvent, at: string): Promise<void> {
  const history = await readExperimentHistory(plan)

  const record: ExperimentProgress = {
    document_type: 'experiment_progress',
    schema_version: 1,
    plan_digest: plan.experiment.plan_digest,
    previous_digest: history.digest,
    sequence: history.entries.length + 1,
    at,
    event
  }

  v.parse(ExperimentProgressSchema, record)

  const digest = experimentHash(record)
  const directory = resolve(plan.runs_directory, '.experiments', 'progress', plan.experiment.plan_digest.slice(7))

  await ensureExperimentDirectory(directory)

  const name = `${String(record.sequence).padStart(8, '0')}-${digest.slice(7)}.json`
  const path = resolve(directory, name)

  await writeExperimentRecord(path, record)
}

function assertExperimentPlanStructure(plan: ExperimentPlan): void {
  const experiment = plan.experiment
  const definition = plan.definition
  const ids = new Set(plan.assignments.map(({ run_id }) => run_id))

  const mappingsMatch = plan.assignments.every((assignment, index) => {
    const entry = experiment.execution_order[index]
    const attemptId = `${assignment.run_id}-attempt-1`

    return entry?.block_id === assignment.block_id && entry.arm_id === assignment.arm_id && assignment.attempt_id === attemptId
  })

  const absoluteRunsDirectory = isAbsolute(plan.runs_directory)
  const assignmentsMatch = plan.assignments.length === experiment.execution_order.length && ids.size === plan.assignments.length && mappingsMatch
  const blocksPlanned = experiment.blocks.every(({ completion_status }) => completion_status === 'planned')
  const identityMatches = definition.experiment_id === experiment.experiment_id && definition.revision === experiment.revision
  const orderingMatches = definition.repeats === experiment.repeats && definition.ordering_seed === experiment.ordering_seed
  const definitionBudget = experimentHash(definition.budget)
  const experimentBudget = experimentHash(experiment.budget)
  const bindingsMatch = definition.arms.length === experiment.arms.length && definition.tasks.length === experiment.tasks.length

  if (!absoluteRunsDirectory || !assignmentsMatch || !blocksPlanned || !identityMatches || !orderingMatches || definitionBudget !== experimentBudget || !bindingsMatch) {
    throw new RunError('INVALID_DOCUMENT', 'Experiment plan assignments or definition are inconsistent')
  }

  const rootPlan = plan.parent_plan === null
  const replacementMissing = plan.replaced_block === null
  const carriedAssignments = plan.assignments.some(({ origin_plan }) => origin_plan !== null)
  const rootHasAncestry = rootPlan && (plan.parent_progress !== null || carriedAssignments)

  if (rootPlan !== replacementMissing || rootHasAncestry) {
    throw new RunError('INVALID_DOCUMENT', 'Experiment plan ancestry is inconsistent')
  }
}
