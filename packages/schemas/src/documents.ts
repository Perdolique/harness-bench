import * as v from 'valibot'

import {
  BudgetSchema,
  DigestOrNotApplicableSchema,
  EffortSchema,
  EnforcementStatusSchema,
  GitCommitSchema,
  IdentifierSchema,
  IdentityReferenceSchema,
  KnownOrUnknownNonNegativeIntegerSchema,
  KnownOrUnknownStringSchema,
  KnownOrUnknownTimestampStructureSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  NotApplicableSchema,
  PositiveIntegerSchema,
  RevisionSchema,
  Sha256Schema,
  TimestampSchema,
  TimestampStructureSchema,
  UnitIntervalSchema,
  UnknownValueSchema
} from './primitives.ts'

const SchemaVersionSchema = v.literal(1)

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

function isSafeDeclaredArtifactPath(path: string): boolean {
  const segments = path.split('/')

  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..'
    )
  ) {
    return false
  }

  const reservedSegments = new Set([
    'auth',
    'credentials',
    'logs',
    'solution',
    'tests',
    'trusted-tools',
    'trusted_tools',
    'verifier'
  ])

  return segments.every(
    (segment) => !reservedSegments.has(segment.toLowerCase())
  )
}

const HarnessReferenceSchema = v.strictObject({
  id: IdentifierSchema,
  revision: RevisionSchema,
  digest: Sha256Schema
})

const TelemetryStructureSchema = v.strictObject({
  requested: v.picklist(['off', 'on']),
  effective: v.picklist(['off', 'on']),
  owner_opt_in: v.boolean()
})

const TelemetrySchema = v.pipe(
  TelemetryStructureSchema,
  v.forward(
    v.partialCheck(
      [['effective'], ['owner_opt_in']],
      ({ effective, owner_opt_in }) => effective === 'off' || owner_opt_in,
      'Effective telemetry requires explicit owner opt-in'
    ),
    ['owner_opt_in']
  )
)

const ConcurrencyStructureSchema = v.strictObject({
  requested: v.literal(1),

  effective: v.union([
    v.strictObject({
    status: v.literal('known'),
    value: v.literal(1)
  }),
    UnknownValueSchema
  ]),

  enforcement_status: EnforcementStatusSchema
})

const ConcurrencySchema = v.pipe(
  ConcurrencyStructureSchema,
  v.forward(
    v.partialCheck(
      [['effective'], ['enforcement_status']],
      ({ effective, enforcement_status }) =>
        effective.status === 'known'
          ? enforcement_status === 'enforced'
          : enforcement_status !== 'enforced',
      'Concurrency enforcement must match whether the effective value is known'
    ),
    ['enforcement_status']
  )
)

export const StackDocumentStructureSchema = v.strictObject({
  document_type: v.literal('stack'),
  schema_version: SchemaVersionSchema,
  stack_id: IdentifierSchema,
  revision: RevisionSchema,
  digest: Sha256Schema,

  agent: v.strictObject({
    product: v.literal('codex'),
    cli_version: NonEmptyStringSchema,
    requested_model: NonEmptyStringSchema,
    observed_provider_identity: KnownOrUnknownStringSchema,
    effort: EffortSchema,

    auth: v.strictObject({
      mode: v.literal('chatgpt_subscription'),
      credential_store: v.literal('file')
    })
  }),

  runner: v.strictObject({
    name: v.literal('harbor'),
    version: NonEmptyStringSchema,
    config_digest: Sha256Schema,
    telemetry: TelemetryStructureSchema,
    concurrency: ConcurrencyStructureSchema
  }),

  harness: HarnessReferenceSchema,
  environment: IdentityReferenceSchema,

  network_policy: v.strictObject({
    revision: RevisionSchema,
    digest: Sha256Schema,
    mode: v.literal('public_unrestricted_agent')
  }),

  effective_permissions_digest: Sha256Schema,
  mcp_tools_digest: Sha256Schema,
  budget: BudgetSchema
})

export const StackDocumentSchema = v.strictObject({
  ...StackDocumentStructureSchema.entries,

  runner: v.strictObject({
    ...StackDocumentStructureSchema.entries.runner.entries,
    telemetry: TelemetrySchema,
    concurrency: ConcurrencySchema
  })
})

const HarnessEntrySchema = v.strictObject({
  kind: v.picklist([
    'agents_md',
    'skill',
    'codex_config',
    'mcp_tools',
    'policy'
  ]),

  path: NonEmptyStringSchema,
  digest: Sha256Schema
})

