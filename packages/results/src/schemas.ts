import * as v from 'valibot'
import { ScoreDocumentSchema } from '@harness-bench/schemas'
import { CREDENTIAL_PATTERN_SCANNER_REVISION } from '@harness-bench/core'

const NonEmptyStringSchema = v.pipe(v.string(), v.nonEmpty())

const IdentifierSchema = v.pipe(
  NonEmptyStringSchema,
  v.regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
)

const NonNegativeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(0))
const NonNegativeNumberSchema = v.pipe(v.number(), v.minValue(0))

const Sha256Schema = v.pipe(
  v.string(),
  v.regex(/^sha256:[a-f0-9]{64}$/)
)

const GitCommitSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/))

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

const SanitizedLocalPathPattern = new RegExp([
  String.raw`(?:^|[\s"'\x60(\[])/(?!/)`,
  String.raw`(?:^|[\s"'\x60(\[])~[\\/]`,
  String.raw`(?:^|[\s"'\x60(\[])(?:[A-Za-z]:[\\/]|\\\\)`,
  String.raw`(?:^|[\s"'\x60(\[])\.\.?[\\/]`
].join('|'))

function excludesLocalPath(value: string): boolean {
  return !SanitizedLocalPathPattern.test(value)
}

const SanitizedMetadataStringSchema = v.pipe(
  NonEmptyStringSchema,
  v.check(excludesLocalPath, 'Sanitized metadata cannot contain a local path')
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

  return maximumDay !== undefined && day >= 1 && day <= maximumDay
}

export const ResultTimestampSchema = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.check(hasValidCalendarDate)
)

const RunIdentitySchema = v.strictObject({
  run_id: IdentifierSchema,
  attempt_id: IdentifierSchema,
  attempt: v.pipe(v.number(), v.integer(), v.minValue(1))
})

const IdentityReferenceSchema = v.strictObject({
  id: IdentifierSchema,
  revision: NonEmptyStringSchema,
  digest: Sha256Schema
})

const RetentionSchema = v.union([
  v.strictObject({
    classification: v.literal('public'),

    expires_at: v.strictObject({
      status: v.literal('not_applicable'),
      reason: NonEmptyStringSchema
    })
  }),
  v.strictObject({
    classification: v.literal('private'),
    default_days: v.literal(90),
    expires_at: ResultTimestampSchema
  })
])

const UnknownSchema = v.strictObject({
  status: v.literal('unknown'),
  reason: NonEmptyStringSchema
})

const KnownNonNegativeIntegerSchema = v.strictObject({
  status: v.literal('known'),
  value: NonNegativeIntegerSchema
})

const KnownOrUnknownIntegerSchema = v.union([
  KnownNonNegativeIntegerSchema,
  UnknownSchema
])

const TimingSchema = v.strictObject({
  total_seconds: NonNegativeIntegerSchema,
  agent_seconds: KnownOrUnknownIntegerSchema,
  verifier_seconds: KnownOrUnknownIntegerSchema
})

const UsageSchema = v.strictObject({
  input_tokens: KnownOrUnknownIntegerSchema,
  output_tokens: KnownOrUnknownIntegerSchema,

  subscription_money: v.strictObject({
    status: v.literal('not_applicable'),
    reason: NonEmptyStringSchema
  }),

  upstream_api_price_estimate: v.union([
    v.strictObject({
      status: v.literal('known'),
      value: NonNegativeNumberSchema,
      currency: v.literal('USD'),

      provenance: v.literal(
        'Harbor 0.22.0 Codex ATIF metrics backed by upstream LiteLLM API-price estimation'
      )
    }),
    UnknownSchema
  ])
})

const TerminationSchema = v.union([
  v.strictObject({ kind: v.literal('success') }),
  v.strictObject({
    kind: v.literal('error'),
    reason: NonEmptyStringSchema
  }),
  v.strictObject({
    kind: v.literal('timeout'),

    stage: v.picklist([
      'setup',
      'agent',
      'quiescence',
      'collection',
      'verification',
      'finalization'
    ]),

    limit_seconds: v.pipe(v.number(), v.integer(), v.minValue(1)),
    elapsed_seconds: v.pipe(v.number(), v.integer(), v.minValue(1)),
    observed_cause: NonEmptyStringSchema
  }),
  v.strictObject({
    kind: v.literal('budget_exhausted'),
    reason: NonEmptyStringSchema
  }),
  v.strictObject({
    kind: v.literal('cancelled'),
    reason: NonEmptyStringSchema
  })
])

const ClassificationSchema = v.picklist([
  'task_success',
  'task_failure',
  'agent_failure',
  'provider_failure',
  'runner_failure',
  'verifier_failure',
  'infrastructure_failure',
  'cancellation'
])

