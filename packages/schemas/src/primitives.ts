import * as v from 'valibot'

export const NonEmptyStringSchema = v.pipe(
  v.string(),
  v.nonEmpty('Value must not be empty')
)

export const IdentifierSchema = v.pipe(
  NonEmptyStringSchema,
  v.regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    'Identifier must contain lowercase letters, numbers, dots, dashes, or underscores'
  )
)

export const RevisionSchema = NonEmptyStringSchema

export const Sha256Schema = v.pipe(
  v.string(),
  v.regex(
    /^sha256:[a-f0-9]{64}$/,
    'Expected a sha256:<64 lowercase hex> digest'
  )
)

export const GitCommitSchema = v.pipe(
  v.string(),
  v.regex(/^[a-f0-9]{40}$/, 'Expected a full 40-character Git commit')
)

function hasValidCalendarDate(timestamp: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(timestamp)

  if (!match) {
    return false
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)

  const daysPerMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ]

  const maximumDay = daysPerMonth[month - 1]

  return maximumDay !== undefined && day <= maximumDay
}

export const TimestampStructureSchema = v.pipe(
  v.string(),
  v.isoTimestamp('Expected an ISO 8601 timestamp')
)

export const TimestampSchema = v.pipe(
  TimestampStructureSchema,
  v.check(hasValidCalendarDate, 'Expected a real ISO 8601 calendar date')
)

export const PositiveIntegerSchema = v.pipe(
  v.number(),
  v.integer('Expected an integer'),
  v.minValue(1, 'Expected a positive integer')
)

export const NonNegativeIntegerSchema = v.pipe(
  v.number(),
  v.integer('Expected an integer'),
  v.minValue(0, 'Expected a non-negative integer')
)

export const UnitIntervalSchema = v.pipe(
  v.number(),
  v.minValue(0, 'Score must be at least 0'),
  v.maxValue(1, 'Score must be at most 1')
)

export const IdentityReferenceSchema = v.strictObject({
  id: IdentifierSchema,
  revision: RevisionSchema,
  digest: Sha256Schema
})

export const KnownStringSchema = v.strictObject({
  status: v.literal('known'),
  value: NonEmptyStringSchema
})

export const UnknownValueSchema = v.strictObject({
  status: v.literal('unknown'),
  reason: NonEmptyStringSchema
})

export const KnownOrUnknownStringSchema = v.union([
  KnownStringSchema,
  UnknownValueSchema
])

export const KnownNonNegativeIntegerSchema = v.strictObject({
  status: v.literal('known'),
  value: NonNegativeIntegerSchema
})

export const KnownOrUnknownNonNegativeIntegerSchema = v.union([
  KnownNonNegativeIntegerSchema,
  UnknownValueSchema
])

export const KnownTimestampStructureSchema = v.strictObject({
  status: v.literal('known'),
  value: TimestampStructureSchema
})

export const KnownOrUnknownTimestampStructureSchema = v.union([
  KnownTimestampStructureSchema,
  UnknownValueSchema
])

export const NotApplicableSchema = v.strictObject({
  status: v.literal('not_applicable'),
  reason: NonEmptyStringSchema
})

export const DigestOrNotApplicableSchema = v.union([
  v.strictObject({
    status: v.literal('known'),
    value: Sha256Schema
  }),
  NotApplicableSchema
])

export const EnforcementStatusSchema = v.picklist([
  'enforced',
  'not_started',
  'failed'
])

export const EffortSchema = v.picklist([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
])

const KnownTokenOrTurnLimitSchema = v.strictObject({
  status: v.literal('known'),
  unit: v.picklist(['tokens', 'turns']),
  value: PositiveIntegerSchema
})

export const BudgetSchema = v.strictObject({
  wall_clock_seconds: PositiveIntegerSchema,

  token_or_turn_limit: v.union([
    KnownTokenOrTurnLimitSchema,
    UnknownValueSchema
  ]),

  cpu_count: PositiveIntegerSchema,
  cpu_enforcement_status: EnforcementStatusSchema,
  memory_megabytes: PositiveIntegerSchema,
  memory_enforcement_status: EnforcementStatusSchema
})

export type IdentityReference = v.InferOutput<typeof IdentityReferenceSchema>