export const HarnessDocumentStructureSchema = v.strictObject({
  document_type: v.literal('harness'),
  schema_version: SchemaVersionSchema,
  harness_id: IdentifierSchema,
  revision: RevisionSchema,
  digest: Sha256Schema,

  entries: v.pipe(
    v.array(HarnessEntrySchema),
    v.minLength(1, 'Harness must declare at least one entry')
  )
})

export const HarnessDocumentSchema = v.pipe(
  HarnessDocumentStructureSchema,
  v.forward(
    v.check(
      ({ entries }) =>
        new Set(entries.map(({ path }) => path)).size === entries.length,
      'Harness entry paths must be unique'
    ),
    ['entries']
  )
)

const RubricObligationSchema = v.strictObject({
  obligation_id: IdentifierSchema,

  facet: v.picklist([
    'direct_behavior',
    'repository_contracts',
    'regression',
    'scope_integrity',
    'maintainability'
  ]),

  expectation: NonEmptyStringSchema,

  evidence_paths: v.pipe(
    v.array(NonEmptyStringSchema),
    v.minLength(1, 'Rubric obligation needs pristine evidence')
  ),

  justification: NonEmptyStringSchema,
  deterministic_check: NonEmptyStringSchema,
  applicability: v.picklist(['required', 'optional']),
  weight: UnitIntervalSchema
})

const PublicRetentionSchema = v.strictObject({
  classification: v.literal('public'),
  expires_at: NotApplicableSchema
})

const PrivateRetentionStructureSchema = v.strictObject({
  classification: v.literal('private'),
  default_days: v.literal(90),
  expires_at: TimestampStructureSchema
})

const RetentionStructureSchema = v.union([
  PublicRetentionSchema,
  PrivateRetentionStructureSchema
])

function hasValidRetentionTimestamp(
  retention: v.InferOutput<typeof RetentionStructureSchema>
): boolean {
  return (
    retention.classification === 'public' ||
    v.safeParse(TimestampSchema, retention.expires_at).success
  )
}

export const TaskDocumentStructureSchema = v.strictObject({
  document_type: v.literal('task'),
  schema_version: SchemaVersionSchema,
  task_id: IdentifierSchema,
  revision: RevisionSchema,
  base_commit: GitCommitSchema,
  source_digest: Sha256Schema,
  environment: IdentityReferenceSchema,

  collector: v.strictObject({
    revision: RevisionSchema,
    image_digest: Sha256Schema
  }),

  verifier: v.strictObject({
    revision: RevisionSchema,
    image_digest: Sha256Schema,
    network_enforcement_sidecar_digest: DigestOrNotApplicableSchema
  }),

  scoring: v.strictObject({
    revision: RevisionSchema,
    rubric_revision: RevisionSchema
  }),

  prompt: v.strictObject({
    path: NonEmptyStringSchema,
    digest: Sha256Schema
  }),

  declared_artifacts: v.pipe(
    v.array(
      v.strictObject({
        path: NonEmptyStringSchema,
        required: v.boolean()
      })
    ),
    v.minLength(1, 'Task must declare its artifact interface')
  ),

  rubric: v.pipe(
    v.array(RubricObligationSchema),
    v.minLength(1, 'Task must declare at least one rubric obligation')
  ),

  scope: v.strictObject({
    allowed: v.array(NonEmptyStringSchema),
    conditional: v.array(NonEmptyStringSchema),

    forbidden: v.pipe(
      v.array(NonEmptyStringSchema),
      v.minLength(1, 'Task must declare at least one forbidden zone')
    )
  }),

  online_reachability: v.strictObject({
    status: v.picklist(['eligible', 'ineligible', 'unknown']),
    reason: NonEmptyStringSchema
  }),

  retention: RetentionStructureSchema
})

export const TaskDocumentSchema = v.pipe(
  TaskDocumentStructureSchema,
  v.forward(
    v.check(
      ({ declared_artifacts }) =>
        declared_artifacts.every(({ path }) =>
          isSafeDeclaredArtifactPath(path)
        ),
      'Declared artifact paths must be relative and disjoint from tests, logs, credentials, verifier inputs, and trusted tools'
    ),
    ['declared_artifacts']
  ),
  v.forward(
    v.check(
      ({ retention }) => hasValidRetentionTimestamp(retention),
      'Private retention expiry must be a real ISO 8601 calendar timestamp'
    ),
    ['retention', 'expires_at']
  ),
  v.forward(
    v.check(
      ({ declared_artifacts }) =>
        new Set(declared_artifacts.map(({ path }) => path)).size ===
        declared_artifacts.length,
      'Declared artifact paths must be unique'
    ),
    ['declared_artifacts']
  ),
  v.forward(
    v.check(
      ({ rubric }) =>
        new Set(rubric.map(({ obligation_id }) => obligation_id)).size ===
        rubric.length,
      'Rubric obligation IDs must be unique'
    ),
    ['rubric']
  ),
  v.forward(
    v.check(
      ({ rubric }) =>
        rubric.some(
          ({ applicability, facet }) =>
            applicability === 'required' && facet === 'direct_behavior'
        ) &&
        rubric.some(
          ({ applicability, facet }) =>
            applicability === 'required' && facet === 'regression'
        ),
      'Task rubric must declare required direct_behavior and regression obligations'
    ),
    ['rubric']
  ),
  v.forward(
    v.check(({ scope }) => {
      const allZones = [
        ...scope.allowed,
        ...scope.conditional,
        ...scope.forbidden
      ]

      return hasUniqueValues(allZones)
    }, 'Allowed, conditional, and forbidden scope zones must be disjoint and unique'),
    ['scope']
  )
)

