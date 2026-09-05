import * as v from "valibot";

export const NonEmptyStringSchema = v.pipe(
  v.string(),
  v.nonEmpty("Value must not be empty"),
);

export const IdentifierSchema = v.pipe(
  NonEmptyStringSchema,
  v.regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    "Identifier must contain lowercase letters, numbers, dots, dashes, or underscores",
  ),
);

export const RevisionSchema = NonEmptyStringSchema;

export const Sha256Schema = v.pipe(
  v.string(),
  v.regex(
    /^sha256:[a-f0-9]{64}$/,
    "Expected a sha256:<64 lowercase hex> digest",
  ),
);

export const GitCommitSchema = v.pipe(
  v.string(),
  v.regex(/^[a-f0-9]{40}$/, "Expected a full 40-character Git commit"),
);

export const TimestampSchema = v.pipe(
  v.string(),
  v.isoTimestamp("Expected an ISO 8601 UTC timestamp"),
);

export const PositiveIntegerSchema = v.pipe(
  v.number(),
  v.integer("Expected an integer"),
  v.minValue(1, "Expected a positive integer"),
);

export const NonNegativeIntegerSchema = v.pipe(
  v.number(),
  v.integer("Expected an integer"),
  v.minValue(0, "Expected a non-negative integer"),
);

export const UnitIntervalSchema = v.pipe(
  v.number(),
  v.minValue(0, "Score must be at least 0"),
  v.maxValue(1, "Score must be at most 1"),
);

export const IdentityReferenceSchema = v.strictObject({
  id: IdentifierSchema,
  revision: RevisionSchema,
  digest: Sha256Schema,
});

export const KnownStringSchema = v.strictObject({
  status: v.literal("known"),
  value: NonEmptyStringSchema,
});

export const UnknownValueSchema = v.strictObject({
  status: v.literal("unknown"),
  reason: NonEmptyStringSchema,
});

export const KnownOrUnknownStringSchema = v.union([
  KnownStringSchema,
  UnknownValueSchema,
]);

export const KnownPositiveIntegerSchema = v.strictObject({
  status: v.literal("known"),
  value: PositiveIntegerSchema,
});

export const KnownNonNegativeIntegerSchema = v.strictObject({
  status: v.literal("known"),
  value: NonNegativeIntegerSchema,
});

export const KnownOrUnknownPositiveIntegerSchema = v.union([
  KnownPositiveIntegerSchema,
  UnknownValueSchema,
]);

export const KnownOrUnknownNonNegativeIntegerSchema = v.union([
  KnownNonNegativeIntegerSchema,
  UnknownValueSchema,
]);

export const KnownTimestampSchema = v.strictObject({
  status: v.literal("known"),
  value: TimestampSchema,
});

export const KnownOrUnknownTimestampSchema = v.union([
  KnownTimestampSchema,
  UnknownValueSchema,
]);

export const NotApplicableSchema = v.strictObject({
  status: v.literal("not_applicable"),
  reason: NonEmptyStringSchema,
});

export const DigestOrNotApplicableSchema = v.union([
  v.strictObject({
    status: v.literal("known"),
    value: Sha256Schema,
  }),
  NotApplicableSchema,
]);

export const EnforcementStatusSchema = v.picklist([
  "enforced",
  "not_started",
  "failed",
]);

export const BudgetSchema = v.strictObject({
  wall_clock_seconds: PositiveIntegerSchema,
  token_or_turn_limit: KnownOrUnknownPositiveIntegerSchema,
  cpu_count: PositiveIntegerSchema,
  memory_megabytes: PositiveIntegerSchema,
});

export type IdentityReference = v.InferOutput<typeof IdentityReferenceSchema>;
