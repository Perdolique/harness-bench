import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type {
  ExperimentComparisonSource,
  ExperimentComparisonRunRecord,
  NormalizedRunRecordV1
} from '@harness-bench/results'

import { StatisticsError } from './errors.ts'

import type {
  ArmObservedSummaryV1,
  ArmPairComparisonV1,
  ArmReferenceV1,
  ConfidenceIntervalV1,
  ComparisonMigrationV1,
  DistributionSummaryV1,
  ExperimentComparisonAnalysisV1,
  MetricComparisonV1,
  ObservedMetricV1,
  OmittedBlockV1,
  OperationalMetricName,
  OutcomeCountV1,
  QualityMetricName,
  TaskMetricComparisonV1,
  TaskPairComparisonV1,
  WinTieLossV1
} from './types.ts'

export const ANALYSIS_REVISION = '1'
export const BOOTSTRAP_RESAMPLES = 10_000
export const BOOTSTRAP_CONFIDENCE = 0.95

export const QUALITY_METRICS = [
  'pass_rate',
  'direct_behavior',
  'repository_contracts',
  'regression',
  'scope_integrity',
  'maintainability',
  'composite'
] as const satisfies readonly QualityMetricName[]

export const OPERATIONAL_METRICS = [
  'total_seconds',
  'agent_seconds',
  'verifier_seconds',
  'input_tokens',
  'output_tokens'
] as const satisfies readonly OperationalMetricName[]

type ExperimentState = ExperimentComparisonSource['state']
type ExperimentBlockState = ExperimentState['blocks'][number]
type ExperimentRunState = ExperimentBlockState['runs'][number]
type ExperimentPlan = ExperimentState['plan']
type StackDocument = ExperimentPlan['stacks'][number]

interface PairedObservation {
  readonly left: number;
  readonly right: number;
}

interface EligibleBlock {
  readonly block: ExperimentBlockState;
  readonly left: ExperimentComparisonRunRecord;
  readonly right: ExperimentComparisonRunRecord;
}

function incompatible(message: string): never {
  throw new StatisticsError('INCOMPATIBLE_COMPARISON', message)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function quantile(sorted: readonly number[], probability: number): number {
  const position = (sorted.length - 1) * probability
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  const lower = sorted[lowerIndex]!
  const upper = sorted[upperIndex]!
  const fraction = position - lowerIndex

  return lower + (upper - lower) * fraction
}

function distribution(values: readonly number[], unknownCount: number): DistributionSummaryV1 {
  if (values.length === 0) {
    return {
      knownCount: 0,
      unknownCount,
      mean: null,
      minimum: null,
      firstQuartile: null,
      median: null,
      thirdQuartile: null,
      maximum: null
    }
  }

  const sorted = [...values].sort((left, right) => left - right)

  return {
    knownCount: sorted.length,
    unknownCount,
    mean: mean(sorted),
    minimum: sorted[0]!,
    firstQuartile: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    thirdQuartile: quantile(sorted, 0.75),
    maximum: sorted.at(-1)!
  }
}

function uint32Hash(value: unknown): number {
  const serialized = JSON.stringify(value)
  const digest = createHash('sha256').update(serialized).digest('hex')

  return Number.parseInt(digest.slice(0, 8), 16) >>> 0
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6D2B79F5) >>> 0

    let value = state

    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)

    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function bootstrapInterval(
  taskDeltas: readonly number[],
  baseSeed: number,
  scope: readonly string[]
): ConfidenceIntervalV1 | null {
  if (taskDeltas.length === 0) return null

  const scopeSeed = uint32Hash([baseSeed, ...scope])
  const random = mulberry32(scopeSeed)
  const estimates: number[] = []

  for (let resample = 0; resample < BOOTSTRAP_RESAMPLES; resample += 1) {
    let sum = 0

    for (let draw = 0; draw < taskDeltas.length; draw += 1) {
      const index = Math.floor(random() * taskDeltas.length)

      sum += taskDeltas[index]!
    }

    estimates.push(sum / taskDeltas.length)
  }

  estimates.sort((left, right) => left - right)

  return {
    lower: quantile(estimates, (1 - BOOTSTRAP_CONFIDENCE) / 2),
    upper: quantile(estimates, 1 - (1 - BOOTSTRAP_CONFIDENCE) / 2)
  }
}

