import type {
  CompletionRunRecord,
  ExperimentDocument,
  HarnessDocument,
  InitialRunRecord,
  ScoreDocument,
  StackDocument,
  SuiteDocument,
  TaskDocument
} from './documents.ts'

export interface RelationshipIssue {
  readonly path: string;
  readonly message: string;
}

export interface DocumentRelationships {
  readonly stacks: readonly StackDocument[];
  readonly harnesses: readonly HarnessDocument[];
  readonly suite: SuiteDocument;
  readonly tasks: readonly TaskDocument[];
  readonly experiment: ExperimentDocument;
  readonly initial_run: InitialRunRecord;
  readonly initial_run_digest: string;
  readonly completion_run?: CompletionRunRecord;
  readonly score?: ScoreDocument;
}

function mismatch(
  path: string,
  expected: string,
  received: string
): RelationshipIssue {
  return {
    path,
    message: `Expected ${expected}, received ${received}`
  }
}

function validateReference(
  path: string,
  reference: {
    readonly id: string;
    readonly revision: string;
    readonly digest: string;
  },
  target: {
    readonly id: string;
    readonly revision: string;
    readonly digest: string;
  }
): RelationshipIssue[] {
  const issues: RelationshipIssue[] = []

  for (const key of ['id', 'revision', 'digest'] as const) {
    if (reference[key] !== target[key]) {
      issues.push(mismatch(`${path}.${key}`, target[key], reference[key]))
    }
  }

  return issues
}

function comparableStackIdentity(stack: StackDocument): string {
  return JSON.stringify({
    agent: stack.agent,
    runner: stack.runner,
    environment: stack.environment,
    network_policy: stack.network_policy,
    effective_permissions_digest: stack.effective_permissions_digest,
    mcp_tools_digest: stack.mcp_tools_digest,
    budget: stack.budget
  })
}