const EvidenceReferenceSchema = v.strictObject({
  path: RelativePathSchema,
  digest: Sha256Schema,
  size: NonNegativeIntegerSchema,
  executable: v.boolean(),

  format: v.picklist([
    'ATIF-v1.7',
    'codex-native-jsonl',
    'collector-metadata-v1',
    'git-binary-patch',
    'harbor-artifact-manifest',
    'harbor-job-result-0.22.0',
    'harbor-reward-json',
    'harbor-trial-log',
    'harbor-trial-result-0.22.0',
    'merged-text',
    'runner-process-control-v1',
    'score-v1',
    'verifier-result-json'
  ]),

  role: v.picklist([
    'artifact_manifest',
    'native_rollout',
    'atif_trajectory',
    'merged_agent_output',
    'harbor_job_result',
    'harbor_trial_log',
    'harbor_trial_result',
    'runner_stdout',
    'runner_stderr',
    'runner_process_control',
    'structured_score',
    'upstream_reward',
    'verifier_result',
    'collected_patch',
    'collector_metadata'
  ])
})

const AvailabilitySchema = v.strictObject({
  native_rollout: v.picklist(['available', 'unavailable']),
  atif_trajectory: v.picklist(['available', 'unavailable']),
  merged_agent_output: v.picklist(['available', 'unavailable'])
})