function winTieLoss(deltas: readonly number[]): WinTieLossV1 {
  let wins = 0
  let ties = 0
  let losses = 0

  for (const delta of deltas) {
    if (delta > 0) wins += 1
    else if (delta < 0) losses += 1
    else ties += 1
  }

  return {
    wins,
    ties,
    losses
  }
}

function armReference(plan: ExperimentPlan, armId: string): ArmReferenceV1 {
  const arm = plan.experiment.arms.find(({ arm_id }) => arm_id === armId)

  if (arm === undefined) incompatible('Experiment arm is missing from the frozen plan')

  return {
    armId: arm.arm_id,
    treatment: arm.treatment,
    harnessId: arm.harness.id,
    harnessRevision: arm.harness.revision,
    harnessDigest: arm.harness.digest
  }
}

function stackForArm(plan: ExperimentPlan, armId: string): StackDocument {
  const arm = plan.experiment.arms.find(({ arm_id }) => arm_id === armId)

  if (arm === undefined) incompatible('Experiment arm is missing from the frozen plan')

  const matching = plan.stacks.filter((stack) => (
    stack.stack_id === arm.stack.id &&
    stack.revision === arm.stack.revision &&
    stack.digest === arm.stack.digest
  ))

  if (matching.length !== 1) incompatible('Experiment arm stack identity is missing or ambiguous')

  return matching[0]!
}

function controlledStackIdentity(stack: StackDocument): unknown {
  return {
    agent: stack.agent,
    runner: stack.runner,
    environment: stack.environment,
    networkPolicy: stack.network_policy,
    effectivePermissionsDigest: stack.effective_permissions_digest,
    mcpToolsDigest: stack.mcp_tools_digest,
    budget: stack.budget
  }
}

function assertPlanCompatibility(plan: ExperimentPlan, superseded: boolean): void {
  const definitionRevision = plan.definition.analysis_revision
  const experimentRevision = plan.experiment.analysis_revision

  if (definitionRevision !== experimentRevision) {
    incompatible('Experiment definition and plan analysis revisions differ')
  }

  if (experimentRevision !== ANALYSIS_REVISION) {
    throw new StatisticsError(
      'UNSUPPORTED_ANALYSIS_REVISION',
      'Experiment analysis revision is not supported'
    )
  }

  if (superseded) incompatible('Superseded experiment plans cannot support a current harness-effect comparison')

  const arms = [...plan.experiment.arms].sort((left, right) => compareText(left.arm_id, right.arm_id))
  const stacks = arms.map(({ arm_id }) => stackForArm(plan, arm_id))
  const first = stacks[0]

  if (first === undefined) incompatible('Experiment needs at least two arms')

  const controlled = controlledStackIdentity(first)

  for (const stack of stacks) {
    if (!isDeepStrictEqual(controlledStackIdentity(stack), controlled)) {
      incompatible('Harness-effect arms differ outside harness identity and treatment')
    }

    if (!isDeepStrictEqual(stack.budget, plan.experiment.budget)) {
      incompatible('Experiment and stack budgets differ')
    }
  }

  const harnessDigests = new Set(arms.map(({ harness }) => harness.digest))

  if (harnessDigests.size !== arms.length) {
    incompatible('Harness-effect arms must use distinct harness identities')
  }
}

function comparableAgent(record: ExperimentComparisonRunRecord): unknown {
  const agent = record.initialRecord.agent

  return {
    product: agent.product,
    cliVersion: agent.cli_version,
    requestedModel: agent.requested_model,
    effort: agent.effort,
    authMode: agent.auth_mode
  }
}

