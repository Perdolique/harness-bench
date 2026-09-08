import * as v from 'valibot'
import { IdentifierSchema, NonEmptyStringSchema, Sha256Schema } from '../../schemas/src/primitives.ts'

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

const UnitIntervalSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(1))

const ScoreEvidenceSchema = v.pipe(
  v.array(v.strictObject({
    check_id: IdentifierSchema,
    outcome: v.picklist(['passed', 'failed']),
    evidence_digest: Sha256Schema
  })),
  v.minLength(1)
)

const FacetEvidenceSchema = ScoreEvidenceSchema.item

const ScoringMigrationFacetSchema = v.union([
  v.strictObject({
    status: v.literal('value'),
    value: UnitIntervalSchema,
    evidence: ScoreEvidenceSchema
  }),
  v.strictObject({
    status: v.literal('unknown'),
    reason: NonEmptyStringSchema,
    evidence: v.array(FacetEvidenceSchema)
  }),
  v.strictObject({
    status: v.literal('not_applicable'),
    reason: NonEmptyStringSchema,
    evidence: v.array(FacetEvidenceSchema)
  })
])

const ScoringMigrationCompositeSchema = v.union([
  v.strictObject({
    status: v.literal('value'),
    value: UnitIntervalSchema
  }),
  v.strictObject({
    status: v.literal('unknown'),
    reason: NonEmptyStringSchema
  }),
  v.strictObject({
    status: v.literal('not_applicable'),
    reason: NonEmptyStringSchema
  })
])

const ScoringMigrationScoreStructureSchema = v.strictObject({
  document_type: v.literal('score'),
  schema_version: v.literal(1),
  score_id: IdentifierSchema,
  run_id: IdentifierSchema,
  verifier_result_digest: Sha256Schema,
  scoring_revision: NonEmptyStringSchema,
  rubric_revision: NonEmptyStringSchema,
  valid_grade: v.boolean(),

  gates: v.strictObject({
    direct_behavior_pass: v.boolean(),
    regression_pass: v.boolean(),
    verifier_integrity_pass: v.boolean()
  }),

  facets: v.strictObject({
    direct_behavior: ScoringMigrationFacetSchema,
    repository_contracts: ScoringMigrationFacetSchema,
    regression: ScoringMigrationFacetSchema,
    scope_integrity: ScoringMigrationFacetSchema,
    maintainability: ScoringMigrationFacetSchema
  }),

  scope_violations: v.array(v.strictObject({
    path: NonEmptyStringSchema,
    reason: NonEmptyStringSchema,
    evidence_digest: Sha256Schema
  })),

  harbor_reward: v.strictObject({
    status: v.picklist(['retained_upstream', 'not_available']),
    numeric_values: v.record(NonEmptyStringSchema, UnitIntervalSchema)
  }),

  composite: ScoringMigrationCompositeSchema
})

export const ScoringMigrationScoreSchema = v.pipe(
  ScoringMigrationScoreStructureSchema,
  v.check((score) => {
    const required = [
      score.facets.direct_behavior,
      score.facets.repository_contracts,
      score.facets.regression,
      score.facets.scope_integrity
    ]

    return (
      (score.harbor_reward.status !== 'not_available' ||
        Object.keys(score.harbor_reward.numeric_values).length === 0) &&
      (!score.valid_grade || score.gates.verifier_integrity_pass) &&
      (score.composite.status !== 'value' ||
        (score.valid_grade && required.every(({ status }) => status === 'value')))
    )
  }, 'Scoring migration score relationships are inconsistent')
)

const ScoringMigrationTargetSchema = v.strictObject({
  task_id: IdentifierSchema,
  document: RelativePathSchema,
  package: RelativePathSchema
})

export const ScoringMigrationDefinitionSchema = v.pipe(
  v.strictObject({
    document_type: v.literal('scoring_migration_definition'),
    schema_version: v.literal(1),
    migration_id: IdentifierSchema,
    revision: NonEmptyStringSchema,
    experiment_id: IdentifierSchema,
    experiment_revision: NonEmptyStringSchema,
    plan_digest: Sha256Schema,
    targets: v.pipe(v.array(ScoringMigrationTargetSchema), v.minLength(1))
  }),
  v.forward(
    v.check(
      ({ targets }) =>
        new Set(targets.map(({ task_id }) => task_id)).size === targets.length,
      'Scoring migration target task IDs must be unique'
    ),
    ['targets']
  )
)

export type ScoringMigrationDefinition = v.InferOutput<
  typeof ScoringMigrationDefinitionSchema
>

export type ScoringMigrationScore = v.InferOutput<
  typeof ScoringMigrationScoreSchema
>