const TaskReferenceSchema = v.strictObject({
  task_id: IdentifierSchema,
  revision: RevisionSchema,
  source_digest: Sha256Schema
})

export const SuiteDocumentStructureSchema = v.strictObject({
  document_type: v.literal('suite'),
  schema_version: SchemaVersionSchema,
  suite_id: IdentifierSchema,
  revision: RevisionSchema,
  digest: Sha256Schema,

  tasks: v.pipe(
    v.array(TaskReferenceSchema),
    v.minLength(1, 'Suite must contain at least one task')
  )
})

export const SuiteDocumentSchema = v.pipe(
  SuiteDocumentStructureSchema,
  v.forward(
    v.check(
      ({ tasks }) =>
        new Set(tasks.map(({ task_id }) => task_id)).size === tasks.length,
      'Suite task IDs must be unique'
    ),
    ['tasks']
  )
)

const ExperimentArmSchema = v.strictObject({
  arm_id: IdentifierSchema,
  stack: IdentityReferenceSchema,
  harness: HarnessReferenceSchema,
  treatment: NonEmptyStringSchema
})

const ExperimentExecutionEntrySchema = v.strictObject({
  sequence: PositiveIntegerSchema,
  block_id: IdentifierSchema,
  arm_id: IdentifierSchema,
  task_id: IdentifierSchema,
  replicate: PositiveIntegerSchema
})

const ExperimentRetryPolicySchema = v.strictObject({
  max_attempts_per_arm: PositiveIntegerSchema,

  retryable_classifications: v.array(
    v.picklist([
      'agent_failure',
      'provider_failure',
      'runner_failure',
      'verifier_failure',
      'infrastructure_failure'
    ])
  )
})

const ExperimentBlockRunSchema = v.strictObject({
  run_id: IdentifierSchema,
  arm_id: IdentifierSchema,
  attempt: PositiveIntegerSchema,
  selected: v.boolean()
})

const ExperimentBlockSchema = v.strictObject({
  block_id: IdentifierSchema,
  task_id: IdentifierSchema,
  replicate: PositiveIntegerSchema,
  runs: v.array(ExperimentBlockRunSchema),
  first_started_at: KnownOrUnknownTimestampStructureSchema,
  deadline_at: KnownOrUnknownTimestampStructureSchema,
  completed_at: KnownOrUnknownTimestampStructureSchema,

  completion_status: v.picklist([
    'planned',
    'in_progress',
    'completed',
    'invalidated'
  ]),

  contemporaneity: v.union([
    v.strictObject({ status: v.literal('pending') }),
    v.strictObject({ status: v.literal('eligible') }),
    v.strictObject({
      status: v.literal('ineligible'),

      cause: v.picklist([
        'incomplete',
        'deadline_exceeded',
        'model_changed',
        'cli_changed',
        'provider_changed',
        'runner_changed',
        'harbor_config_changed',
        'harness_changed'
      ]),

      reason: NonEmptyStringSchema
    })
  ])
})

export const ExperimentDocumentStructureSchema = v.strictObject({
  document_type: v.literal('experiment'),
  schema_version: SchemaVersionSchema,
  experiment_id: IdentifierSchema,
  revision: RevisionSchema,
  plan_digest: Sha256Schema,
  analysis_revision: RevisionSchema,
  comparison_kind: v.literal('harness_effect'),
  suite: IdentityReferenceSchema,

  arms: v.pipe(
    v.array(ExperimentArmSchema),
    v.minLength(2, 'Experiment needs at least two arms')
  ),

  tasks: v.pipe(
    v.array(TaskReferenceSchema),
    v.minLength(1, 'Experiment needs at least one task')
  ),

  repeats: PositiveIntegerSchema,
  ordering_seed: NonNegativeIntegerSchema,
  retry_policy: ExperimentRetryPolicySchema,
  execution_order: v.array(ExperimentExecutionEntrySchema),
  budget: BudgetSchema,
  requested_concurrency: v.literal(1),

  effective_concurrency: v.union([
    v.strictObject({
    status: v.literal('known'),
    value: v.literal(1)
  }),
    UnknownValueSchema
  ]),

  concurrency_enforcement_status: EnforcementStatusSchema,
  blocks: v.array(ExperimentBlockSchema)
})