function evaluatorIdentity(record: ExperimentComparisonRunRecord): unknown {
  if (record.regrade !== undefined) return record.regrade.record.target.evaluator

  const score = record.record.score

  return {
    verifier_revision: record.record.revisions.verifier_revision,
    verifier_image_digest: record.record.revisions.verifier_image_digest,

    verifier_network_enforcement_sidecar_digest:
      record.record.revisions.verifier_network_enforcement_sidecar_digest,

    scoring_revision: record.record.revisions.scoring_revision,

    rubric_revision: score.status === 'known'
      ? score.document.rubric_revision
      : null
  }
}

function comparableRunIdentity(record: ExperimentComparisonRunRecord): unknown {
  const normalized = record.record
  const revisions = normalized.revisions

  return {
    normalizationRevision: normalized.normalization_revision,
    benchmarkRepoCommit: normalized.identities.benchmark_repo_commit,
    suite: normalized.identities.suite,
    task: normalized.identities.task,
    agent: comparableAgent(record),
    networkPolicyDigest: normalized.identities.network_policy_digest,
    effectivePermissionsDigest: normalized.identities.effective_permissions_digest,
    mcpToolsDigest: normalized.identities.mcp_tools_digest,
    host: normalized.identities.host,

    revisions: {
      runner_name: revisions.runner_name,
      runner_version: revisions.runner_version,
      runner_config_digest: revisions.runner_config_digest,
      collector_revision: revisions.collector_revision,
      collector_image_digest: revisions.collector_image_digest
    },

    evaluator: evaluatorIdentity(record),
    budget: record.initialRecord.budget,
    runner: record.initialRecord.runner,
    collector: record.initialRecord.collector
  }
}

function knownProvider(record: ExperimentComparisonRunRecord): string | null {
  const provider = record.record.identities.agent.observed_provider_identity

  return provider.status === 'known' ? provider.value : null
}

function assertSourceMatchesPlan(
  plan: ExperimentPlan,
  source: ExperimentComparisonRunRecord
): void {
  const record = source.record
  const initial = source.initialRecord
  const experiment = record.identities.experiment
  const arm = plan.experiment.arms.find(({ arm_id }) => arm_id === experiment.arm_id)
  const task = plan.experiment.tasks.find(({ task_id }) => task_id === record.identities.task.id)

  if (arm === undefined || task === undefined) {
    incompatible('Normalized run does not belong to an arm and task in the frozen plan')
  }

  const stack = stackForArm(plan, arm.arm_id)

  const expectedRunner = {
    name: stack.runner.name,
    version: stack.runner.version,
    config_digest: stack.runner.config_digest,
    telemetry: stack.runner.telemetry.effective,
    requested_concurrency: stack.runner.concurrency.requested,
    effective_concurrency: stack.runner.concurrency.effective,
    concurrency_enforcement_status: stack.runner.concurrency.enforcement_status
  }

  const expectedAgent = {
    product: stack.agent.product,
    cli_version: stack.agent.cli_version,
    requested_model: stack.agent.requested_model,
    effort: stack.agent.effort,
    auth_mode: stack.agent.auth.mode
  }

  const actualAgent = {
    product: initial.agent.product,
    cli_version: initial.agent.cli_version,
    requested_model: initial.agent.requested_model,
    effort: initial.agent.effort,
    auth_mode: initial.agent.auth_mode
  }

  const referencesMatch = (
    isDeepStrictEqual(initial.stack, arm.stack) &&
    isDeepStrictEqual(initial.harness, arm.harness) &&
    isDeepStrictEqual(initial.suite, plan.experiment.suite) &&
    initial.task.id === task.task_id &&
    initial.task.revision === task.revision &&
    initial.task.source_digest === task.source_digest
  )

  const controlsMatch = (
    isDeepStrictEqual(initial.budget, plan.experiment.budget) &&
    isDeepStrictEqual(initial.budget, stack.budget) &&
    isDeepStrictEqual(initial.runner, expectedRunner) &&
    isDeepStrictEqual(actualAgent, expectedAgent) &&
    initial.network_policy_digest === stack.network_policy.digest &&
    initial.effective_permissions_digest === stack.effective_permissions_digest &&
    initial.mcp_tools_digest === stack.mcp_tools_digest
  )

  if (!referencesMatch || !controlsMatch) {
    incompatible('Normalized run differs from its frozen harness-effect controls')
  }
}

