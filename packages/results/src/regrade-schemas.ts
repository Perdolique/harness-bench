import { ScoringMigrationScoreSchema } from '@harness-bench/core'
import * as v from 'valibot'
import { ResultTimestampSchema } from './schemas.ts'

const NonEmptyStringSchema = v.pipe(v.string(), v.nonEmpty())
const NonNegativeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(0))

const IdentifierSchema = v.pipe(
  NonEmptyStringSchema,
  v.regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
)

const Sha256Schema = v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/))

const RelativePathSchema = v.pipe(
  NonEmptyStringSchema,
  v.check(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      path.split('/').every((segment) => !['', '.', '..'].includes(segment)),
    'Expected a safe relative path'
  )
)

const EvaluatorIdentitySchema = v.strictObject({
  verifier_revision: NonEmptyStringSchema,
  verifier_image_digest: Sha256Schema,

  verifier_network_enforcement_sidecar_digest: v.union([
    v.strictObject({
      status: v.literal('known'),
      value: Sha256Schema
    }),
    v.strictObject({
      status: v.literal('not_applicable'),
      reason: NonEmptyStringSchema
    })
  ]),

  scoring_revision: NonEmptyStringSchema,
  rubric_revision: NonEmptyStringSchema
})

const SourceTrialSchema = v.strictObject({
  trial_id: IdentifierSchema,
  task_name: IdentifierSchema,
  task_digest: Sha256Schema,
  config_digest: Sha256Schema,
  lock_digest: Sha256Schema,
  result_digest: Sha256Schema
})

const RegradedSourceSchema = v.strictObject({
  run_id: IdentifierSchema,
  attempt_id: IdentifierSchema,
  normalized_digest: Sha256Schema,
  normalized_record_path: RelativePathSchema,
  raw_manifest_digest: Sha256Schema,
  run_tree_digest: Sha256Schema,
  agent_identity_digest: Sha256Schema,
  usage_digest: Sha256Schema,
  evaluator: EvaluatorIdentitySchema,
  trial: SourceTrialSchema
})

const RegradedTargetSchema = v.strictObject({
  task_id: IdentifierSchema,
  task_document_digest: Sha256Schema,
  task_package_digest: Sha256Schema,
  materialized_task_package_digest: Sha256Schema,
  task_lock_digest: Sha256Schema,
  evaluator: EvaluatorIdentitySchema
})

const RegradeEvidenceSchema = v.strictObject({
  target_document_path: RelativePathSchema,
  target_package_path: RelativePathSchema,
  materialized_target_package_path: RelativePathSchema,
  raw_manifest_path: RelativePathSchema,
  config_path: RelativePathSchema,
  lock_path: RelativePathSchema,
  result_path: RelativePathSchema,
  verifier_result_path: RelativePathSchema,
  raw_manifest_digest: Sha256Schema,
  config_digest: Sha256Schema,
  lock_digest: Sha256Schema,
  result_digest: Sha256Schema,
  verifier_result_digest: Sha256Schema
})

const RegradedRunRecordV1StructureSchema = v.strictObject({
  document_type: v.literal('regraded_run'),
  schema_version: v.literal(1),
  regrade_revision: v.literal('1'),
  record_type: v.literal('regraded'),
  created_at: ResultTimestampSchema,
  migration_definition_digest: Sha256Schema,
  source: RegradedSourceSchema,
  target: RegradedTargetSchema,

  provenance: v.strictObject({
    harbor_version: v.literal('0.22.0'),
    action: v.literal('regrade'),
    source_trial_id: IdentifierSchema,
    source_task_digest: Sha256Schema,
    target_task_digest: Sha256Schema
  }),

  outcome: v.strictObject({
    classification: v.picklist(['task_success', 'task_failure']),
    valid_grade: v.literal(true)
  }),

  score: ScoringMigrationScoreSchema,

  timings: v.strictObject({
    verifier_seconds: NonNegativeIntegerSchema
  }),

  regrade_provider_calls: v.literal(0),
  evidence: RegradeEvidenceSchema
})

export const RegradedRunRecordV1Schema = v.pipe(
  RegradedRunRecordV1StructureSchema,
  v.check((record) => {
    const providerCalls = record.score.harbor_reward.numeric_values.provider_calls

    return (
      record.source.run_id === record.score.run_id &&
      record.target.evaluator.scoring_revision === record.score.scoring_revision &&
      record.target.evaluator.rubric_revision === record.score.rubric_revision &&
      record.provenance.source_trial_id === record.source.trial.trial_id &&
      record.provenance.source_task_digest === record.source.trial.task_digest &&
      record.provenance.target_task_digest === record.target.task_lock_digest &&
      record.evidence.verifier_result_digest === record.score.verifier_result_digest &&
      providerCalls === 0
    )
  }, 'Regraded result relationships are inconsistent')
)

const MigrationTargetSchema = v.strictObject({
  task_id: IdentifierSchema,
  task_document_digest: Sha256Schema,
  task_package_digest: Sha256Schema,
  source_evaluator: EvaluatorIdentitySchema,
  target_evaluator: EvaluatorIdentitySchema
})

const MigrationEntryBaseSchema = v.object({
  run_id: IdentifierSchema,
  attempt_id: IdentifierSchema,
  source_normalized_digest: Sha256Schema
})

const MigrationEntrySchema = v.variant('status', [
  v.strictObject({
    ...MigrationEntryBaseSchema.entries,
    status: v.literal('regraded'),
    regraded_record_digest: Sha256Schema,
    regraded_record_path: RelativePathSchema
  }),
  v.strictObject({
    ...MigrationEntryBaseSchema.entries,
    status: v.literal('retained_technical'),

    classification: v.picklist([
      'agent_failure',
      'provider_failure',
      'runner_failure',
      'verifier_failure',
      'infrastructure_failure',
      'cancellation'
    ])
  })
])

const ScoringMigrationRecordV1StructureSchema = v.strictObject({
  document_type: v.literal('scoring_migration'),
  schema_version: v.literal(1),
  migration_revision: v.literal('1'),
  record_type: v.literal('migration'),
  created_at: ResultTimestampSchema,

  identity: v.strictObject({
    migration_id: IdentifierSchema,
    revision: NonEmptyStringSchema,
    definition_digest: Sha256Schema
  }),

  experiment: v.strictObject({
    experiment_id: IdentifierSchema,
    experiment_revision: NonEmptyStringSchema,
    plan_digest: Sha256Schema
  }),

  targets: v.pipe(v.array(MigrationTargetSchema), v.minLength(1)),
  entries: v.array(MigrationEntrySchema),
  regrade_provider_calls: v.literal(0)
})

export const ScoringMigrationRecordV1Schema = v.pipe(
  ScoringMigrationRecordV1StructureSchema,
  v.check((record) => {
    const taskIds = record.targets.map(({ task_id }) => task_id)
    const runIds = record.entries.map(({ run_id }) => run_id)
    const attemptIds = record.entries.map(({ attempt_id }) => attempt_id)

    return (
      new Set(taskIds).size === taskIds.length &&
      new Set(runIds).size === runIds.length &&
      new Set(attemptIds).size === attemptIds.length
    )
  }, 'Scoring migration relationships are inconsistent')
)

export type RegradeEvaluatorIdentity = v.InferOutput<
  typeof EvaluatorIdentitySchema
>
export type RegradedRunRecordV1 = v.InferOutput<
  typeof RegradedRunRecordV1Schema
>
export type ScoringMigrationRecordV1 = v.InferOutput<
  typeof ScoringMigrationRecordV1Schema
>
export type ScoringMigrationEntryV1 = ScoringMigrationRecordV1['entries'][number]