function hasValidExperimentBlocks(
  experiment: v.InferOutput<typeof ExperimentDocumentStructureSchema>
): boolean {
  const experimentArmIds = new Set(experiment.arms.map(({ arm_id }) => arm_id))

  const experimentTaskIds = new Set(
    experiment.tasks.map(({ task_id }) => task_id)
  )

  const blockKeys = experiment.blocks.map(
    ({ task_id, replicate }) => `${task_id}:${replicate}`
  )

  const allRunIds = experiment.blocks.flatMap(({ runs }) =>
    runs.map(({ run_id }) => run_id)
  )

  if (
    experiment.blocks.length !== experiment.tasks.length * experiment.repeats ||
    !hasUniqueValues(experiment.blocks.map(({ block_id }) => block_id)) ||
    !hasUniqueValues(blockKeys) ||
    !hasUniqueValues(allRunIds)
  ) {
    return false
  }

  return experiment.blocks.every((block) => {
    if (
      !experimentTaskIds.has(block.task_id) ||
      block.replicate > experiment.repeats ||
      block.runs.some(({ arm_id }) => !experimentArmIds.has(arm_id))
    ) {
      return false
    }

    for (const armId of experimentArmIds) {
      const armRuns = block.runs
        .filter(({ arm_id }) => arm_id === armId)
        .sort((left, right) => left.attempt - right.attempt)

      const attempts = armRuns.map(({ attempt }) => attempt)
      const selectedCount = armRuns.filter(({ selected }) => selected).length

      if (
        armRuns.length > experiment.retry_policy.max_attempts_per_arm ||
        !hasUniqueValues(attempts.map(String)) ||
        attempts.some((attempt, index) => attempt !== index + 1) ||
        selectedCount > 1
      ) {
        return false
      }

      if (
        block.completion_status === 'completed' &&
        (armRuns.length === 0 || selectedCount !== 1)
      ) {
        return false
      }
    }

    const firstStartedKnown = block.first_started_at.status === 'known'
    const deadlineKnown = block.deadline_at.status === 'known'
    const completedKnown = block.completed_at.status === 'known'

    if (firstStartedKnown !== deadlineKnown) {
      return false
    }

    const timestamps = [
      block.first_started_at,
      block.deadline_at,
      block.completed_at
    ]

    if (
      timestamps.some(
        (timestamp) =>
          timestamp.status === 'known' &&
          !v.safeParse(TimestampSchema, timestamp.value).success
      )
    ) {
      return false
    }

    let completedAfterDeadline = false

    if (
      block.first_started_at.status === 'known' &&
      block.deadline_at.status === 'known'
    ) {
      const firstStarted = Date.parse(block.first_started_at.value)
      const deadline = Date.parse(block.deadline_at.value)

      if (deadline - firstStarted !== 24 * 60 * 60 * 1_000) {
        return false
      }

      if (block.completed_at.status === 'known') {
        const completed = Date.parse(block.completed_at.value)

        if (completed < firstStarted) {
          return false
        }

        completedAfterDeadline = completed > deadline
      }
    }

    switch (block.completion_status) {
      case 'planned':
        return (
          block.runs.length === 0 &&
          !firstStartedKnown &&
          !deadlineKnown &&
          !completedKnown &&
          block.contemporaneity.status === 'pending'
        )
      case 'in_progress':
        return (
          block.runs.length > 0 &&
          firstStartedKnown &&
          deadlineKnown &&
          !completedKnown &&
          block.contemporaneity.status === 'pending' &&
          !block.runs.some(({ selected }) => selected)
        )
      case 'completed':
        return (
          firstStartedKnown &&
          deadlineKnown &&
          completedKnown &&
          !completedAfterDeadline &&
          block.contemporaneity.status === 'eligible'
        )
      case 'invalidated':
        return (
          firstStartedKnown &&
          deadlineKnown &&
          completedKnown &&
          block.contemporaneity.status === 'ineligible' &&
          (completedAfterDeadline
            ? block.contemporaneity.cause === 'deadline_exceeded'
            : block.contemporaneity.cause !== 'deadline_exceeded')
        )
    }
  })
}