function assertPairCompatibility(left: ExperimentComparisonRunRecord, right: ExperimentComparisonRunRecord): void {
  if (!isDeepStrictEqual(comparableRunIdentity(left), comparableRunIdentity(right))) {
    incompatible('Eligible arm results differ in task, environment, runner, verifier, scoring, or budget identity')
  }

  const leftScore = left.regrade?.record.score ?? (
    left.record.score.status === 'known' ? left.record.score.document : null
  )

  const rightScore = right.regrade?.record.score ?? (
    right.record.score.status === 'known' ? right.record.score.document : null
  )

  if (
    leftScore !== null &&
    rightScore !== null &&
    leftScore.rubric_revision !== rightScore.rubric_revision
  ) {
    incompatible('Eligible arm results differ in rubric revision')
  }

  const leftProvider = knownProvider(left)
  const rightProvider = knownProvider(right)

  if (leftProvider !== null && rightProvider !== null && leftProvider !== rightProvider) {
    incompatible('A completed comparison block contains different known provider identities')
  }
}

function validateAndIndexRunRecords(source: ExperimentComparisonSource): Map<string, ExperimentComparisonRunRecord> {
  const recordsByRunId = new Map<string, ExperimentComparisonRunRecord>()

  const expected = new Map(uniqueRunStates(source.state)
    .filter(({ result }) => result !== null)
    .map((run) => [run.assignment.run_id, run]))

  for (const record of source.records) {
    const runId = record.record.identities.run.run_id
    const expectedRun = expected.get(runId)

    if (recordsByRunId.has(runId)) incompatible('Experiment comparison contains duplicate run records')

    if (expectedRun === undefined) incompatible('Experiment comparison contains an unreferenced run record')

    const runIdentity = record.record.identities.run
    const experimentIdentity = record.record.identities.experiment
    const assignment = expectedRun.assignment
    const plan = source.state.plan
    const currentBlock = source.state.blocks.find(({ block_id }) => block_id === assignment.block_id)
    const block = currentBlock ?? source.state.excluded_blocks.find(({ block_id }) => block_id === assignment.block_id)
    const initialRun = record.initialRecord.identity
    const completionRun = record.completionRecord.identity

    const sameRunMetadata = (
      isDeepStrictEqual(runIdentity, initialRun) &&
      isDeepStrictEqual(runIdentity, completionRun)
    )

    const sameExperimentFamily = experimentIdentity.experiment_id === plan.experiment.experiment_id

    const sameCurrentPlan = currentBlock === undefined || (
      experimentIdentity.experiment_revision === plan.experiment.revision &&
      experimentIdentity.plan_digest === plan.experiment.plan_digest
    )

    if (
      block === undefined ||
      !sameRunMetadata ||
      !sameExperimentFamily ||
      !sameCurrentPlan ||
      runIdentity.attempt_id !== assignment.attempt_id ||
      runIdentity.attempt !== assignment.attempt ||
      experimentIdentity.block_id !== assignment.block_id ||
      experimentIdentity.arm_id !== assignment.arm_id ||
      experimentIdentity.replicate !== block.replicate ||
      record.record.identities.task.id !== block.task_id ||
      record.digest !== expectedRun.result?.normalized_digest ||
      record.recordPath !== expectedRun.result.normalized_path
    ) {
      incompatible('Experiment comparison source differs from its verified assignment')
    }

    assertSourceMatchesPlan(source.state.plan, record)
    recordsByRunId.set(runId, record)
  }

  if (recordsByRunId.size !== expected.size) {
    incompatible('Experiment comparison is missing a verified run record')
  }

  return recordsByRunId
}

function runForArm(block: ExperimentBlockState, armId: string): ExperimentRunState {
  const matching = block.runs.filter(({ assignment }) => assignment.arm_id === armId)

  if (matching.length !== 1) incompatible('Experiment block does not contain exactly one run per arm')

  return matching[0]!
}

