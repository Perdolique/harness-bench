import { describe, expect, it } from 'vitest'

import type {
  ArmPairComparisonV1,
  ArmReferenceV1,
  ComparisonMetricName,
  ExperimentComparisonAnalysisV1,
  MetricComparisonV1
} from '@harness-bench/statistics'

import { OPERATIONAL_METRICS, QUALITY_METRICS } from '@harness-bench/statistics'
import { renderExperimentComparisonReport } from '../src/comparison.ts'

const digest = `sha256:${'a'.repeat(64)}`

function arm(armId: string, treatment = `Treatment ${armId}`): ArmReferenceV1 {
  return {
    armId,
    treatment,
    harnessId: `harness-${armId}`,
    harnessRevision: '1',
    harnessDigest: digest
  }
}

function metric(metricName: ComparisonMetricName, winTieLoss = false): MetricComparisonV1 {
  const distribution = {
    knownCount: 2,
    unknownCount: 0,
    mean: 0.5,
    minimum: 0,
    firstQuartile: 0.25,
    median: 0.5,
    thirdQuartile: 0.75,
    maximum: 1
  }

  return {
    metric: metricName,
    pairedObservations: 2,
    taskClusters: 1,
    leftDistribution: distribution,
    rightDistribution: distribution,
    meanDelta: 0,

    confidenceInterval: {
      lower: 0,
      upper: 0
    },

    winTieLoss: winTieLoss ? {
      wins: 0,
      ties: 1,
      losses: 0
    } : null
  }
}

function pair(leftArm: string, rightArm: string): ArmPairComparisonV1 {
  const qualityNames = [
    ...QUALITY_METRICS,
    'end_to_end_reliability'
  ] as const

  const taskMetricNames = [...QUALITY_METRICS, ...OPERATIONAL_METRICS]

  return {
    leftArm: arm(leftArm),
    rightArm: arm(rightArm),
    eligibleBlocks: 2,
    totalBlocks: 3,

    tasks: [{
      taskId: 'task-a',
      eligibleReplicates: 2,
      requestedReplicates: 3,

      metrics: taskMetricNames.map((name, index) => ({
        metric: name,
        pairedObservations: 2,
        leftMean: index,
        rightMean: index + 0.5,
        delta: 0.5
      })),

      reliability: {
        left: true,
        right: false,
        delta: -1
      }
    }],

    metrics: [
      ...qualityNames.map((name) => metric(name, true)),
      ...OPERATIONAL_METRICS.map((name) => metric(name))
    ]
  }
}

function analysis(armIds: readonly string[]): ExperimentComparisonAnalysisV1 {
  const arms = armIds.map((armId) => arm(armId))
  const pairs: ArmPairComparisonV1[] = []

  for (const [leftIndex, left] of armIds.entries()) {
    for (const right of armIds.slice(leftIndex + 1)) pairs.push(pair(left, right))
  }

  return {
    experimentId: 'experiment-a',
    experimentRevision: '1',
    planDigest: digest,
    suiteId: 'suite-a',
    suiteRevision: '1',
    analysisRevision: '1',

    bootstrap: {
      seed: 42,
      resamples: 10_000,
      confidence: 0.95,
      intervalMethod: 'percentile_type_7',
      cluster: 'task',
      tieRule: 'exact_zero',
      generator: 'mulberry32'
    },

    observed: arms.map((selected) => ({
      arm: selected,
      attempts: 3,

      outcomes: [{
        outcome: 'task_success',
        count: 2
      }, {
        outcome: 'infrastructure_failure',
        count: 1
      }],

      metrics: OPERATIONAL_METRICS.map((metricName) => ({
        metric: metricName,

        distribution: {
          knownCount: 3,
          unknownCount: 0,
          mean: 20,
          minimum: 10,
          firstQuartile: 15,
          median: 20,
          thirdQuartile: 25,
          maximum: 30
        }
      }))
    })),

    omittedBlocks: [{
      predecessor: false,
      blockId: 'block-bad',
      taskId: 'task-a',
      replicate: 3,
      status: 'invalidated',
      cause: 'incomplete',
      reason: 'Runner failed\u202e concealed',

      runs: [{
        armId: armIds[0]!,
        runId: 'run-bad',
        status: 'verified',
        classification: 'infrastructure_failure'
      }]
    }, {
      predecessor: true,
      blockId: 'block-old',
      taskId: 'task-a',
      replicate: 1,
      status: 'invalidated',
      cause: 'provider_changed',
      reason: 'Known provider identity changed',

      runs: [{
        armId: armIds[0]!,
        runId: 'run-old',
        status: 'verified',
        classification: 'provider_failure'
      }]
    }],

    pairs,

    limitations: [
      'Descriptive evidence for this frozen suite only; not a universal ranking or precise significance claim.'
    ]
  }
}