const NormalizedIdentitiesSchema = v.strictObject({
  benchmark_repo_commit: GitCommitSchema,
  run: RunIdentitySchema,
  stack: IdentityReferenceSchema,
  suite: IdentityReferenceSchema,

  task: v.strictObject({
    id: IdentifierSchema,
    revision: NonEmptyStringSchema,
    base_commit: GitCommitSchema,
    source_digest: Sha256Schema,
    environment_image_digest: Sha256Schema
  }),

  harness: IdentityReferenceSchema,

  experiment: v.strictObject({
    experiment_id: IdentifierSchema,
    experiment_revision: NonEmptyStringSchema,
    plan_digest: Sha256Schema,
    arm_id: IdentifierSchema,
    block_id: IdentifierSchema,
    replicate: v.pipe(v.number(), v.integer(), v.minValue(1))
  }),

  agent: v.strictObject({
    product: v.literal('codex'),
    cli_version: NonEmptyStringSchema,
    requested_model: NonEmptyStringSchema,

    observed_provider_identity: v.union([
      v.strictObject({
        status: v.literal('known'),
        value: NonEmptyStringSchema
      }),
      UnknownSchema
    ]),

    effort: v.picklist(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
    auth_mode: v.literal('chatgpt_subscription')
  }),

  network_policy_digest: Sha256Schema,
  effective_permissions_digest: Sha256Schema,
  mcp_tools_digest: Sha256Schema,

  host: v.strictObject({
    os: v.literal('macos'),
    os_version: NonEmptyStringSchema,
    architecture: v.literal('arm64'),
    apple_silicon_model: NonEmptyStringSchema,
    docker_desktop_version: NonEmptyStringSchema,
    docker_engine_version: NonEmptyStringSchema,
    linuxkit_kernel: NonEmptyStringSchema,
    container_architecture: v.literal('linux/arm64')
  })
})

const RevisionSchema = v.strictObject({
  runner_name: v.literal('harbor'),
  runner_version: v.literal('0.22.0'),
  runner_config_digest: Sha256Schema,
  collector_revision: NonEmptyStringSchema,
  collector_image_digest: Sha256Schema,
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

  scoring_revision: NonEmptyStringSchema
})

const SourceDigestsSchema = v.strictObject({
  initial_record: Sha256Schema,
  completion_record: Sha256Schema,
  raw_manifest: Sha256Schema
})

const ScoreStateSchema = v.union([
  v.strictObject({
    status: v.literal('known'),
    document: ScoreDocumentSchema
  }),
  v.strictObject({
    status: v.literal('unavailable'),
    reason: NonEmptyStringSchema
  })
])

const NormalizedRunRecordV1StructureSchema = v.strictObject({
  document_type: v.literal('normalized_run'),
  schema_version: v.literal(1),
  normalization_revision: v.literal('1'),
  record_type: v.literal('normalized'),
  created_at: ResultTimestampSchema,
  identities: NormalizedIdentitiesSchema,
  revisions: RevisionSchema,
  source_digests: SourceDigestsSchema,

  outcome: v.strictObject({
    classification: ClassificationSchema,
    termination: TerminationSchema,
    valid_grade: v.boolean()
  }),

  score: ScoreStateSchema,
  timings: TimingSchema,
  usage: UsageSchema,
  retention: RetentionSchema,
  evidence_availability: AvailabilitySchema,
  references: v.array(EvidenceReferenceSchema),
  merged_output_semantics: v.literal('irreversibly_merged_stdout_stderr')
})

export const NormalizedRunRecordV1Schema = v.pipe(
  NormalizedRunRecordV1StructureSchema,
  v.check((record) => {
    const qualityOutcome =
      record.outcome.classification === 'task_success' ||
      record.outcome.classification === 'task_failure'

    if (
      record.outcome.valid_grade !== qualityOutcome ||
      (record.score.status === 'known') !== qualityOutcome
    ) {
      return false
    }

    if (record.score.status === 'known') {
      const score = record.score.document

      if (
        score.run_id !== record.identities.run.run_id ||
        score.scoring_revision !== record.revisions.scoring_revision ||
        score.valid_grade !== record.outcome.valid_grade ||
        !record.references.some(
          (reference) =>
            reference.role === 'verifier_result' &&
            reference.digest === score.verifier_result_digest
        )
      ) {
        return false
      }
    }

    const roles = new Set(record.references.map(({ role }) => role))
    const paths = record.references.map(({ path }) => path)

    return (
      new Set(paths).size === paths.length &&
      record.evidence_availability.native_rollout ===
        (roles.has('native_rollout') ? 'available' : 'unavailable') &&
      record.evidence_availability.atif_trajectory ===
        (roles.has('atif_trajectory') ? 'available' : 'unavailable') &&
      record.evidence_availability.merged_agent_output ===
        (roles.has('merged_agent_output') ? 'available' : 'unavailable') &&
      (!qualityOutcome || (
        roles.has('artifact_manifest') &&
        roles.has('native_rollout') &&
        roles.has('atif_trajectory') &&
        roles.has('merged_agent_output') &&
        roles.has('harbor_trial_log') &&
        roles.has('collected_patch') &&
        roles.has('collector_metadata')
      ))
    )
  }, 'Normalized result relationships are inconsistent')
)

const RestrictionFindingSchema = v.strictObject({
  category: v.picklist([
    'exact_credential_bytes',
    'exact_credential_text',
    'private_key',
    'provider_token',
    'jwt',
    'credential_assignment',
    'source_quarantined'
  ]),

  path: RelativePathSchema
})

export const RestrictedRunRecordV1Schema = v.strictObject({
  document_type: v.literal('restricted_run'),
  schema_version: v.literal(1),
  normalization_revision: v.literal('1'),
  record_type: v.literal('restriction'),
  created_at: ResultTimestampSchema,
  identity: RunIdentitySchema,
  source_digests: SourceDigestsSchema,

  restriction: v.strictObject({
    category: v.picklist(['credential_detected', 'raw_quarantined']),
    publication: v.literal('blocked'),
    rotation_or_revocation: v.literal('pending'),
    disposition: v.literal('pending'),
    findings: v.pipe(v.array(RestrictionFindingSchema), v.minLength(1))
  })
})

const SanitizedFacetEvidenceSchema = v.strictObject({
  check_id: SanitizedMetadataStringSchema,
  outcome: v.picklist(['passed', 'failed']),
  evidence_digest: Sha256Schema
})

const SanitizedUnknownSchema = v.strictObject({
  status: v.literal('unknown')
})

const SanitizedKnownOrUnknownIntegerSchema = v.union([
  KnownNonNegativeIntegerSchema,
  SanitizedUnknownSchema
])

const SanitizedTimingSchema = v.strictObject({
  total_seconds: NonNegativeIntegerSchema,
  agent_seconds: SanitizedKnownOrUnknownIntegerSchema,
  verifier_seconds: SanitizedKnownOrUnknownIntegerSchema
})

const SanitizedUsageSchema = v.strictObject({
  input_tokens: SanitizedKnownOrUnknownIntegerSchema,
  output_tokens: SanitizedKnownOrUnknownIntegerSchema,

  subscription_money: v.strictObject({
    status: v.literal('not_applicable')
  }),

  upstream_api_price_estimate: v.union([
    v.strictObject({
      status: v.literal('known'),
      value: NonNegativeNumberSchema,
      currency: v.literal('USD'),

      provenance: v.literal(
        'Harbor 0.22.0 Codex ATIF metrics backed by upstream LiteLLM API-price estimation'
      )
    }),
    SanitizedUnknownSchema
  ])
})

const SanitizedRetentionSchema = v.union([
  v.strictObject({
    classification: v.literal('public'),
    expires_at: v.strictObject({ status: v.literal('not_applicable') })
  }),
  v.strictObject({
    classification: v.literal('private'),
    default_days: v.literal(90),
    expires_at: ResultTimestampSchema
  })
])

const SanitizedIdentityReferenceSchema = v.strictObject({
  id: IdentifierSchema,
  revision: SanitizedMetadataStringSchema,
  digest: Sha256Schema
})

const SanitizedIdentitiesSchema = v.strictObject({
  benchmark_repo_commit: GitCommitSchema,
  run: RunIdentitySchema,
  stack: SanitizedIdentityReferenceSchema,
  suite: SanitizedIdentityReferenceSchema,

  task: v.strictObject({
    id: IdentifierSchema,
    revision: SanitizedMetadataStringSchema,
    base_commit: GitCommitSchema,
    source_digest: Sha256Schema,
    environment_image_digest: Sha256Schema
  }),

  harness: SanitizedIdentityReferenceSchema,

  experiment: v.strictObject({
    experiment_id: IdentifierSchema,
    experiment_revision: SanitizedMetadataStringSchema,
    plan_digest: Sha256Schema,
    arm_id: IdentifierSchema,
    block_id: IdentifierSchema,
    replicate: v.pipe(v.number(), v.integer(), v.minValue(1))
  }),

  agent: v.strictObject({
    product: v.literal('codex'),
    cli_version: SanitizedMetadataStringSchema,
    requested_model: SanitizedMetadataStringSchema,

    observed_provider_identity: v.union([
      v.strictObject({
        status: v.literal('known'),
        value: SanitizedMetadataStringSchema
      }),
      SanitizedUnknownSchema
    ]),

    effort: v.picklist(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
    auth_mode: v.literal('chatgpt_subscription')
  }),

  network_policy_digest: Sha256Schema,
  effective_permissions_digest: Sha256Schema,
  mcp_tools_digest: Sha256Schema,

  host: v.strictObject({
    os: v.literal('macos'),
    os_version: SanitizedMetadataStringSchema,
    architecture: v.literal('arm64'),
    apple_silicon_model: SanitizedMetadataStringSchema,
    docker_desktop_version: SanitizedMetadataStringSchema,
    docker_engine_version: SanitizedMetadataStringSchema,
    linuxkit_kernel: SanitizedMetadataStringSchema,
    container_architecture: v.literal('linux/arm64')
  })
})

const SanitizedRevisionSchema = v.strictObject({
  runner_name: v.literal('harbor'),
  runner_version: v.literal('0.22.0'),
  runner_config_digest: Sha256Schema,
  collector_revision: SanitizedMetadataStringSchema,
  collector_image_digest: Sha256Schema,
  verifier_revision: SanitizedMetadataStringSchema,
  verifier_image_digest: Sha256Schema,

  verifier_network_enforcement_sidecar_digest: v.union([
    v.strictObject({
      status: v.literal('known'),
      value: Sha256Schema
    }),
    v.strictObject({ status: v.literal('not_applicable') })
  ]),

  scoring_revision: SanitizedMetadataStringSchema
})

const SanitizedFacetSchema = v.union([
  v.strictObject({
    status: v.literal('value'),
    value: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    evidence: v.array(SanitizedFacetEvidenceSchema)
  }),
  v.strictObject({
    status: v.picklist(['unknown', 'not_applicable']),
    evidence: v.array(SanitizedFacetEvidenceSchema)
  })
])

const SanitizedScoreSchema = v.union([
  v.strictObject({
    status: v.literal('unavailable')
  }),
  v.strictObject({
    status: v.literal('known'),
    score_id: SanitizedMetadataStringSchema,
    verifier_result_digest: Sha256Schema,
    rubric_revision: SanitizedMetadataStringSchema,

    gates: v.strictObject({
      direct_behavior_pass: v.boolean(),
      regression_pass: v.boolean(),
      verifier_integrity_pass: v.boolean()
    }),

    facets: v.strictObject({
      direct_behavior: SanitizedFacetSchema,
      repository_contracts: SanitizedFacetSchema,
      regression: SanitizedFacetSchema,
      scope_integrity: SanitizedFacetSchema,
      maintainability: SanitizedFacetSchema
    }),

    scope_violation_evidence_digests: v.array(Sha256Schema),

    harbor_reward: v.strictObject({
      status: v.picklist(['retained_upstream', 'not_available']),
      numeric_values: v.record(SanitizedMetadataStringSchema, v.number())
    }),

    composite: v.union([
      v.strictObject({
        status: v.literal('value'),
        value: v.pipe(v.number(), v.minValue(0), v.maxValue(1))
      }),
      v.strictObject({ status: v.literal('unknown') }),
      v.strictObject({ status: v.literal('not_applicable') })
    ])
  })
])

const SanitizedRunExportV1StructureSchema = v.strictObject({
  document_type: v.literal('sanitized_run_export'),
  schema_version: v.literal(1),
  normalization_revision: v.literal('1'),
  record_type: v.literal('sanitized_export'),
  created_at: ResultTimestampSchema,
  source_normalized_digest: Sha256Schema,
  identities: SanitizedIdentitiesSchema,
  revisions: SanitizedRevisionSchema,
  source_digests: SourceDigestsSchema,

  outcome: v.strictObject({
    classification: ClassificationSchema,
    valid_grade: v.boolean()
  }),

  score: SanitizedScoreSchema,
  timings: SanitizedTimingSchema,
  usage: SanitizedUsageSchema,
  retention: SanitizedRetentionSchema,

  evidence: v.array(v.strictObject({
    digest: Sha256Schema,
    size: NonNegativeIntegerSchema,
    executable: v.boolean(),
    format: EvidenceReferenceSchema.entries.format,
    role: EvidenceReferenceSchema.entries.role
  })),

  redaction_report: v.strictObject({
    scanner_revision: v.literal(CREDENTIAL_PATTERN_SCANNER_REVISION),
    credential_findings: v.literal(0),
    content_bytes_included: v.literal(false),
    local_paths_included: v.literal(false),
    publication_authorized: v.literal(false)
  })
})

export const SanitizedRunExportV1Schema = v.pipe(
  SanitizedRunExportV1StructureSchema,
  v.check((record) => {
    const qualityOutcome =
      record.outcome.classification === 'task_success' ||
      record.outcome.classification === 'task_failure'

    return (
      record.outcome.valid_grade === qualityOutcome &&
      (record.score.status === 'known') === qualityOutcome
    )
  }, 'Sanitized result relationships are inconsistent')
)

const RunTombstoneV1StructureSchema = v.strictObject({
  document_type: v.literal('run_tombstone'),
  schema_version: v.literal(1),
  normalization_revision: v.literal('1'),
  record_type: v.literal('tombstone'),
  created_at: ResultTimestampSchema,
  identity: RunIdentitySchema,

  reason: v.picklist([
    'retention-expired',
    'owner-request',
    'credential-detected'
  ]),

  disposition: v.picklist(['delete', 'incident-retain']),

  owner_attestation: v.strictObject({
    confirmed_run_id: NonEmptyStringSchema,

    credential_action: v.picklist([
      'not_applicable',
      'rotated',
      'revoked'
    ])
  }),

  incident_expires_at: v.union([
    v.strictObject({ status: v.literal('not_applicable') }),
    v.strictObject({
      status: v.literal('known'),
      value: ResultTimestampSchema
    })
  ]),

  source_digests: SourceDigestsSchema,
  derived_record_digests: v.array(Sha256Schema),
  retention_classification: v.literal('private'),
  deleted_from_managed_storage: v.boolean(),
  external_copies_status: v.literal('not_managed')
})

export const RunTombstoneV1Schema = v.pipe(
  RunTombstoneV1StructureSchema,
  v.check((record) => {
    const credentialDisposition = record.reason === 'credential-detected'
    const deleted = record.disposition === 'delete'
    const incidentRetained = record.disposition === 'incident-retain'
    const credentialAction = record.owner_attestation.credential_action

    const credentialActionValid = credentialDisposition
      ? ['rotated', 'revoked'].includes(credentialAction)
      : credentialAction === 'not_applicable'

    const incidentExpiryValid = incidentRetained
      ? record.incident_expires_at.status === 'known' &&
        Date.parse(record.incident_expires_at.value) > Date.parse(record.created_at)
      : record.incident_expires_at.status === 'not_applicable'

    return (
      record.owner_attestation.confirmed_run_id === record.identity.run_id &&
      credentialActionValid &&
      (!incidentRetained || credentialDisposition) &&
      record.deleted_from_managed_storage === deleted &&
      incidentExpiryValid
    )
  }, 'Run tombstone relationships are inconsistent')
)

export type NormalizedRunRecordV1 = v.InferOutput<
  typeof NormalizedRunRecordV1Schema
>
export type RestrictedRunRecordV1 = v.InferOutput<
  typeof RestrictedRunRecordV1Schema
>
export type SanitizedRunExportV1 = v.InferOutput<
  typeof SanitizedRunExportV1Schema
>
export type RunTombstoneV1 = v.InferOutput<typeof RunTombstoneV1Schema>
export type EvidenceReferenceV1 = v.InferOutput<typeof EvidenceReferenceSchema>