function recordForRun(
  records: ReadonlyMap<string, ExperimentComparisonRunRecord>,
  run: ExperimentRunState
): ExperimentComparisonRunRecord {
  const record = records.get(run.assignment.run_id)

  if (record === undefined || run.result === null) {
    incompatible('Verified experiment run is missing its sealed normalized source')
  }

  if (record.digest !== run.result.normalized_digest) {
    incompatible('Verified experiment run and normalized source digests differ')
  }

  return record
}

function eligibleBlocks(
  source: ExperimentComparisonSource,
  records: ReadonlyMap<string, ExperimentComparisonRunRecord>,
  leftArm: string,
  rightArm: string
): EligibleBlock[] {
  const eligible: EligibleBlock[] = []

  for (const block of source.state.blocks) {
    if (block.status !== 'completed') continue

    const leftRun = runForArm(block, leftArm)
    const rightRun = runForArm(block, rightArm)
    const left = recordForRun(records, leftRun)
    const right = recordForRun(records, rightRun)

    assertPairCompatibility(left, right)

    eligible.push({
      block,
      left,
      right
    })
  }

  return eligible
}

function qualityMetric(
  record: ExperimentComparisonRunRecord,
  metric: QualityMetricName
): number | null {
  const outcome = record.regrade?.record.outcome ?? record.record.outcome

  const score = record.regrade?.record.score ?? (
    record.record.score.status === 'known'
      ? record.record.score.document
      : null
  )

  if (metric === 'pass_rate') {
    if (!outcome.valid_grade) return null

    if (outcome.classification === 'task_success') return 1

    if (outcome.classification === 'task_failure') return 0

    return null
  }

  if (score === null) return null

  if (metric === 'composite') {
    const composite = score.composite

    return composite.status === 'value' ? composite.value : null
  }

  const facet = score.facets[metric]

  return facet.status === 'value' ? facet.value : null
}

function operationalMetric(
  record: NormalizedRunRecordV1,
  metric: OperationalMetricName
): number | null {
  if (metric === 'total_seconds') return record.timings.total_seconds

  const value = metric === 'agent_seconds'
    ? record.timings.agent_seconds
    : metric === 'verifier_seconds'
      ? record.timings.verifier_seconds
      : metric === 'input_tokens'
        ? record.usage.input_tokens
        : record.usage.output_tokens

  return value.status === 'known' ? value.value : null
}

function pairedObservations(
  blocks: readonly EligibleBlock[],
  metric: QualityMetricName | OperationalMetricName
): PairedObservation[] {
  const observations: PairedObservation[] = []

  for (const block of blocks) {
    const quality = (QUALITY_METRICS as readonly string[]).includes(metric)

    const left = quality
      ? qualityMetric(block.left, metric as QualityMetricName)
      : operationalMetric(block.left.record, metric as OperationalMetricName)

    const right = quality
      ? qualityMetric(block.right, metric as QualityMetricName)
      : operationalMetric(block.right.record, metric as OperationalMetricName)

    if (left !== null && right !== null) observations.push({
      left,
      right
    })
  }

  return observations
}

function taskMetric(
  taskBlocks: readonly EligibleBlock[],
  metric: QualityMetricName | OperationalMetricName
): TaskMetricComparisonV1 | null {
  const observations = pairedObservations(taskBlocks, metric)

  if (observations.length === 0) return null

  const leftMean = mean(observations.map(({ left }) => left))
  const rightMean = mean(observations.map(({ right }) => right))

  return {
    metric,
    pairedObservations: observations.length,
    leftMean,
    rightMean,
    delta: rightMean - leftMean
  }
}

function armReliability(
  blocks: readonly ExperimentBlockState[],
  records: ReadonlyMap<string, ExperimentComparisonRunRecord>,
  armId: string
): boolean | null {
  let pending = false

  for (const block of blocks) {
    const run = runForArm(block, armId)

    if (run.status === 'pending') {
      if (run.started_at !== null) return false

      pending = true

      continue
    }

    if (run.status === 'interrupted' || run.result?.valid_grade !== true) {
      return false
    }

    const record = recordForRun(records, run)
    const outcome = record.regrade?.record.outcome ?? record.record.outcome

    if (!outcome.valid_grade || outcome.classification !== 'task_success') {
      return false
    }
  }

  return pending ? null : true
}