function hasValidExecutionOrder(
  experiment: v.InferOutput<typeof ExperimentDocumentStructureSchema>
): boolean {
  const blocksById = new Map(
    experiment.blocks.map((block) => [block.block_id, block])
  )

  const armIds = new Set(experiment.arms.map(({ arm_id }) => arm_id))
  const expectedLength = experiment.blocks.length * experiment.arms.length
  const entries = experiment.execution_order

  if (
    entries.length !== expectedLength ||
    !entries.every(({ sequence }, index) => sequence === index + 1)
  ) {
    return false
  }

  const executionKeys = new Set<string>()

  for (const entry of entries) {
    const block = blocksById.get(entry.block_id)
    const executionKey = `${entry.block_id}:${entry.arm_id}`

    if (
      !block ||
      !armIds.has(entry.arm_id) ||
      entry.task_id !== block.task_id ||
      entry.replicate !== block.replicate ||
      executionKeys.has(executionKey)
    ) {
      return false
    }

    executionKeys.add(executionKey)
  }

  return true
}

export const ExperimentDocumentSchema = v.pipe(
  ExperimentDocumentStructureSchema,
  v.forward(
    v.check(
      ({ arms }) => hasUniqueValues(arms.map(({ arm_id }) => arm_id)),
      'Experiment arm IDs must be unique'
    ),
    ['arms']
  ),
  v.forward(
    v.check(
      ({ tasks }) => hasUniqueValues(tasks.map(({ task_id }) => task_id)),
      'Experiment task IDs must be unique'
    ),
    ['tasks']
  ),
  v.forward(
    v.check(({ retry_policy }) => {
      const classifications = retry_policy.retryable_classifications

      return (
        hasUniqueValues(classifications) &&
        (retry_policy.max_attempts_per_arm === 1
          ? classifications.length === 0
          : classifications.length > 0)
      )
    }, 'Retry policy must declare unique retryable classifications exactly when multiple attempts are allowed'),
    ['retry_policy']
  ),
  v.forward(
    v.partialCheck(
      [['effective_concurrency'], ['concurrency_enforcement_status']],
      ({ effective_concurrency, concurrency_enforcement_status }) =>
        effective_concurrency.status === 'known'
          ? concurrency_enforcement_status === 'enforced'
          : concurrency_enforcement_status !== 'enforced',
      'Concurrency enforcement must match whether the effective value is known'
    ),
    ['concurrency_enforcement_status']
  ),
  v.forward(
    v.check(hasValidExperimentBlocks, 'Experiment block state is inconsistent'),
    ['blocks']
  ),
  v.forward(
    v.check(
      hasValidExecutionOrder,
      'Execution order must cover every block and arm exactly once'
    ),
    ['execution_order']
  )
)

const RunIdentitySchema = v.strictObject({
  run_id: IdentifierSchema,
  attempt_id: IdentifierSchema,
  attempt: PositiveIntegerSchema
})

const RunExperimentReferenceSchema = v.strictObject({
  experiment_id: IdentifierSchema,
  experiment_revision: RevisionSchema,
  plan_digest: Sha256Schema,
  arm_id: IdentifierSchema,
  block_id: IdentifierSchema,
  replicate: PositiveIntegerSchema
})