export function validateDocumentRelationships(
  documents: DocumentRelationships
): RelationshipIssue[] {
  const issues: RelationshipIssue[] = []

  const harnessesById = new Map(
    documents.harnesses.map((harness) => [harness.harness_id, harness])
  )

  const stacksById = new Map(
    documents.stacks.map((stack) => [stack.stack_id, stack])
  )

  for (const [index, stack] of documents.stacks.entries()) {
    const harness = harnessesById.get(stack.harness.id)

    if (!harness) {
      issues.push({
        path: `stacks.${index}.harness.id`,
        message: `Harness ${stack.harness.id} is not present in the supplied harness set`
      })

      continue
    }

    issues.push(
      ...validateReference(`stacks.${index}.harness`, stack.harness, {
        id: harness.harness_id,
        revision: harness.revision,
        digest: harness.digest
      })
    )
  }

  issues.push(
    ...validateReference('experiment.suite', documents.experiment.suite, {
      id: documents.suite.suite_id,
      revision: documents.suite.revision,
      digest: documents.suite.digest
    })
  )

  const tasksById = new Map(
    documents.tasks.map((task) => [task.task_id, task])
  )

  for (const [index, reference] of documents.suite.tasks.entries()) {
    const task = tasksById.get(reference.task_id)

    if (!task) {
      issues.push({
        path: `suite.tasks.${index}.task_id`,
        message: `Task ${reference.task_id} is not present in the supplied task set`
      })

      continue
    }

    if (reference.revision !== task.revision) {
      issues.push(
        mismatch(
          `suite.tasks.${index}.revision`,
          task.revision,
          reference.revision
        )
      )
    }

    if (reference.source_digest !== task.source_digest) {
      issues.push(
        mismatch(
          `suite.tasks.${index}.source_digest`,
          task.source_digest,
          reference.source_digest
        )
      )
    }
  }

  const suiteTasksById = new Map(
    documents.suite.tasks.map((reference) => [reference.task_id, reference])
  )

  if (documents.experiment.tasks.length !== documents.suite.tasks.length) {
    issues.push({
      path: 'experiment.tasks',
      message: 'Experiment tasks must exactly match the referenced suite'
    })
  }

  for (const [index, reference] of documents.experiment.tasks.entries()) {
    const suiteReference = suiteTasksById.get(reference.task_id)

    if (!suiteReference) {
      issues.push({
        path: `experiment.tasks.${index}.task_id`,
        message: `Task ${reference.task_id} is not present in the referenced suite`
      })

      continue
    }

    if (reference.revision !== suiteReference.revision) {
      issues.push(
        mismatch(
          `experiment.tasks.${index}.revision`,
          suiteReference.revision,
          reference.revision
        )
      )
    }

    if (reference.source_digest !== suiteReference.source_digest) {
      issues.push(
        mismatch(
          `experiment.tasks.${index}.source_digest`,
          suiteReference.source_digest,
          reference.source_digest
        )
      )
    }
  }

  const armIds = new Set(documents.experiment.arms.map(({ arm_id }) => arm_id))

  const treatmentCount = new Set(
    documents.experiment.arms.map(({ treatment }) => treatment)
  ).size

  if (treatmentCount !== documents.experiment.arms.length) {
    issues.push({
      path: 'experiment.arms',
      message: 'Harness-effect arms must declare distinct treatments'
    })
  }

  const harnessCount = new Set(
    documents.experiment.arms.map(({ harness }) => harness.digest)
  ).size

  if (harnessCount !== documents.experiment.arms.length) {
    issues.push({
      path: 'experiment.arms',
      message: 'Harness-effect arms must reference distinct harness digests'
    })
  }

  for (const [index, arm] of documents.experiment.arms.entries()) {
    const stack = stacksById.get(arm.stack.id)
    const harness = harnessesById.get(arm.harness.id)

    if (!stack) {
      issues.push({
        path: `experiment.arms.${index}.stack.id`,
        message: `Stack ${arm.stack.id} is not present in the supplied stack set`
      })
    } else {
      issues.push(
        ...validateReference(`experiment.arms.${index}.stack`, arm.stack, {
          id: stack.stack_id,
          revision: stack.revision,
          digest: stack.digest
        })
      )

      if (stack.harness.id !== arm.harness.id) {
        issues.push({
          path: `experiment.arms.${index}.harness.id`,
          message: 'Experiment arm harness must match its stack harness'
        })
      }

      const controlsMatch =
        JSON.stringify(stack.budget) ===
          JSON.stringify(documents.experiment.budget) &&
        stack.runner.concurrency.requested ===
          documents.experiment.requested_concurrency &&
        JSON.stringify(stack.runner.concurrency.effective) ===
          JSON.stringify(documents.experiment.effective_concurrency) &&
        stack.runner.concurrency.enforcement_status ===
          documents.experiment.concurrency_enforcement_status

      if (!controlsMatch) {
        issues.push({
          path: `experiment.arms.${index}.stack`,

          message:
            'Experiment budget and concurrency controls must match every selected stack'
        })
      }
    }

    if (!harness) {
      issues.push({
        path: `experiment.arms.${index}.harness.id`,
        message: `Harness ${arm.harness.id} is not present in the supplied harness set`
      })
    } else {
      issues.push(
        ...validateReference(`experiment.arms.${index}.harness`, arm.harness, {
          id: harness.harness_id,
          revision: harness.revision,
          digest: harness.digest
        })
      )
    }
  }

  const armStacks = documents.experiment.arms
    .map((arm) => stacksById.get(arm.stack.id))
    .filter((stack): stack is StackDocument => stack !== undefined)

  const comparableIdentities = new Set(armStacks.map(comparableStackIdentity))

  if (
    armStacks.length === documents.experiment.arms.length &&
    comparableIdentities.size > 1
  ) {
    issues.push({
      path: 'experiment.arms',

      message:
        'Harness-effect arms may differ only by harness identity and treatment'
    })
  }

  for (const [index, block] of documents.experiment.blocks.entries()) {
    if (
      block.first_started_at.status === 'known' &&
      block.deadline_at.status === 'known'
    ) {
      const firstStarted = Date.parse(block.first_started_at.value)
      const deadline = Date.parse(block.deadline_at.value)

      if (deadline - firstStarted !== 24 * 60 * 60 * 1_000) {
        issues.push({
          path: `experiment.blocks.${index}.deadline_at`,
          message: 'Block deadline must be exactly 24 hours after first start'
        })
      }

      if (
        block.completed_at.status === 'known' &&
        Date.parse(block.completed_at.value) > deadline &&
        !(
          block.contemporaneity.status === 'ineligible' &&
          block.contemporaneity.cause === 'deadline_exceeded'
        )
      ) {
        issues.push({
          path: `experiment.blocks.${index}.contemporaneity`,
          message: 'A block completed after its deadline must be ineligible'
        })
      }
    }
  }

  const initial = documents.initial_run
  const runStack = stacksById.get(initial.stack.id)

  if (!runStack) {
    issues.push({
      path: 'initial_run.stack.id',
      message: `Stack ${initial.stack.id} is not present in the supplied stack set`
    })
  } else {
    issues.push(
      ...validateReference('initial_run.stack', initial.stack, {
        id: runStack.stack_id,
        revision: runStack.revision,
        digest: runStack.digest
      })
    )

    if (JSON.stringify(initial.harness) !== JSON.stringify(runStack.harness)) {
      issues.push({
        path: 'initial_run.harness',
        message: 'Run harness identity must match the selected stack'
      })
    }

    const agentMatches =
      initial.agent.product === runStack.agent.product &&
      initial.agent.cli_version === runStack.agent.cli_version &&
      initial.agent.requested_model === runStack.agent.requested_model &&
      initial.agent.effort === runStack.agent.effort &&
      initial.agent.auth_mode === runStack.agent.auth.mode &&
      JSON.stringify(initial.agent.observed_provider_identity) ===
        JSON.stringify(runStack.agent.observed_provider_identity)

    if (!agentMatches) {
      issues.push({
        path: 'initial_run.agent',
        message: 'Run agent identity must match the selected stack'
      })
    }

    const runnerMatches =
      initial.runner.name === runStack.runner.name &&
      initial.runner.version === runStack.runner.version &&
      initial.runner.config_digest === runStack.runner.config_digest &&
      initial.runner.telemetry === runStack.runner.telemetry.effective &&
      initial.runner.requested_concurrency ===
        runStack.runner.concurrency.requested &&
      JSON.stringify(initial.runner.effective_concurrency) ===
        JSON.stringify(runStack.runner.concurrency.effective) &&
      initial.runner.concurrency_enforcement_status ===
        runStack.runner.concurrency.enforcement_status

    if (!runnerMatches) {
      issues.push({
        path: 'initial_run.runner',
        message: 'Run runner identity must match the selected stack'
      })
    }

    if (
      initial.network_policy_digest !== runStack.network_policy.digest ||
      initial.effective_permissions_digest !==
        runStack.effective_permissions_digest ||
      initial.mcp_tools_digest !== runStack.mcp_tools_digest ||
      JSON.stringify(initial.budget) !== JSON.stringify(runStack.budget)
    ) {
      issues.push({
        path: 'initial_run.stack',
        message: 'Run policy and budget must match the selected stack'
      })
    }
  }

  if (
    initial.experiment.experiment_id !== documents.experiment.experiment_id ||
    initial.experiment.experiment_revision !== documents.experiment.revision ||
    initial.experiment.plan_digest !== documents.experiment.plan_digest
  ) {
    issues.push({
      path: 'initial_run.experiment',
      message: 'Run experiment identity must match the frozen experiment plan'
    })
  }

  if (!armIds.has(initial.experiment.arm_id)) {
    issues.push({
      path: 'initial_run.experiment.arm_id',
      message: 'Run arm must be present in the frozen experiment plan'
    })
  }

  const selectedArm = documents.experiment.arms.find(
    ({ arm_id }) => arm_id === initial.experiment.arm_id
  )

  if (
    selectedArm &&
    (JSON.stringify(initial.stack) !== JSON.stringify(selectedArm.stack) ||
      JSON.stringify(initial.harness) !== JSON.stringify(selectedArm.harness))
  ) {
    issues.push({
      path: 'initial_run.experiment.arm_id',
      message: 'Run stack and harness must match the selected experiment arm'
    })
  }

  const selectedBlock = documents.experiment.blocks.find(
    ({ block_id }) => block_id === initial.experiment.block_id
  )

  if (
    !selectedBlock ||
    selectedBlock.task_id !== initial.task.id ||
    selectedBlock.replicate !== initial.experiment.replicate
  ) {
    issues.push({
      path: 'initial_run.experiment.block_id',

      message:
        'Run must match the selected task, replicate, and arm in its block'
    })
  } else {
    const blockRun = selectedBlock.runs.find(
      ({ run_id }) => run_id === initial.identity.run_id
    )

    if (
      !blockRun ||
      blockRun.arm_id !== initial.experiment.arm_id ||
      blockRun.attempt !== initial.identity.attempt
    ) {
      issues.push({
        path: 'initial_run.identity.run_id',

        message:
          'Run identity, arm, and attempt must match one assignment in the selected block'
      })
    }
  }

  if (
    initial.suite.id !== documents.suite.suite_id ||
    initial.suite.revision !== documents.suite.revision ||
    initial.suite.digest !== documents.suite.digest
  ) {
    issues.push({
      path: 'initial_run.suite',
      message: 'Run suite identity must match the referenced suite'
    })
  }

  const runTask = tasksById.get(initial.task.id)

  if (
    !runTask ||
    initial.task.revision !== runTask.revision ||
    initial.task.base_commit !== runTask.base_commit ||
    initial.task.source_digest !== runTask.source_digest
  ) {
    issues.push({
      path: 'initial_run.task',
      message: 'Run task identity must match the referenced task'
    })
  }

  if (runTask) {
    if (
      JSON.stringify(initial.retention) !== JSON.stringify(runTask.retention)
    ) {
      issues.push({
        path: 'initial_run.retention',
        message: 'Run retention must match the selected task'
      })
    }

    if (initial.task.environment_image_digest !== runTask.environment.digest) {
      issues.push(
        mismatch(
          'initial_run.task.environment_image_digest',
          runTask.environment.digest,
          initial.task.environment_image_digest
        )
      )
    }

    if (
      initial.collector.revision !== runTask.collector.revision ||
      initial.collector.image_digest !== runTask.collector.image_digest
    ) {
      issues.push({
        path: 'initial_run.collector',
        message: 'Run collector identity must match the selected task'
      })
    }

    if (
      initial.verifier.revision !== runTask.verifier.revision ||
      initial.verifier.image_digest !== runTask.verifier.image_digest ||
      JSON.stringify(initial.verifier.network_enforcement_sidecar_digest) !==
        JSON.stringify(runTask.verifier.network_enforcement_sidecar_digest)
    ) {
      issues.push({
        path: 'initial_run.verifier',
        message: 'Run verifier identity must match the selected task'
      })
    }

    if (initial.scoring_revision !== runTask.scoring.revision) {
      issues.push(
        mismatch(
          'initial_run.scoring_revision',
          runTask.scoring.revision,
          initial.scoring_revision
        )
      )
    }
  }

  if (initial.identity.run_id !== documents.completion_run?.identity.run_id) {
    if (documents.completion_run) {
      issues.push(
        mismatch(
          'completion_run.identity.run_id',
          initial.identity.run_id,
          documents.completion_run.identity.run_id
        )
      )
    }
  }

  if (
    documents.completion_run &&
    initial.identity.attempt_id !== documents.completion_run.identity.attempt_id
  ) {
    issues.push(
      mismatch(
        'completion_run.identity.attempt_id',
        initial.identity.attempt_id,
        documents.completion_run.identity.attempt_id
      )
    )
  }

  if (documents.completion_run) {
    const completion = documents.completion_run

    if (
      JSON.stringify(completion.retention) !== JSON.stringify(initial.retention)
    ) {
      issues.push({
        path: 'completion_run.retention',

        message:
          'Completion retention must match the immutable initial manifest'
      })
    }

    if (
      completion.collection.collector_revision !== initial.collector.revision ||
      completion.collection.collector_image_digest !==
        initial.collector.image_digest
    ) {
      issues.push({
        path: 'completion_run.collection',

        message:
          'Completion collector identity must match the initial manifest'
      })
    }

    if (
      completion.verifier.verifier_revision !== initial.verifier.revision ||
      completion.verifier.verifier_image_digest !==
        initial.verifier.image_digest ||
      JSON.stringify(completion.verifier.network_enforcement_sidecar_digest) !==
        JSON.stringify(initial.verifier.network_enforcement_sidecar_digest)
    ) {
      issues.push({
        path: 'completion_run.verifier',
        message: 'Completion verifier identity must match the initial manifest'
      })
    }
  }

  if (
    documents.completion_run &&
    documents.completion_run.initial_manifest_digest !==
      documents.initial_run_digest
  ) {
    issues.push(
      mismatch(
        'completion_run.initial_manifest_digest',
        documents.initial_run_digest,
        documents.completion_run.initial_manifest_digest
      )
    )
  }

  if (
    documents.completion_run &&
    Date.parse(documents.completion_run.completed_at) <
      Date.parse(initial.created_at)
  ) {
    issues.push({
      path: 'completion_run.completed_at',
      message: 'Completion timestamp cannot precede the initial manifest'
    })
  }

  if (documents.score && !documents.completion_run) {
    issues.push({
      path: 'score',
      message: 'A score requires its immutable completion record'
    })
  }

  if (documents.completion_run?.valid_grade && !documents.score) {
    issues.push({
      path: 'score',
      message: 'A valid completion grade requires its score document'
    })
  }

  if (documents.score && documents.completion_run) {
    if (documents.score.run_id !== initial.identity.run_id) {
      issues.push(
        mismatch(
          'score.run_id',
          initial.identity.run_id,
          documents.score.run_id
        )
      )
    }

    if (documents.score.valid_grade !== documents.completion_run.valid_grade) {
      issues.push({
        path: 'score.valid_grade',
        message: 'Score validity must match the immutable completion record'
      })
    }

    const completionScoreId = documents.completion_run.score_id

    if (
      completionScoreId.status === 'known' &&
      documents.score.score_id !== completionScoreId.value
    ) {
      issues.push(
        mismatch(
          'score.score_id',
          completionScoreId.value,
          documents.score.score_id
        )
      )
    }

    if (runTask) {
      if (
        documents.score.scoring_revision !== runTask.scoring.revision ||
        documents.score.rubric_revision !== runTask.scoring.rubric_revision
      ) {
        issues.push({
          path: 'score.scoring_revision',
          message: 'Score revisions must match the selected task'
        })
      }
    }

    const verifierDigest = documents.completion_run.verifier.result_digest

    if (
      verifierDigest.status === 'known' &&
      documents.score.verifier_result_digest !== verifierDigest.value
    ) {
      issues.push(
        mismatch(
          'score.verifier_result_digest',
          verifierDigest.value,
          documents.score.verifier_result_digest
        )
      )
    }

    if (
      documents.completion_run.classification === 'task_success' &&
      (!documents.score.gates.direct_behavior_pass ||
        !documents.score.gates.regression_pass ||
        !documents.score.gates.verifier_integrity_pass)
    ) {
      issues.push({
        path: 'score.gates',
        message: 'Task success requires all mandatory score gates to pass'
      })
    }
  }

  return issues
}