function taskPairSummaries(
  source: ExperimentComparisonSource,
  eligible: readonly EligibleBlock[],
  records: ReadonlyMap<string, ExperimentComparisonRunRecord>,
  leftArm: string,
  rightArm: string
): TaskPairComparisonV1[] {
  const summaries: TaskPairComparisonV1[] = []
  const tasks = [...source.state.plan.experiment.tasks].sort((left, right) => compareText(left.task_id, right.task_id))

  for (const task of tasks) {
    const allTaskBlocks = source.state.blocks.filter(({ task_id }) => task_id === task.task_id)
    const eligibleTaskBlocks = eligible.filter(({ block }) => block.task_id === task.task_id)
    const metrics: TaskMetricComparisonV1[] = []

    for (const metric of [...QUALITY_METRICS, ...OPERATIONAL_METRICS]) {
      const summary = taskMetric(eligibleTaskBlocks, metric)

      if (summary !== null) metrics.push(summary)
    }

    const leftReliability = armReliability(allTaskBlocks, records, leftArm)
    const rightReliability = armReliability(allTaskBlocks, records, rightArm)

    const reliabilityDelta = leftReliability === null || rightReliability === null
      ? null
      : Number(rightReliability) - Number(leftReliability)

    summaries.push({
      taskId: task.task_id,
      eligibleReplicates: eligibleTaskBlocks.length,
      requestedReplicates: source.state.plan.experiment.repeats,
      metrics,

      reliability: {
        left: leftReliability,
        right: rightReliability,
        delta: reliabilityDelta
      }
    })
  }

  return summaries
}

function summarizedMetric(
  eligible: readonly EligibleBlock[],
  tasks: readonly TaskPairComparisonV1[],
  metric: QualityMetricName | OperationalMetricName,
  baseSeed: number,
  pairScope: readonly string[]
): MetricComparisonV1 {
  const observations = pairedObservations(eligible, metric)

  const taskMetrics = tasks.flatMap((task) => {
    const selected = task.metrics.find((entry) => entry.metric === metric)

    return selected === undefined ? [] : [selected]
  })

  const deltas = taskMetrics.map(({ delta }) => delta)
  const quality = (QUALITY_METRICS as readonly string[]).includes(metric)

  return {
    metric,
    pairedObservations: observations.length,
    taskClusters: taskMetrics.length,
    leftDistribution: distribution(observations.map(({ left }) => left), eligible.length - observations.length),
    rightDistribution: distribution(observations.map(({ right }) => right), eligible.length - observations.length),
    meanDelta: deltas.length === 0 ? null : mean(deltas),
    confidenceInterval: bootstrapInterval(deltas, baseSeed, [...pairScope, metric]),
    winTieLoss: quality ? winTieLoss(deltas) : null
  }
}

function reliabilityMetric(
  tasks: readonly TaskPairComparisonV1[],
  baseSeed: number,
  pairScope: readonly string[]
): MetricComparisonV1 {
  const paired = tasks.flatMap(({ reliability }) => {
    if (reliability.left === null || reliability.right === null) return []

    return [{
      left: Number(reliability.left),
      right: Number(reliability.right),
      delta: reliability.delta!
    }]
  })

  const deltas = paired.map(({ delta }) => delta)
  const unknown = tasks.length - paired.length

  return {
    metric: 'end_to_end_reliability',
    pairedObservations: paired.length,
    taskClusters: paired.length,
    leftDistribution: distribution(paired.map(({ left }) => left), unknown),
    rightDistribution: distribution(paired.map(({ right }) => right), unknown),
    meanDelta: deltas.length === 0 ? null : mean(deltas),
    confidenceInterval: bootstrapInterval(deltas, baseSeed, [...pairScope, 'end_to_end_reliability']),
    winTieLoss: winTieLoss(deltas)
  }
}