describe(renderExperimentComparisonReport, () => {
  it('snapshots the two-arm comparison structure without turning failures into quality zeroes', () => {
    const report = renderExperimentComparisonReport(analysis(['a', 'b']))

    expect(report).toMatchInlineSnapshot(`
      "Experiment comparison
        Experiment: experiment-a revision 1
        Plan digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        Suite: suite-a revision 1
        Analysis revision: 1
        Direction: right - left; all unordered arm pairs use lexical arm order
        Evaluation: original verifier and scoring identities

      Method
        Bootstrap: 10000 task-cluster resamples, seed 42, generator mulberry32
        Interval: 95% percentile_type_7
        Tie rule: exact_zero
        Small-sample warning: intervals may be wide or degenerate; inspect the task-cluster count.

      Observed attempts
        Arm a (Treatment a; harness-a@1 sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
          Attempts in current and predecessor history: 3
          Outcomes: task_success=2, infrastructure_failure=1
          total_seconds: known 3, unknown 0; mean 20.000, min 10.000, Q1 15.000, median 20.000, Q3 25.000, max 30.000
          agent_seconds: known 3, unknown 0; mean 20.000, min 10.000, Q1 15.000, median 20.000, Q3 25.000, max 30.000
          verifier_seconds: known 3, unknown 0; mean 20.000, min 10.000, Q1 15.000, median 20.000, Q3 25.000, max 30.000
          input_tokens: known 3, unknown 0; mean 20.000, min 10.000, Q1 15.000, median 20.000, Q3 25.000, max 30.000
          output_tokens: known 3, unknown 0; mean 20.000, min 10.000, Q1 15.000, median 20.000, Q3 25.000, max 30.000
        Arm b (Treatment b; harness-b@1 sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
          Attempts in current and predecessor history: 3
          Outcomes: task_success=2, infrastructure_failure=1
          total_seconds: known 3, unknown 0; mean 20.000, min 10.000, Q1 15.000, median 20.000, Q3 25.000, max 30.000
          agent_seconds: known 3, unknown 0; mean 20.000, min 10.000, Q1 15.000, median 20.000, Q3 25.000, max 30.000
          verifier_seconds: known 3, unknown 0; mean 20.000, min 10.000, Q1 15.000, median 20.000, Q3 25.000, max 30.000
          input_tokens: known 3, unknown 0; mean 20.000, min 10.000, Q1 15.000, median 20.000, Q3 25.000, max 30.000
          output_tokens: known 3, unknown 0; mean 20.000, min 10.000, Q1 15.000, median 20.000, Q3 25.000, max 30.000

      Omitted blocks
        block-bad: current, task task-a, replicate 3, incomplete
          Reason: Runner failed\\u202e concealed
          a: status verified, classification infrastructure_failure | run-bad
        block-old: predecessor, task task-a, replicate 1, provider_changed
          Reason: Known provider identity changed
          a: status verified, classification provider_failure | run-old

      Pair a -> b
        Left: a (Treatment a; harness-a@1 sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
        Right: b (Treatment b; harness-b@1 sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
        Eligible quality blocks: 2/3
        Per-task paired deltas
          task-a: eligible repeats 2/3
            pass_rate: left 0.000, right 0.500, delta +0.500, paired 2
            direct_behavior: left 1.000, right 1.500, delta +0.500, paired 2
            repository_contracts: left 2.000, right 2.500, delta +0.500, paired 2
            regression: left 3.000, right 3.500, delta +0.500, paired 2
            scope_integrity: left 4.000, right 4.500, delta +0.500, paired 2
            maintainability: left 5.000, right 5.500, delta +0.500, paired 2
            composite: left 6.000, right 6.500, delta +0.500, paired 2
            end_to_end_reliability: left true, right false, delta -1.000
            total_seconds: left 7.000, right 7.500, delta +0.500, paired 2
            agent_seconds: left 8.000, right 8.500, delta +0.500, paired 2
            verifier_seconds: left 9.000, right 9.500, delta +0.500, paired 2
            input_tokens: left 10.000, right 10.500, delta +0.500, paired 2
            output_tokens: left 11.000, right 11.500, delta +0.500, paired 2
        Quality and reliability summaries
        pass_rate: paired 2, task clusters 1
          left distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          right distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          task-weighted delta: 0.000; 95% CI: [0.000, 0.000]
          right vs left W/T/L: 0/1/0
        direct_behavior: paired 2, task clusters 1
          left distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          right distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          task-weighted delta: 0.000; 95% CI: [0.000, 0.000]
          right vs left W/T/L: 0/1/0
        repository_contracts: paired 2, task clusters 1
          left distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          right distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          task-weighted delta: 0.000; 95% CI: [0.000, 0.000]
          right vs left W/T/L: 0/1/0
        regression: paired 2, task clusters 1
          left distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          right distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          task-weighted delta: 0.000; 95% CI: [0.000, 0.000]
          right vs left W/T/L: 0/1/0
        scope_integrity: paired 2, task clusters 1
          left distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          right distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          task-weighted delta: 0.000; 95% CI: [0.000, 0.000]
          right vs left W/T/L: 0/1/0
        maintainability: paired 2, task clusters 1
          left distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          right distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          task-weighted delta: 0.000; 95% CI: [0.000, 0.000]
          right vs left W/T/L: 0/1/0
        composite: paired 2, task clusters 1
          left distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          right distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          task-weighted delta: 0.000; 95% CI: [0.000, 0.000]
          right vs left W/T/L: 0/1/0
        end_to_end_reliability: paired 2, task clusters 1
          left distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          right distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          task-weighted delta: 0.000; 95% CI: [0.000, 0.000]
          right vs left W/T/L: 0/1/0
        Paired timing and usage summaries
        total_seconds: paired 2, task clusters 1
          left distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          right distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          task-weighted delta: 0.000; 95% CI: [0.000, 0.000]
        agent_seconds: paired 2, task clusters 1
          left distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          right distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          task-weighted delta: 0.000; 95% CI: [0.000, 0.000]
        verifier_seconds: paired 2, task clusters 1
          left distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          right distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          task-weighted delta: 0.000; 95% CI: [0.000, 0.000]
        input_tokens: paired 2, task clusters 1
          left distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          right distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          task-weighted delta: 0.000; 95% CI: [0.000, 0.000]
        output_tokens: paired 2, task clusters 1
          left distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          right distribution: known 2, unknown 0; mean 0.500, min 0.000, Q1 0.250, median 0.500, Q3 0.750, max 1.000
          task-weighted delta: 0.000; 95% CI: [0.000, 0.000]
        Subscription money: not applicable; token usage is not converted into spend

      Limitations
        Descriptive evidence for this frozen suite only; not a universal ranking or precise significance claim.
      "
    `)

    expect(report).toContain('infrastructure_failure')
    expect(report).not.toContain('infrastructure_failure: 0.000')
    expect(report).toContain('output_tokens: left 11.000, right 11.500, delta +0.500, paired 2')
  })

  it('renders every three-arm pair and visibly escapes directional controls', () => {
    const input = analysis(['a', 'b', 'c'])

    Object.assign(input.observed[0]!.arm, { treatment: 'Treatment\u202e hidden\u001b[31m\u009b31m' })

    const report = renderExperimentComparisonReport(input)

    expect(report.match(/^Pair .+$/gm)).toStrictEqual([
      'Pair a -> b',
      'Pair a -> c',
      'Pair b -> c'
    ])

    expect(report).toContain('Treatment\\u202e hidden\\u001b[31m\\u009b31m')
    expect(report).toContain('Runner failed\\u202e concealed')
    expect(report).not.toContain('\u001B[')
    expect(report).not.toContain('\u009B')
  })

  it('renders explicit scoring migration provenance and separate verifier time', () => {
    const input = analysis(['a', 'b'])

    Object.assign(input, { migration: {
      migrationId: 'scoring-v2',
      revision: '2',
      digest: `sha256:${'b'.repeat(64)}`,
      providerCalls: 0,

      verifierSeconds: {
        knownCount: 2,
        unknownCount: 0,
        mean: 8,
        minimum: 7,
        firstQuartile: 7.5,
        median: 8,
        thirdQuartile: 8.5,
        maximum: 9
      },

      targets: [{
        taskId: 'task-a',
        sourceVerifierRevision: '1',
        sourceVerifierImageDigest: `sha256:${'c'.repeat(64)}`,
        targetVerifierRevision: '2',
        targetVerifierImageDigest: `sha256:${'d'.repeat(64)}`,
        sourceScoringRevision: '1',
        targetScoringRevision: '2',
        sourceRubricRevision: '1',
        targetRubricRevision: '2'
      }]
    } })

    const report = renderExperimentComparisonReport(input)

    expect(report).toContain(
      `Migration: scoring-v2 revision 2 sha256:${'b'.repeat(64)}`
    )

    expect(report).toContain('Regrade provider calls: 0')
    expect(report).toContain('Regrade verifier seconds: known 2, unknown 0; mean 8.000')

    expect(report).toContain(
      `Task task-a evaluator: verifier 1 sha256:${'c'.repeat(64)} -> 2 sha256:${'d'.repeat(64)}, scoring 1 -> 2, rubric 1 -> 2`
    )

    expect(report).toContain('Operational metrics: immutable source run values')
  })

  it('groups pair summaries by metric semantics instead of array position', () => {
    const input = analysis(['a', 'b'])
    const pair = input.pairs[0]!
    const pass = pair.metrics.find(({ metric: name }) => name === 'pass_rate')!
    const reliability = pair.metrics.find(({ metric: name }) => name === 'end_to_end_reliability')!
    const outputTokens = pair.metrics.find(({ metric: name }) => name === 'output_tokens')!

    Object.assign(pair, {
      metrics: [outputTokens, reliability, pass]
    })

    const report = renderExperimentComparisonReport(input)
    const qualityHeading = report.indexOf('  Quality and reliability summaries')
    const passLine = report.indexOf('  pass_rate: paired')
    const reliabilityLine = report.indexOf('  end_to_end_reliability: paired')
    const operationalHeading = report.indexOf('  Paired timing and usage summaries')
    const outputLine = report.indexOf('  output_tokens: paired')

    expect(qualityHeading).toBeLessThan(reliabilityLine)
    expect(reliabilityLine).toBeLessThan(passLine)
    expect(passLine).toBeLessThan(operationalHeading)
    expect(operationalHeading).toBeLessThan(outputLine)
  })
})
