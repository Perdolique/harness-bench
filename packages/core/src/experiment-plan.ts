import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import * as v from 'valibot'

import {
  ExperimentDocumentSchema,
  HarnessDocumentSchema,
  StackDocumentSchema,
  SuiteDocumentSchema,
  TaskDocumentSchema,
  type ExperimentDocument
} from '@harness-bench/schemas'

import {
  ExperimentDefinitionSchema,
  type ExperimentAssignment,
  type ExperimentDefinition,
  type InvalidationCause,
  type ExperimentPlan
} from './experiment-contracts.ts'

import {
  EMPTY_PLAN_DIGEST,
  experimentHash,
  experimentPlanDigest,
  experimentPlanPath,
  readExperimentPlan
} from './experiment-storage.ts'

import {
  inspectRunTree,
  readStableRunFile,
  resolveRunPlan,
  type ResolvedRunPlan,
  type ResolveRunPlanOptions
} from './run.ts'

import { inspectTaskSource } from './task.ts'
import { validateHarnessBundle } from './harness.ts'
import { RunError } from './run-errors.ts'
import { scanCredentialBytes } from './secret-scan.ts'

const DAY_MS = 24 * 60 * 60 * 1_000

export const BLOCK_WINDOW_MS = DAY_MS

const PREFLIGHT_TIME = '2000-01-01T00:00:00.000Z'