function pairComparison(
  source: ExperimentComparisonSource,
  records: ReadonlyMap<string, ExperimentComparisonRunRecord>,
  leftArmId: string,
  rightArmId: string,
  baseSeed: number
): ArmPairComparisonV1 {
  const eligible = eligibleBlocks(source, records, leftArmId, rightArmId)

  const tasks = taskPairSummaries(
    source,
    eligible,
    records,
    leftArmId,
    rightArmId
  )

  const pairScope = [leftArmId, rightArmId]
  const metrics: MetricComparisonV1[] = []

  for (const metric of [...QUALITY_METRICS, ...OPERATIONAL_METRICS]) {
    metrics.push(summarizedMetric(eligible, tasks, metric, baseSeed, pairScope))
  }

  metrics.splice(QUALITY_METRICS.length, 0, reliabilityMetric(tasks, baseSeed, pairScope))

  return {
    leftArm: armReference(source.state.plan, leftArmId),
    rightArm: armReference(source.state.plan, rightArmId),
    eligibleBlocks: eligible.length,
    totalBlocks: source.state.blocks.length,
    tasks,
    metrics
  }
}

function uniqueRunStates(state: ExperimentState): ExperimentRunState[] {
  const selected = new Map<string, ExperimentRunState>()
  const blocks = [...state.blocks, ...state.excluded_blocks]

  for (const run of blocks.flatMap(({ runs }) => runs)) {
    const attemptId = run.assignment.attempt_id
    const previous = selected.get(attemptId)

    if (previous !== undefined) incompatible('Experiment history reuses an attempt identity')

    selected.set(attemptId, run)
  }

  return [...selected.values()]
}

function outcomeCounts(
  runs: readonly ExperimentRunState[],
  records: ReadonlyMap<string, ExperimentComparisonRunRecord>
): OutcomeCountV1[] {
  const counts = new Map<string, number>()

  for (const run of runs) {
    let outcome: string = run.status

    if (run.result !== null) {
      const record = recordForRun(records, run)

      outcome = record.regrade?.record.outcome.classification ??
        record.record.outcome.classification
    }

    counts.set(outcome, (counts.get(outcome) ?? 0) + 1)
  }

  return [...counts.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([outcome, count]) => ({
      outcome,
      count
    }))
}

function observedSummary(
  source: ExperimentComparisonSource,
  records: ReadonlyMap<string, ExperimentComparisonRunRecord>,
  armId: string
): ArmObservedSummaryV1 {
  const runs = uniqueRunStates(source.state).filter(({ assignment }) => assignment.arm_id === armId)

  const verified = runs.flatMap((run) => {
    if (run.result === null) return []

    return [recordForRun(records, run)]
  })

  const metrics: ObservedMetricV1[] = OPERATIONAL_METRICS.map((metric) => {
    const values = verified.map(({ record }) => operationalMetric(record, metric))
    const known = values.filter((value): value is number => value !== null)

    return {
      metric,
      distribution: distribution(known, values.length - known.length)
    }
  })

  return {
    arm: armReference(source.state.plan, armId),
    attempts: runs.length,
    outcomes: outcomeCounts(runs, records),
    metrics
  }
}

function omittedBlock(
  block: ExperimentBlockState,
  predecessor: boolean,
  records: ReadonlyMap<string, ExperimentComparisonRunRecord>
): OmittedBlockV1 {
  const reason = block.reason ?? (predecessor
    ? 'Predecessor block is excluded from the current plan'
    : `Current block is ${block.status}`)

  return {
    predecessor,
    blockId: block.block_id,
    taskId: block.task_id,
    replicate: block.replicate,
    status: block.status,
    cause: block.cause,
    reason,

    runs: block.runs.map((run) => {
      const record = run.result === null ? null : recordForRun(records, run)

      const classification = record?.regrade?.record.outcome.classification ??
        record?.record.outcome.classification ?? null

      return {
        armId: run.assignment.arm_id,
        runId: run.assignment.run_id,
        status: run.status,
        classification
      }
    })
  }
}

