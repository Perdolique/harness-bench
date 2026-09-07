import type {
  ArmReferenceV1,
  ComparisonMetricName,
  DistributionSummaryV1,
  ExperimentComparisonAnalysisV1,
  MetricComparisonV1,
  TaskPairComparisonV1
} from '@harness-bench/statistics'

import { OPERATIONAL_METRICS, QUALITY_METRICS } from '@harness-bench/statistics'

const QUALITY_SUMMARY_METRICS = new Set<ComparisonMetricName>([
  ...QUALITY_METRICS,
  'end_to_end_reliability'
])

const OPERATIONAL_SUMMARY_METRICS = new Set<ComparisonMetricName>(OPERATIONAL_METRICS)

function text(value: string): string {
  const serialized = JSON.stringify(value)
  const unquoted = serialized.slice(1, -1)

  return unquoted.replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (character) => {
    const hex = character.charCodeAt(0).toString(16).padStart(4, '0')

    return `\\u${hex}`
  })
}

function number(value: number | null): string {
  return value === null ? 'unavailable' : value.toFixed(3)
}

function delta(value: number | null): string {
  if (value === null) return 'unavailable'

  const prefix = value > 0 ? '+' : ''

  return `${prefix}${value.toFixed(3)}`
}

function distribution(value: DistributionSummaryV1): string {
  const coverage = `known ${value.knownCount}, unknown ${value.unknownCount}`

  if (value.knownCount === 0) return `${coverage}; unavailable`

  return `${coverage}; mean ${number(value.mean)}, min ${number(value.minimum)}, Q1 ${number(value.firstQuartile)}, median ${number(value.median)}, Q3 ${number(value.thirdQuartile)}, max ${number(value.maximum)}`
}

function arm(value: ArmReferenceV1): string {
  return `${text(value.armId)} (${text(value.treatment)}; ${text(value.harnessId)}@${text(value.harnessRevision)} ${value.harnessDigest})`
}

function renderMetric(lines: string[], metric: MetricComparisonV1): void {
  const interval = metric.confidenceInterval === null
    ? 'unavailable'
    : `[${number(metric.confidenceInterval.lower)}, ${number(metric.confidenceInterval.upper)}]`

  lines.push(`  ${metric.metric}: paired ${metric.pairedObservations}, task clusters ${metric.taskClusters}`)
  lines.push(`    left distribution: ${distribution(metric.leftDistribution)}`)
  lines.push(`    right distribution: ${distribution(metric.rightDistribution)}`)
  lines.push(`    task-weighted delta: ${delta(metric.meanDelta)}; 95% CI: ${interval}`)

  if (metric.winTieLoss !== null) {
    const counts = metric.winTieLoss

    lines.push(`    right vs left W/T/L: ${counts.wins}/${counts.ties}/${counts.losses}`)
  }
}

function taskMetric(task: TaskPairComparisonV1, name: ComparisonMetricName): string {
  const metric = task.metrics.find(({ metric: candidate }) => candidate === name)

  if (metric === undefined) return `${name}: unavailable`

  return `${name}: left ${number(metric.leftMean)}, right ${number(metric.rightMean)}, delta ${delta(metric.delta)}, paired ${metric.pairedObservations}`
}

function reliability(value: boolean | null): string {
  return value === null ? 'unknown' : String(value)
}

export function renderExperimentComparisonReport(
  analysis: ExperimentComparisonAnalysisV1
): string {
  const lines = [
    'Experiment comparison',
    `  Experiment: ${text(analysis.experimentId)} revision ${text(analysis.experimentRevision)}`,
    `  Plan digest: ${analysis.planDigest}`,
    `  Suite: ${text(analysis.suiteId)} revision ${text(analysis.suiteRevision)}`,
    `  Analysis revision: ${analysis.analysisRevision}`,
    '  Direction: right - left; all unordered arm pairs use lexical arm order',
    '',
    'Method',
    `  Bootstrap: ${analysis.bootstrap.resamples} task-cluster resamples, seed ${analysis.bootstrap.seed}, generator ${analysis.bootstrap.generator}`,
    `  Interval: ${(analysis.bootstrap.confidence * 100).toFixed(0)}% ${analysis.bootstrap.intervalMethod}`,
    `  Tie rule: ${analysis.bootstrap.tieRule}`,
    '  Small-sample warning: intervals may be wide or degenerate; inspect the task-cluster count.',
    '',
    'Observed attempts'
  ]

  for (const observed of analysis.observed) {
    lines.push(`  Arm ${arm(observed.arm)}`)
    lines.push(`    Attempts in current and predecessor history: ${observed.attempts}`)

    const outcomes = observed.outcomes.map(({ outcome, count }) => `${text(outcome)}=${count}`).join(', ')

    lines.push(`    Outcomes: ${outcomes || 'none'}`)

    for (const metric of observed.metrics) {
      lines.push(`    ${metric.metric}: ${distribution(metric.distribution)}`)
    }
  }

  lines.push('', 'Omitted blocks')

  if (analysis.omittedBlocks.length === 0) lines.push('  none')

  for (const block of analysis.omittedBlocks) {
    const provenance = block.predecessor ? 'predecessor' : 'current'
    const cause = block.cause ?? block.status

    lines.push(`  ${text(block.blockId)}: ${provenance}, task ${text(block.taskId)}, replicate ${block.replicate}, ${text(cause)}`)
    lines.push(`    Reason: ${text(block.reason)}`)

    for (const run of block.runs) {
      const classification = run.classification ?? 'unavailable'

      lines.push(`    ${text(run.armId)}: status ${text(run.status)}, classification ${text(classification)} | ${text(run.runId)}`)
    }
  }

  for (const pair of analysis.pairs) {
    lines.push('', `Pair ${text(pair.leftArm.armId)} -> ${text(pair.rightArm.armId)}`)
    lines.push(`  Left: ${arm(pair.leftArm)}`)
    lines.push(`  Right: ${arm(pair.rightArm)}`)
    lines.push(`  Eligible quality blocks: ${pair.eligibleBlocks}/${pair.totalBlocks}`)
    lines.push('  Per-task paired deltas')

    for (const task of pair.tasks) {
      lines.push(`    ${text(task.taskId)}: eligible repeats ${task.eligibleReplicates}/${task.requestedReplicates}`)

      for (const name of QUALITY_METRICS) {
        lines.push(`      ${taskMetric(task, name)}`)
      }

      const taskReliability = task.reliability

      lines.push(`      end_to_end_reliability: left ${reliability(taskReliability.left)}, right ${reliability(taskReliability.right)}, delta ${delta(taskReliability.delta)}`)

      for (const name of OPERATIONAL_METRICS) {
        lines.push(`      ${taskMetric(task, name)}`)
      }
    }

    lines.push('  Quality and reliability summaries')

    for (const metric of pair.metrics) {
      if (QUALITY_SUMMARY_METRICS.has(metric.metric)) renderMetric(lines, metric)
    }

    lines.push('  Paired timing and usage summaries')

    for (const metric of pair.metrics) {
      if (OPERATIONAL_SUMMARY_METRICS.has(metric.metric)) renderMetric(lines, metric)
    }

    lines.push('  Subscription money: not applicable; token usage is not converted into spend')
  }

  lines.push('', 'Limitations')

  for (const limitation of analysis.limitations) lines.push(`  ${text(limitation)}`)

  return `${lines.join('\n')}\n`
}