export const InitialRunRecordStructureSchema = v.strictObject({
  document_type: v.literal('run'),
  schema_version: SchemaVersionSchema,
  record_type: v.literal('initial'),
  identity: RunIdentitySchema,
  created_at: TimestampStructureSchema,
  benchmark_repo_commit: GitCommitSchema,
  stack: IdentityReferenceSchema,
  suite: IdentityReferenceSchema,

  task: v.strictObject({
    id: IdentifierSchema,
    revision: RevisionSchema,
    base_commit: GitCommitSchema,
    source_digest: Sha256Schema,
    environment_image_digest: Sha256Schema
  }),

  collector: v.strictObject({
    revision: RevisionSchema,
    image_digest: Sha256Schema
  }),

  verifier: v.strictObject({
    revision: RevisionSchema,
    image_digest: Sha256Schema,
    network_enforcement_sidecar_digest: DigestOrNotApplicableSchema
  }),

  scoring_revision: RevisionSchema,

  runner: v.strictObject({
    name: v.literal('harbor'),
    version: NonEmptyStringSchema,
    config_digest: Sha256Schema,
    telemetry: v.picklist(['off', 'on']),
    requested_concurrency: v.literal(1),

    effective_concurrency: v.union([
      v.strictObject({
      status: v.literal('known'),
      value: v.literal(1)
    }),
      UnknownValueSchema
    ]),

    concurrency_enforcement_status: EnforcementStatusSchema
  }),

  agent: v.strictObject({
    product: v.literal('codex'),
    cli_version: NonEmptyStringSchema,
    requested_model: NonEmptyStringSchema,
    observed_provider_identity: KnownOrUnknownStringSchema,
    effort: EffortSchema,
    auth_mode: v.literal('chatgpt_subscription')
  }),

  harness: HarnessReferenceSchema,
  network_policy_digest: Sha256Schema,
  effective_permissions_digest: Sha256Schema,
  mcp_tools_digest: Sha256Schema,
  budget: BudgetSchema,
  experiment: RunExperimentReferenceSchema,
  retention: RetentionStructureSchema,

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

export const InitialRunRecordSchema = v.pipe(
  InitialRunRecordStructureSchema,
  v.forward(
    v.check(
      ({ created_at, retention }) =>
        v.safeParse(TimestampSchema, created_at).success &&
        hasValidRetentionTimestamp(retention),
      'Run timestamps must use real ISO 8601 calendar dates'
    ),
    ['created_at']
  ),
  v.forward(
    v.partialCheck(
      [
        ['runner', 'effective_concurrency'],
        ['runner', 'concurrency_enforcement_status']
      ],
      ({ runner }) =>
        runner.effective_concurrency.status === 'known'
          ? runner.concurrency_enforcement_status === 'enforced'
          : runner.concurrency_enforcement_status !== 'enforced',
      'Concurrency enforcement must match whether the effective value is known'
    ),
    ['runner', 'concurrency_enforcement_status']
  )
)

const EnforcementEvidenceSchema = v.strictObject({
  status: v.picklist(['passed', 'failed', 'missing']),

  evidence_digest: v.union([
    v.strictObject({
    status: v.literal('known'),
    value: Sha256Schema
  }),
    UnknownValueSchema
  ])
})

const TimeoutTerminationSchema = v.strictObject({
  kind: v.literal('timeout'),

  stage: v.picklist([
    'setup',
    'agent',
    'quiescence',
    'collection',
    'verification',
    'finalization'
  ]),

  limit_seconds: PositiveIntegerSchema,
  elapsed_seconds: PositiveIntegerSchema,
  observed_cause: NonEmptyStringSchema
})

const TerminationSchema = v.union([
  v.strictObject({ kind: v.literal('success') }),
  v.strictObject({
    kind: v.literal('error'),
    reason: NonEmptyStringSchema
  }),
  TimeoutTerminationSchema,
  v.strictObject({
    kind: v.literal('budget_exhausted'),
    reason: NonEmptyStringSchema
  }),
  v.strictObject({
    kind: v.literal('cancelled'),
    reason: NonEmptyStringSchema
  })
])

export const CompletionRunRecordStructureSchema = v.strictObject({
  document_type: v.literal('run'),
  schema_version: SchemaVersionSchema,
  record_type: v.literal('completion'),
  identity: RunIdentitySchema,
  completed_at: TimestampStructureSchema,
  initial_manifest_digest: Sha256Schema,

  classification: v.picklist([
    'task_success',
    'task_failure',
    'agent_failure',
    'provider_failure',
    'runner_failure',
    'verifier_failure',
    'infrastructure_failure',
    'cancellation'
  ]),

  termination: TerminationSchema,

  collection: v.strictObject({
    collector_revision: RevisionSchema,
    collector_image_digest: Sha256Schema,
    quiescence: EnforcementEvidenceSchema,
    collection: EnforcementEvidenceSchema,
    exact_manifest: EnforcementEvidenceSchema,
    hashes: EnforcementEvidenceSchema
  }),

  verifier: v.strictObject({
    verifier_revision: RevisionSchema,
    verifier_image_digest: Sha256Schema,
    network_enforcement_sidecar_digest: DigestOrNotApplicableSchema,
    separate_environment: EnforcementEvidenceSchema,
    network_disabled: EnforcementEvidenceSchema,
    credential_free: EnforcementEvidenceSchema,

    result_digest: v.union([
      v.strictObject({
      status: v.literal('known'),
      value: Sha256Schema
    }),
      UnknownValueSchema
    ])
  }),

  valid_grade: v.boolean(),

  score_id: v.union([
    v.strictObject({
    status: v.literal('known'),
    value: IdentifierSchema
  }),
    NotApplicableSchema,
    UnknownValueSchema
  ]),

  timings: v.strictObject({
    total_seconds: NonNegativeIntegerSchema,
    agent_seconds: KnownOrUnknownNonNegativeIntegerSchema,
    verifier_seconds: KnownOrUnknownNonNegativeIntegerSchema
  }),

  usage: v.strictObject({
    input_tokens: KnownOrUnknownNonNegativeIntegerSchema,
    output_tokens: KnownOrUnknownNonNegativeIntegerSchema,
    subscription_money: v.union([UnknownValueSchema, NotApplicableSchema]),

    upstream_api_price_estimate: v.union([
      v.strictObject({
        status: v.literal('known'),
        value: v.pipe(v.number(), v.minValue(0)),
        currency: NonEmptyStringSchema,
        provenance: NonEmptyStringSchema
      }),
      UnknownValueSchema
    ])
  }),

  retention: RetentionStructureSchema,
  raw_artifact_path: NonEmptyStringSchema,
  raw_artifact_manifest_digest: Sha256Schema
})

function evidencePassed(
  evidence: v.InferOutput<typeof EnforcementEvidenceSchema>
): boolean {
  return (
    evidence.status === 'passed' && evidence.evidence_digest.status === 'known'
  )
}

function terminationMatchesClassification(
  completion: v.InferOutput<typeof CompletionRunRecordStructureSchema>
): boolean {
  const { classification, termination } = completion

  if (classification === 'cancellation') {
    return termination.kind === 'cancelled'
  }

  if (classification === 'task_success' || classification === 'task_failure') {
    return (
      termination.kind === 'success' || termination.kind === 'budget_exhausted'
    )
  }

  if (classification === 'agent_failure') {
    return (
      termination.kind === 'error' ||
      termination.kind === 'timeout' ||
      termination.kind === 'budget_exhausted'
    )
  }

  return termination.kind === 'error' || termination.kind === 'timeout'
}

export const CompletionRunRecordSchema = v.pipe(
  CompletionRunRecordStructureSchema,
  v.forward(
    v.check(
      ({ completed_at, retention }) =>
        v.safeParse(TimestampSchema, completed_at).success &&
        hasValidRetentionTimestamp(retention),
      'Run timestamps must use real ISO 8601 calendar dates'
    ),
    ['completed_at']
  ),
  v.forward(
    v.check(
      terminationMatchesClassification,
      'Termination kind does not match the terminal classification'
    ),
    ['termination']
  ),
  v.forward(
    v.check(
      ({ termination }) =>
        termination.kind !== 'timeout' ||
        termination.elapsed_seconds >= termination.limit_seconds,
      'Timeout elapsed seconds must be at least the configured limit'
    ),
    ['termination']
  ),
  v.forward(
    v.partialCheck(
      [['classification'], ['valid_grade']],
      ({ classification, valid_grade }) => {
        const qualityOutcome =
          classification === 'task_success' ||
          classification === 'task_failure'

        return valid_grade === qualityOutcome
      },
      'Task outcomes require a valid grade; execution failures cannot carry one'
    ),
    ['valid_grade']
  ),
  v.forward(
    v.partialCheck(
      [['collection'], ['verifier'], ['valid_grade']],
      ({ collection, verifier, valid_grade }) =>
        !valid_grade ||
        (evidencePassed(collection.quiescence) &&
          evidencePassed(collection.collection) &&
          evidencePassed(collection.exact_manifest) &&
          evidencePassed(collection.hashes) &&
          evidencePassed(verifier.separate_environment) &&
          evidencePassed(verifier.network_disabled) &&
          evidencePassed(verifier.credential_free) &&
          verifier.result_digest.status === 'known'),
      'A valid grade requires complete trusted collection and verifier evidence'
    ),
    ['valid_grade']
  ),
  v.forward(
    v.partialCheck(
      [['valid_grade'], ['score_id']],
      ({ valid_grade, score_id }) =>
        valid_grade ? score_id.status === 'known' : score_id.status !== 'known',
      'Score identity must match whether the run has a valid grade'
    ),
    ['score_id']
  )
)

export const RunDocumentStructureSchema = v.union([
  InitialRunRecordStructureSchema,
  CompletionRunRecordStructureSchema
])

export const RunDocumentSchema = v.union([
  InitialRunRecordSchema,
  CompletionRunRecordSchema
])

const ScoreEvidenceSchema = v.pipe(
  v.array(
    v.strictObject({
      check_id: IdentifierSchema,
      outcome: v.picklist(['passed', 'failed']),
      evidence_digest: Sha256Schema
    })
  ),
  v.minLength(1, 'A numeric facet requires verifier evidence')
)

const NumericFacetSchema = v.strictObject({
  status: v.literal('value'),
  value: UnitIntervalSchema,
  evidence: ScoreEvidenceSchema
})

const UnknownFacetSchema = v.strictObject({
  status: v.literal('unknown'),
  reason: NonEmptyStringSchema,
  evidence: v.array(ScoreEvidenceSchema.item)
})

const NotApplicableFacetSchema = v.strictObject({
  status: v.literal('not_applicable'),
  reason: NonEmptyStringSchema,
  evidence: v.array(ScoreEvidenceSchema.item)
})

const FacetSchema = v.union([
  NumericFacetSchema,
  UnknownFacetSchema,
  NotApplicableFacetSchema
])

const CompositeSchema = v.union([
  v.strictObject({
    status: v.literal('value'),
    value: UnitIntervalSchema
  }),
  UnknownValueSchema,
  NotApplicableSchema
])

export const ScoreDocumentStructureSchema = v.strictObject({
  document_type: v.literal('score'),
  schema_version: SchemaVersionSchema,
  score_id: IdentifierSchema,
  run_id: IdentifierSchema,
  verifier_result_digest: Sha256Schema,
  scoring_revision: RevisionSchema,
  rubric_revision: RevisionSchema,
  valid_grade: v.boolean(),

  gates: v.strictObject({
    direct_behavior_pass: v.boolean(),
    regression_pass: v.boolean(),
    verifier_integrity_pass: v.boolean()
  }),

  facets: v.strictObject({
    direct_behavior: FacetSchema,
    repository_contracts: FacetSchema,
    regression: FacetSchema,
    scope_integrity: FacetSchema,
    maintainability: FacetSchema
  }),

  scope_violations: v.array(
    v.strictObject({
      path: NonEmptyStringSchema,
      reason: NonEmptyStringSchema,
      evidence_digest: Sha256Schema
    })
  ),

  harbor_reward: v.strictObject({
    status: v.picklist(['retained_upstream', 'not_available']),
    numeric_values: v.record(NonEmptyStringSchema, UnitIntervalSchema)
  }),

  composite: CompositeSchema
})

export const ScoreDocumentSchema = v.pipe(
  ScoreDocumentStructureSchema,
  v.forward(
    v.check(
      ({ harbor_reward }) =>
        harbor_reward.status !== 'not_available' ||
        Object.keys(harbor_reward.numeric_values).length === 0,
      'Unavailable Harbor rewards cannot contain numeric values'
    ),
    ['harbor_reward']
  ),
  v.forward(
    v.partialCheck(
      [['valid_grade'], ['gates']],
      ({ valid_grade, gates }) => !valid_grade || gates.verifier_integrity_pass,
      'A valid grade requires verifier integrity'
    ),
    ['valid_grade']
  ),
  v.forward(
    v.partialCheck(
      [['valid_grade'], ['facets'], ['composite']],
      ({ valid_grade, facets, composite }) => {
        const requiredFacets = [
          facets.direct_behavior,
          facets.repository_contracts,
          facets.regression,
          facets.scope_integrity
        ]

        const complete = requiredFacets.every(
          ({ status }) => status === 'value'
        )

        return composite.status !== 'value' || (valid_grade && complete)
      },
      'Composite requires a valid grade and all required numeric facets'
    ),
    ['composite']
  ),
  v.forward(
    v.partialCheck(
      [['facets'], ['gates'], ['composite']],
      ({ facets, gates, composite }) => {
        if (composite.status !== 'value') {
          return true
        }

        if (
          facets.direct_behavior.status !== 'value' ||
          facets.repository_contracts.status !== 'value' ||
          facets.scope_integrity.status !== 'value'
        ) {
          return false
        }

        const gate = Number(
          gates.direct_behavior_pass &&
            gates.regression_pass &&
            gates.verifier_integrity_pass
        )

        const weighted =
          0.45 * facets.direct_behavior.value +
          0.35 * facets.repository_contracts.value +
          0.2 * facets.scope_integrity.value

        return Math.abs(composite.value - gate * weighted) < 1e-12
      },
      'Composite does not match the frozen v1 scoring formula'
    ),
    ['composite']
  )
)

export type StackDocument = v.InferOutput<typeof StackDocumentSchema>
export type HarnessDocument = v.InferOutput<typeof HarnessDocumentSchema>
export type TaskDocument = v.InferOutput<typeof TaskDocumentSchema>
export type SuiteDocument = v.InferOutput<typeof SuiteDocumentSchema>
export type ExperimentDocument = v.InferOutput<typeof ExperimentDocumentSchema>
export type InitialRunRecord = v.InferOutput<typeof InitialRunRecordSchema>
export type CompletionRunRecord = v.InferOutput<
  typeof CompletionRunRecordSchema
>
export type RunDocument = v.InferOutput<typeof RunDocumentSchema>
export type ScoreDocument = v.InferOutput<typeof ScoreDocumentSchema>