function migrationSummary(
  source: ExperimentComparisonSource
): ComparisonMigrationV1 | null {
  const migration = source.migration

  if (migration === undefined) return null

  const verifierSeconds = source.records.flatMap((record) => {
    const seconds = record.regrade?.record.timings.verifier_seconds

    return seconds === undefined ? [] : [seconds]
  })

  return {
    migrationId: migration.record.identity.migration_id,
    revision: migration.record.identity.revision,
    digest: migration.digest,
    providerCalls: migration.record.regrade_provider_calls,

    verifierSeconds: distribution(
      verifierSeconds,
      source.records.length - verifierSeconds.length
    ),

    targets: migration.record.targets.map((target) => ({
      taskId: target.task_id,
      sourceVerifierRevision: target.source_evaluator.verifier_revision,
      sourceVerifierImageDigest: target.source_evaluator.verifier_image_digest,

      sourceVerifierNetworkEnforcementSidecarDigest:
        target.source_evaluator.verifier_network_enforcement_sidecar_digest,

      targetVerifierRevision: target.target_evaluator.verifier_revision,
      targetVerifierImageDigest: target.target_evaluator.verifier_image_digest,

      targetVerifierNetworkEnforcementSidecarDigest:
        target.target_evaluator.verifier_network_enforcement_sidecar_digest,

      sourceScoringRevision: target.source_evaluator.scoring_revision,
      targetScoringRevision: target.target_evaluator.scoring_revision,
      sourceRubricRevision: target.source_evaluator.rubric_revision,
      targetRubricRevision: target.target_evaluator.rubric_revision
    }))
  }
}

export function analyzeExperimentComparison(
  source: ExperimentComparisonSource
): ExperimentComparisonAnalysisV1 {
  const plan = source.state.plan

  assertPlanCompatibility(plan, source.state.superseded)

  const recordsByRunId = validateAndIndexRunRecords(source)
  const armIds = plan.experiment.arms.map(({ arm_id }) => arm_id).sort(compareText)
  const seed = uint32Hash(['paired-analysis-v1', plan.experiment.plan_digest, plan.experiment.analysis_revision])
  const pairs: ArmPairComparisonV1[] = []
  const migration = migrationSummary(source)

  for (const [leftIndex, leftArm] of armIds.entries()) {
    for (const rightArm of armIds.slice(leftIndex + 1)) {
      pairs.push(pairComparison(source, recordsByRunId, leftArm, rightArm, seed))
    }
  }

  const currentOmissions = source.state.blocks
    .filter(({ status }) => status !== 'completed')
    .map((block) => omittedBlock(block, false, recordsByRunId))

  const predecessorOmissions = source.state.excluded_blocks.map((block) =>
    omittedBlock(block, true, recordsByRunId)
  )

  return {
    experimentId: plan.experiment.experiment_id,
    experimentRevision: plan.experiment.revision,
    planDigest: plan.experiment.plan_digest,
    suiteId: plan.experiment.suite.id,
    suiteRevision: plan.experiment.suite.revision,
    analysisRevision: ANALYSIS_REVISION,
    migration,

    bootstrap: {
      seed,
      resamples: BOOTSTRAP_RESAMPLES,
      confidence: BOOTSTRAP_CONFIDENCE,
      intervalMethod: 'percentile_type_7',
      cluster: 'task',
      tieRule: 'exact_zero',
      generator: 'mulberry32'
    },

    observed: armIds.map((armId) => observedSummary(source, recordsByRunId, armId)),
    omittedBlocks: [...currentOmissions, ...predecessorOmissions],
    pairs,

    limitations: [
      'Descriptive evidence for this frozen suite only; not a universal ranking or precise significance claim.',
      'Provider-hidden identity changes remain unknown when the provider identity is unavailable.',
      'Subscription monetary cost is not applicable; token usage is not converted into spend.',
      ...(migration === null
        ? []
        : ['Migrated quality uses the new verifier; operational metrics remain from the immutable source run.'])
    ]
  }
}