async function documentAt<T extends v.GenericSchema>(path: string, schema: T): Promise<v.InferOutput<T>> {
  const bytes = await readStableRunFile(path)

  if (scanCredentialBytes(bytes, { path: 'experiment-input.json' }).length > 0) throw new RunError('INVALID_DOCUMENT', 'Experiment input contains a credential pattern')

  const raw: unknown = JSON.parse(bytes.toString())
  const parsed = v.safeParse(schema, raw)

  if (!parsed.success) throw new RunError('INVALID_DOCUMENT', 'Experiment input document is invalid')

  return parsed.output
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
export function seededOrder<T>(values: readonly T[], seed: number, scope: string, identity: (value: T) => string): T[] {
  const keyed = values.map((value) => {
    const id = identity(value)
    const key = experimentHash([seed, scope, id])

    return {
      value,
      id,
      key
    }
  })

  keyed.sort((left, right) => compare(left.key, right.key) || compare(left.id, right.id))

  return keyed.map(({ value }) => value)
}
export function assignmentIds(experimentId: string, revision: string, blockId: string, armId: string): ExperimentAssignment {
  const hash = experimentHash([experimentId, revision, blockId, armId])
  const runId = `run-${hash.slice(7)}`

  return {
    block_id: blockId,
    arm_id: armId,
    run_id: runId,
    attempt_id: `${runId}-attempt-1`,
    attempt: 1,
    origin_plan: null
  }
}
function plannedBlock(taskId: string, replicate: number, revision: string): ExperimentDocument['blocks'][number] {
  const key = experimentHash([taskId, replicate, revision])

  return {
    block_id: `block-${key.slice(7)}`,
    task_id: taskId,
    replicate,
    runs: [],

    first_started_at: {
      status: 'unknown',
      reason: 'Block has not started'
    },

    deadline_at: {
      status: 'unknown',
      reason: 'Deadline starts with the first assignment'
    },

    completed_at: {
      status: 'unknown',
      reason: 'Block has not completed'
    },

    completion_status: 'planned',
    contemporaneity: { status: 'pending' }
  }
}
export function experimentAssignmentSnapshot(plan: ExperimentPlan, assignment: ExperimentAssignment, startedAt: string): ExperimentDocument {
  const snapshot = structuredClone(plan.experiment)
  const block = snapshot.blocks.find(({ block_id }) => block_id === assignment.block_id)

  if (block === undefined) throw new RunError('RELATIONSHIP_MISMATCH', 'Assignment block is missing')

  block.runs = plan.assignments.filter(({ block_id }) => block_id === block.block_id).map(({ run_id, arm_id, attempt }) => ({
    run_id,
    arm_id,
    attempt,
    selected: false
  }))
  block.first_started_at = {
    status: 'known',
    value: startedAt
  }

  const deadline = new Date(Date.parse(startedAt) + DAY_MS).toISOString()

  block.deadline_at = {
    status: 'known',
    value: deadline
  }
  block.completion_status = 'in_progress'

  return v.parse(ExperimentDocumentSchema, snapshot)
}
export function assignmentOptions(plan: ExperimentPlan, assignment: ExperimentAssignment): ResolveRunPlanOptions {
  const definition = plan.definition
  const arm = definition.arms.find(({ arm_id }) => arm_id === assignment.arm_id)
  const block = plan.experiment.blocks.find(({ block_id }) => block_id === assignment.block_id)
  const taskIndex = plan.experiment.tasks.findIndex(({ task_id }) => task_id === block?.task_id)
  const task = definition.tasks[taskIndex]

  if (arm === undefined || task === undefined) throw new RunError('RELATIONSHIP_MISMATCH', 'Assignment binding is missing')

  const snapshotPath = resolve(plan.runs_directory, '.experiments', 'snapshots', `${assignment.run_id}.json`)

  return {
    experiment: snapshotPath,
    runId: assignment.run_id,
    runsDirectory: plan.runs_directory,
    suite: definition.suite,
    stackDocuments: definition.arms.map(({ stack }) => stack),
    harnessDocuments: definition.arms.map(({ harness_document }) => harness_document),
    taskDocuments: definition.tasks.map(({ document }) => document),
    harnessBundle: arm.harness_bundle,
    taskSource: task.source,
    taskPackage: task.package
  }
}
export function resolvedExperimentInputs(resolved: ResolvedRunPlan): ExperimentPlan['inputs'] {
  const inputs = resolved.inputs

  const result: ExperimentPlan['inputs'] = [
    {
      kind: 'suite',
      path: inputs.suite.path,
      digest: inputs.suite.digest
    },
    {
      kind: 'harness_bundle',
      path: inputs.harness_bundle.path,
      digest: inputs.harness_bundle.digest
    },
    {
      kind: 'task_source',
      path: inputs.task_source.path,
      digest: inputs.task_source.digest
    },
    {
      kind: 'task_package',
      path: inputs.task_package.path,
      digest: inputs.task_package.digest
    }
  ]

  for (const input of inputs.stacks) result.push({
    kind: 'stack',
    path: input.path,
    digest: input.digest
  })

  for (const input of inputs.harness_documents) result.push({
    kind: 'harness_document',
    path: input.path,
    digest: input.digest
  })

  for (const input of inputs.task_documents) result.push({
    kind: 'task_document',
    path: input.path,
    digest: input.digest
  })

  return result
}
export async function planExperiment(definitionPath: string, runsDirectory: string): Promise<ExperimentPlan> {
  const raw = await documentAt(definitionPath, ExperimentDefinitionSchema)
  const base = dirname(resolve(definitionPath))

  const bindings = raw.tasks.map((task) => ({
    document: resolve(base, task.document),
    source: resolve(base, task.source),
    package: resolve(base, task.package)
  }))

  const taskDocuments = await Promise.all(bindings.map(({ document }) => documentAt(document, TaskDocumentSchema)))

  const tasks = bindings.map((binding, index) => ({
    binding,
    task: taskDocuments[index]!
  }))

  tasks.sort((left, right) => compare(left.task.task_id, right.task.task_id))

  const arms = raw.arms.map((arm) => ({
    arm_id: arm.arm_id,
    treatment: arm.treatment,
    stack: resolve(base, arm.stack),
    harness_document: resolve(base, arm.harness_document),
    harness_bundle: resolve(base, arm.harness_bundle)
  }))

  arms.sort((left, right) => compare(left.arm_id, right.arm_id))

  const definition: ExperimentDefinition = {
    ...raw,
    suite: resolve(base, raw.suite),
    arms,
    tasks: tasks.map(({ binding }) => binding)
  }

  const suite = await documentAt(definition.suite, SuiteDocumentSchema)

  const resolvedArms = await Promise.all(arms.map(async (arm) => {
    const stack = await documentAt(arm.stack, StackDocumentSchema)
    const harness = await documentAt(arm.harness_document, HarnessDocumentSchema)

    return {
      arm_id: arm.arm_id,
      treatment: arm.treatment,

      stack: {
        id: stack.stack_id,
        revision: stack.revision,
        digest: stack.digest
      },

      harness: {
        id: harness.harness_id,
        revision: harness.revision,
        digest: harness.digest
      }
    }
  }))

  const blocks: ExperimentDocument['blocks'] = []

  for (const { task } of tasks) {
    for (let replicate = 1; replicate <= definition.repeats; replicate += 1) blocks.push(plannedBlock(task.task_id, replicate, definition.revision))
  }

  const orderedBlocks = seededOrder(blocks, definition.ordering_seed, 'blocks', ({ task_id, replicate }) => `${task_id}:${replicate}`)
  const order: ExperimentDocument['execution_order'] = []
  const assignments: ExperimentAssignment[] = []

  for (const block of orderedBlocks) {
    const orderedArms = seededOrder(resolvedArms, definition.ordering_seed, `${block.task_id}:${block.replicate}`, ({ arm_id }) => arm_id)

    for (const arm of orderedArms) {
      order.push({
        sequence: order.length + 1,
        block_id: block.block_id,
        task_id: block.task_id,
        replicate: block.replicate,
        arm_id: arm.arm_id
      })

      assignments.push(assignmentIds(definition.experiment_id, definition.revision, block.block_id, arm.arm_id))
    }
  }

  const experiment: ExperimentDocument = {
    document_type: 'experiment',
    schema_version: 1,
    experiment_id: definition.experiment_id,
    revision: definition.revision,
    plan_digest: EMPTY_PLAN_DIGEST,
    analysis_revision: definition.analysis_revision,
    comparison_kind: 'harness_effect',

    suite: {
      id: suite.suite_id,
      revision: suite.revision,
      digest: suite.digest
    },

    arms: resolvedArms,

    tasks: tasks.map(({ task }) => ({
      task_id: task.task_id,
      revision: task.revision,
      source_digest: task.source_digest
    })),

    repeats: definition.repeats,
    ordering_seed: definition.ordering_seed,

    retry_policy: {
      max_attempts_per_arm: 1,
      retryable_classifications: []
    },

    execution_order: order,
    budget: definition.budget,
    requested_concurrency: 1,

    effective_concurrency: {
      status: 'known',
      value: 1
    },

    concurrency_enforcement_status: 'enforced',
    blocks: orderedBlocks
  }

  v.parse(ExperimentDocumentSchema, experiment)

  const plan: ExperimentPlan = {
    document_type: 'experiment_plan',
    schema_version: 1,
    definition,
    experiment,
    runs_directory: runsDirectory,
    parent_plan: null,
    parent_progress: null,
    replaced_block: null,
    assignments,
    inputs: [],
    stacks: []
  }

  const allInputs = new Map<string, ExperimentPlan['inputs'][number]>()

  for (const assignment of assignments) {
    const snapshot = experimentAssignmentSnapshot(plan, assignment, PREFLIGHT_TIME)
    const options = assignmentOptions(plan, assignment)
    const resolved = await resolveRunPlan(options, snapshot)

    if (!plan.stacks.some(({ stack_id }) => stack_id === resolved.stack.stack_id)) plan.stacks.push(resolved.stack)

    for (const input of resolvedExperimentInputs(resolved)) {
      const key = `${input.kind}:${input.path}`
      const previous = allInputs.get(key)

      if (previous !== undefined && previous.digest !== input.digest) throw new RunError('INPUT_CHANGED', 'Experiment inputs changed during planning')

      allInputs.set(key, input)
    }
  }

  plan.inputs = Array.from(allInputs.values()).sort((left, right) => compare(`${left.kind}:${left.path}`, `${right.kind}:${right.path}`))
  plan.experiment.plan_digest = experimentPlanDigest(plan)

  const planBytes = Buffer.from(JSON.stringify(plan))

  if (scanCredentialBytes(planBytes, { path: 'experiment-plan.json' }).length > 0) throw new RunError('INVALID_DOCUMENT', 'Experiment plan contains a credential pattern')

  return plan
}
export async function assignmentOrigin(plan: ExperimentPlan, assignment: ExperimentAssignment): Promise<ExperimentPlan> {
  if (assignment.origin_plan === null) return plan

  const path = experimentPlanPath(plan.runs_directory, assignment.origin_plan)
  const origin = await readExperimentPlan(path)
  const original = origin.assignments.find(({ run_id }) => run_id === assignment.run_id)

  if (original === undefined || original.block_id !== assignment.block_id || original.arm_id !== assignment.arm_id || original.attempt_id !== assignment.attempt_id) throw new RunError('INVALID_EVIDENCE', 'Carried assignment provenance differs')

  return origin
}
export async function verifyExperimentInputs(plan: ExperimentPlan): Promise<ExperimentPlan['inputs'][number] | undefined> {
  for (const input of plan.inputs) {
    let digest: string

    if (input.kind === 'task_package') digest = (await inspectRunTree(input.path)).digest
    else if (input.kind === 'task_source') digest = (await inspectTaskSource(input.path)).digest
    else if (input.kind === 'harness_bundle') digest = (await validateHarnessBundle(input.path)).manifest.digest
    else {
      const bytes = await readStableRunFile(input.path)

      digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    }

    if (digest !== input.digest) return input
  }
}

export async function changedInputCause(plan: ExperimentPlan, input: ExperimentPlan['inputs'][number]): Promise<InvalidationCause> {
  if (input.kind === 'harness_bundle' || input.kind === 'harness_document') return 'harness_changed'

  if (input.kind === 'task_package') return 'harbor_config_changed'

  if (input.kind !== 'stack') return 'incomplete'

  const current = await documentAt(input.path, StackDocumentSchema)
  const old = plan.stacks.find(({ stack_id }) => stack_id === current.stack_id)

  if (old === undefined) return 'runner_changed'

  if (old.agent.requested_model !== current.agent.requested_model) return 'model_changed'

  if (old.agent.cli_version !== current.agent.cli_version) return 'cli_changed'

  if (experimentHash(old.agent.observed_provider_identity) !== experimentHash(current.agent.observed_provider_identity)) return 'provider_changed'

  if (old.runner.version !== current.runner.version) return 'runner_changed'

  if (old.runner.config_digest !== current.runner.config_digest) return 'harbor_config_changed'

  if (experimentHash(old.harness) !== experimentHash(current.harness)) return 'harness_changed'

  return 'runner_changed'
}
