import * as v from 'valibot'
import { RunError } from './run-errors.ts'
import { ExperimentDocumentSchema, StackDocumentSchema } from '@harness-bench/schemas'

import {
  BudgetSchema,
  IdentifierSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  TimestampSchema
} from '../../schemas/src/primitives.ts'

const ArmBindingSchema = v.strictObject({
  arm_id: IdentifierSchema,
  treatment: NonEmptyStringSchema,
  stack: NonEmptyStringSchema,
  harness_document: NonEmptyStringSchema,
  harness_bundle: NonEmptyStringSchema
})

const TaskBindingSchema = v.strictObject({
  document: NonEmptyStringSchema,
  source: NonEmptyStringSchema,
  package: NonEmptyStringSchema
})

export const ExperimentDefinitionSchema = v.strictObject({
  document_type: v.literal('experiment_definition'),
  schema_version: v.literal(1),
  experiment_id: IdentifierSchema,
  revision: NonEmptyStringSchema,
  analysis_revision: NonEmptyStringSchema,
  suite: NonEmptyStringSchema,
  arms: v.pipe(v.array(ArmBindingSchema), v.minLength(2)),
  tasks: v.pipe(v.array(TaskBindingSchema), v.minLength(1)),
  repeats: PositiveIntegerSchema,
  ordering_seed: NonNegativeIntegerSchema,
  budget: BudgetSchema,
  requested_concurrency: v.literal(1)
})

const AssignmentSchema = v.strictObject({
  block_id: IdentifierSchema,
  arm_id: IdentifierSchema,
  run_id: IdentifierSchema,
  attempt_id: IdentifierSchema,
  attempt: v.literal(1),
  origin_plan: v.nullable(Sha256Schema)
})

const InputSchema = v.strictObject({
  kind: v.picklist(['suite', 'stack', 'harness_document', 'harness_bundle', 'task_document', 'task_source', 'task_package']),
  path: NonEmptyStringSchema,
  digest: Sha256Schema
})

export const ExperimentPlanSchema = v.strictObject({
  document_type: v.literal('experiment_plan'),
  schema_version: v.literal(1),
  definition: ExperimentDefinitionSchema,
  experiment: ExperimentDocumentSchema,
  runs_directory: NonEmptyStringSchema,
  parent_plan: v.nullable(Sha256Schema),
  parent_progress: v.nullable(Sha256Schema),
  replaced_block: v.nullable(IdentifierSchema),
  assignments: v.array(AssignmentSchema),
  inputs: v.array(InputSchema),
  stacks: v.array(StackDocumentSchema)
})
export const InvalidationCauseSchema = v.picklist([
  'incomplete', 'deadline_exceeded', 'model_changed', 'cli_changed',
  'provider_changed', 'runner_changed', 'harbor_config_changed', 'harness_changed'
])
export const ExperimentProgressSchema = v.strictObject({
  document_type: v.literal('experiment_progress'),
  schema_version: v.literal(1),
  plan_digest: Sha256Schema,
  previous_digest: v.nullable(Sha256Schema),
  sequence: PositiveIntegerSchema,
  at: TimestampSchema,

  event: v.variant('type', [
    v.strictObject({
    type: v.literal('started'),
    block_id: IdentifierSchema,
    run_id: IdentifierSchema
  }),
    v.strictObject({
    type: v.literal('finished'),
    block_id: IdentifierSchema,
    run_id: IdentifierSchema,
    normalized_digest: Sha256Schema
  }),
    v.strictObject({
    type: v.literal('invalidated'),
    block_id: IdentifierSchema,
    cause: InvalidationCauseSchema,
    reason: NonEmptyStringSchema
  }),
    v.strictObject({
    type: v.literal('superseded'),
    child_plan: Sha256Schema
  })
  ])
})
export type ExperimentDefinition = v.InferOutput<typeof ExperimentDefinitionSchema>
export type ExperimentPlan = v.InferOutput<typeof ExperimentPlanSchema>
export type ExperimentAssignment = v.InferOutput<typeof AssignmentSchema>
export type ExperimentProgress = v.InferOutput<typeof ExperimentProgressSchema>
export type ExperimentEvent = ExperimentProgress['event']
export type InvalidationCause = v.InferOutput<typeof InvalidationCauseSchema>

export function parseInvalidationCause(value: unknown): InvalidationCause {
  const parsed = v.safeParse(InvalidationCauseSchema, value)

  if (!parsed.success) throw new RunError('INVALID_DOCUMENT', 'Invalid experiment invalidation cause')

  return parsed.output
}
