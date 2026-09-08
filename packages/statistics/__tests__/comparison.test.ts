import { describe, expect, it } from 'vitest'

import type {
  ExperimentComparisonSource,
  ExperimentComparisonRunRecord,
  NormalizedRunRecordV1,
  ReadNormalizedRunRecordResult
} from '@harness-bench/results'

import {
  BOOTSTRAP_RESAMPLES,
  OPERATIONAL_METRICS,
  QUALITY_METRICS,
  StatisticsError,
  analyzeExperimentComparison
} from '../src/index.ts'

const sha = (character: string): string => `sha256:${character.repeat(64)}`

const budget = {
  wall_clock_seconds: 600,

  token_or_turn_limit: {
    status: 'unknown' as const,
    reason: 'Subscription execution has no enforceable token limit'
  },

  cpu_count: 2,
  cpu_enforcement_status: 'enforced' as const,
  memory_megabytes: 2048,
  memory_enforcement_status: 'enforced' as const
}

function migratedRecord(
  source: ExperimentComparisonSource,
  armId: string,
  value: number,
  classification: 'task_success' | 'task_failure',
  verifierSeconds: number
): void {
  const selected = record(source, 'task-1', 1, armId)
  const originalScore = selected.record.score

  if (originalScore.status !== 'known') throw new Error('Expected score')

  const migratedScore = structuredClone(originalScore.document)

  migratedScore.scoring_revision = 'scoring-2'
  migratedScore.rubric_revision = 'rubric-2'
  migratedScore.composite = {
    status: 'value',
    value
  }

  Object.assign(selected as ExperimentComparisonRunRecord, {
    regrade: {
      record: {
        target: {
          evaluator: {
            verifier_revision: 'verifier-2',
            verifier_image_digest: sha('w'),

            verifier_network_enforcement_sidecar_digest: {
              status: 'not_applicable',
              reason: 'Docker network mode is none'
            },

            scoring_revision: 'scoring-2',
            rubric_revision: 'rubric-2'
          }
        },

        outcome: {
          classification,
          valid_grade: true
        },

        score: migratedScore,

        timings: {
          verifier_seconds: verifierSeconds
        }
      }
    }
  })
}

interface FixtureOptions {
  readonly arms?: readonly string[];
  readonly repeats?: number;
  readonly taskIds?: readonly string[];
  readonly tasks?: number;
}

function stack(armId: string) {
  return {
    document_type: 'stack',
    schema_version: 1,
    stack_id: `stack-${armId}`,
    revision: '1',
    digest: sha(armId),

    agent: {
      product: 'codex',
      cli_version: '0.153.2',
      requested_model: 'gpt-5.6-luna',

      observed_provider_identity: {
        status: 'unknown',
        reason: 'Provider identity unavailable'
      },

      effort: 'low',

      auth: {
        mode: 'chatgpt_subscription',
        credential_store: 'file'
      }
    },

    runner: {
      name: 'harbor',
      version: '0.22.0',
      config_digest: sha('r'),

      telemetry: {
        requested: 'off',
        effective: 'off',
        owner_opt_in: false
      },

      concurrency: {
        requested: 1,

        effective: {
          status: 'known',
          value: 1
        },

        enforcement_status: 'enforced'
      }
    },

    harness: {
      id: `harness-${armId}`,
      revision: '1',
      digest: sha(armId.toUpperCase())
    },

    environment: {
      id: 'macos-arm64-docker',
      revision: '1',
      digest: sha('e')
    },

    network_policy: {
      revision: '1',
      digest: sha('n'),
      mode: 'public_unrestricted_agent'
    },

    effective_permissions_digest: sha('p'),
    mcp_tools_digest: sha('m'),
    budget: structuredClone(budget)
  }
}

function score(runId: string, value: number) {
  const facet = {
    status: 'value',
    value,

    evidence: [{
      check_id: 'check',
      outcome: 'passed',
      evidence_digest: sha('1')
    }]
  }

  return {
    document_type: 'score',
    schema_version: 1,
    score_id: `${runId}-score`,
    run_id: runId,
    verifier_result_digest: sha('v'),
    scoring_revision: 'scoring-1',
    rubric_revision: 'rubric-1',
    valid_grade: true,

    gates: {
      direct_behavior_pass: true,
      regression_pass: true,
      verifier_integrity_pass: true
    },

    facets: {
      direct_behavior: structuredClone(facet),
      repository_contracts: structuredClone(facet),
      regression: structuredClone(facet),
      scope_integrity: structuredClone(facet),
      maintainability: structuredClone(facet)
    },

    scope_violations: [],

    harbor_reward: {
      status: 'retained_upstream',
      numeric_values: {}
    },

    composite: {
      status: 'value',
      value
    }
  }
}

function normalizedRecord(
  taskId: string,
  replicate: number,
  armId: string,
  value: number
): NormalizedRunRecordV1 {
  const runId = `run-${taskId}-${replicate}-${armId}`

  return {
    document_type: 'normalized_run',
    schema_version: 1,
    normalization_revision: '1',
    record_type: 'normalized',
    created_at: '2026-09-07T12:00:00.000Z',

    identities: {
      benchmark_repo_commit: '1'.repeat(40),

      run: {
        run_id: runId,
        attempt_id: `${runId}-attempt-1`,
        attempt: 1
      },

      stack: {
        id: `stack-${armId}`,
        revision: '1',
        digest: sha(armId)
      },

      suite: {
        id: 'suite-a',
        revision: '1',
        digest: sha('s')
      },

      task: {
        id: taskId,
        revision: '1',
        base_commit: 'a'.repeat(40),
        source_digest: sha('t'),
        environment_image_digest: sha('i')
      },

      harness: {
        id: `harness-${armId}`,
        revision: '1',
        digest: sha(armId.toUpperCase())
      },

      experiment: {
        experiment_id: 'experiment-a',
        experiment_revision: '1',
        plan_digest: sha('d'),
        arm_id: armId,
        block_id: `block-${taskId}-${replicate}`,
        replicate
      },

      agent: {
        product: 'codex',
        cli_version: '0.153.2',
        requested_model: 'gpt-5.6-luna',

        observed_provider_identity: {
          status: 'unknown',
          reason: 'Provider identity is hidden'
        },

        effort: 'low',
        auth_mode: 'chatgpt_subscription'
      },

      network_policy_digest: sha('n'),
      effective_permissions_digest: sha('p'),
      mcp_tools_digest: sha('m'),

      host: {
        os: 'macos',
        os_version: '15.6',
        architecture: 'arm64',
        apple_silicon_model: 'Apple M4',
        docker_desktop_version: '4.50.0',
        docker_engine_version: '28.0.0',
        linuxkit_kernel: '6.10.0-linuxkit',
        container_architecture: 'linux/arm64'
      }
    },

    revisions: {
      runner_name: 'harbor',
      runner_version: '0.22.0',
      runner_config_digest: sha('r'),
      collector_revision: 'collector-1',
      collector_image_digest: sha('c'),
      verifier_revision: 'verifier-1',
      verifier_image_digest: sha('v'),

      verifier_network_enforcement_sidecar_digest: {
        status: 'not_applicable',
        reason: 'Docker network mode is none'
      },

      scoring_revision: 'scoring-1'
    },

    source_digests: {
      initial_record: sha('1'),
      completion_record: sha('2'),
      raw_manifest: sha('3')
    },

    outcome: {
      classification: 'task_success',
      termination: { kind: 'success' },
      valid_grade: true
    },

    score: {
      status: 'known',
      document: score(runId, value)
    },

    timings: {
      total_seconds: replicate * 10,

      agent_seconds: {
        status: 'known',
        value: replicate * 4
      },

      verifier_seconds: {
        status: 'known',
        value: replicate
      }
    },

    usage: {
      input_tokens: {
        status: 'known',
        value: replicate * 100
      },

      output_tokens: {
        status: 'known',
        value: replicate * 20
      },

      subscription_money: {
        status: 'not_applicable',
        reason: 'Subscription money is not derived from tokens'
      },

      upstream_api_price_estimate: {
        status: 'unknown',
        reason: 'No estimate'
      }
    },

    retention: {
      classification: 'public',

      expires_at: {
        status: 'not_applicable',
        reason: 'Public fixture'
      }
    },

    evidence_availability: {
      native_rollout: 'available',
      atif_trajectory: 'available',
      merged_agent_output: 'available'
    },

    references: [],
    merged_output_semantics: 'irreversibly_merged_stdout_stderr'
  } as NormalizedRunRecordV1
}

function comparisonFixture(options: FixtureOptions = {}): ExperimentComparisonSource {
  const armIds = options.arms ?? ['a', 'b']
  const repeats = options.repeats ?? 1
  const stacks = armIds.map(stack)
  const taskCount = options.tasks ?? 1
  const taskIds = options.taskIds ?? Array.from({ length: taskCount }, (_value, index) => `task-${index + 1}`)
  const records: ReadNormalizedRunRecordResult[] = []
  const blocks = []

  for (const taskId of taskIds) {
    for (let replicate = 1; replicate <= repeats; replicate += 1) {
      const runs = armIds.map((armId) => {
        const record = normalizedRecord(taskId, replicate, armId, 0)
        const runId = record.identities.run.run_id
        const selectedStack = stacks.find(({ stack_id }) => stack_id === `stack-${armId}`)!

        const initialRecord = {
          identity: record.identities.run,
          stack: record.identities.stack,
          suite: record.identities.suite,
          task: record.identities.task,
          harness: record.identities.harness,
          benchmark_repo_commit: record.identities.benchmark_repo_commit,
          budget: structuredClone(budget),
          network_policy_digest: record.identities.network_policy_digest,
          effective_permissions_digest: record.identities.effective_permissions_digest,
          mcp_tools_digest: record.identities.mcp_tools_digest,

          collector: {
            revision: record.revisions.collector_revision,
            image_digest: record.revisions.collector_image_digest
          },

          verifier: {
            revision: record.revisions.verifier_revision,
            image_digest: record.revisions.verifier_image_digest,
            network_enforcement_sidecar_digest: record.revisions.verifier_network_enforcement_sidecar_digest
          },

          scoring_revision: record.revisions.scoring_revision,

          runner: {
            name: selectedStack.runner.name,
            version: selectedStack.runner.version,
            config_digest: selectedStack.runner.config_digest,
            telemetry: selectedStack.runner.telemetry.effective,
            requested_concurrency: selectedStack.runner.concurrency.requested,
            effective_concurrency: selectedStack.runner.concurrency.effective,
            concurrency_enforcement_status: selectedStack.runner.concurrency.enforcement_status
          },

          agent: {
            product: selectedStack.agent.product,
            cli_version: selectedStack.agent.cli_version,
            requested_model: selectedStack.agent.requested_model,
            observed_provider_identity: selectedStack.agent.observed_provider_identity,
            effort: selectedStack.agent.effort,
            auth_mode: selectedStack.agent.auth.mode
          }
        }

        records.push({
          completionRecord: {
            identity: record.identities.run
          } as ReadNormalizedRunRecordResult['completionRecord'],

          digest: sha('z'),
          initialRecord: initialRecord as ReadNormalizedRunRecordResult['initialRecord'],
          record,
          recordPath: `/runs/${runId}/record.json`,
          runDirectory: `/runs/${runId}`,
          rawManifestPath: `/runs/${runId}/raw-manifest.json`,
          verifierLogPaths: [],
          resolvedReferences: []
        })

        return {
          assignment: {
            block_id: record.identities.experiment.block_id,
            arm_id: armId,
            run_id: runId,
            attempt_id: `${runId}-attempt-1`,
            attempt: 1,
            origin_plan: null
          },

          status: 'verified' as const,
          started_at: '2026-09-07T12:00:00.000Z',

          result: {
            classification: 'task_success',
            valid_grade: true,
            completed_at: '2026-09-07T12:00:10.000Z',
            normalized_digest: sha('z'),
            normalized_path: `/runs/${runId}/record.json`,
            observed_provider: null
          }
        }
      })

      blocks.push({
        block_id: `block-${taskId}-${replicate}`,
        task_id: taskId,
        replicate,
        first_started_at: '2026-09-07T12:00:00.000Z',
        deadline_at: '2026-09-08T12:00:00.000Z',
        completed_at: '2026-09-07T12:00:10.000Z',
        status: 'completed' as const,
        cause: null,
        reason: null,
        runs
      })
    }
  }

  const arms = stacks.map((selectedStack) => ({
    arm_id: selectedStack.stack_id.slice('stack-'.length),

    stack: {
      id: selectedStack.stack_id,
      revision: selectedStack.revision,
      digest: selectedStack.digest
    },

    harness: selectedStack.harness,
    treatment: `Treatment ${selectedStack.stack_id}`
  }))

  const experimentTasks = taskIds.map((taskId) => ({
    task_id: taskId,
    revision: '1',
    source_digest: sha('t')
  }))

  const plan = {
    definition: {
      analysis_revision: '1'
    },

    experiment: {
      experiment_id: 'experiment-a',
      revision: '1',
      plan_digest: sha('d'),
      analysis_revision: '1',

      suite: {
        id: 'suite-a',
        revision: '1',
        digest: sha('s')
      },

      arms,
      tasks: experimentTasks,
      repeats,
      budget: structuredClone(budget)
    },

    stacks
  }

  return {
    records,

    state: {
      plan: plan as ExperimentComparisonSource['state']['plan'],
      blocks: blocks as ExperimentComparisonSource['state']['blocks'],
      excluded_blocks: [],
      superseded: false
    }
  }
}

function record(
  source: ExperimentComparisonSource,
  taskId: string,
  replicate: number,
  armId: string
): ReadNormalizedRunRecordResult {
  const runId = `run-${taskId}-${replicate}-${armId}`
  const selected = source.records.find((entry) => entry.record.identities.run.run_id === runId)

  if (selected === undefined) throw new Error(`Missing fixture record ${runId}`)

  return selected
}

function composite(source: ExperimentComparisonSource, taskId: string, armId: string, value: number): void {
  for (let replicate = 1; replicate <= source.state.plan.experiment.repeats; replicate += 1) {
    const selected = record(source, taskId, replicate, armId).record.score

    if (selected.status !== 'known') throw new Error('Expected score')

    selected.document.composite = {
      status: 'value',
      value
    }
  }
}

function facet(
  source: ExperimentComparisonSource,
  taskId: string,
  replicate: number,
  armId: string,
  name: 'direct_behavior' | 'repository_contracts' | 'regression' | 'scope_integrity' | 'maintainability',
  value: number
): void {
  const selected = record(source, taskId, replicate, armId).record.score

  if (selected.status !== 'known') throw new Error('Expected score')

  selected.document.facets[name] = {
    status: 'value',
    value,
    evidence: []
  }
}

function withPredecessorBlock(source: ExperimentComparisonSource): ExperimentComparisonSource {
  const current = source.state.blocks[0]!
  const predecessor = structuredClone(current)
  const predecessorRecords: ReadNormalizedRunRecordResult[] = []

  Object.assign(predecessor, {
    block_id: 'block-predecessor',
    status: 'invalidated',
    cause: 'incomplete',
    reason: 'Superseded predecessor block'
  })

  for (const run of predecessor.runs) {
    const armId = run.assignment.arm_id
    const original = record(source, current.task_id, current.replicate, armId)
    const previousRecord = structuredClone(original)
    const runId = `run-predecessor-${armId}`

    const runIdentity = {
      run_id: runId,
      attempt_id: `${runId}-attempt-1`,
      attempt: 1
    }

    const recordPath = `/runs/${runId}/record.json`
    const normalizedDigest = sha(armId === 'a' ? '4' : '5')

    Object.assign(run.assignment, {
      block_id: predecessor.block_id,
      run_id: runId,
      attempt_id: runIdentity.attempt_id,
      origin_plan: null
    })

    Object.assign(run.result!, {
      normalized_digest: normalizedDigest,
      normalized_path: recordPath
    })

    previousRecord.record.identities.run = runIdentity
    previousRecord.initialRecord.identity = runIdentity
    previousRecord.completionRecord.identity = runIdentity
    previousRecord.record.identities.experiment.experiment_revision = '0'
    previousRecord.record.identities.experiment.plan_digest = sha('0')
    previousRecord.record.identities.experiment.block_id = predecessor.block_id

    Object.assign(previousRecord, {
      digest: normalizedDigest,
      recordPath
    })

    predecessorRecords.push(previousRecord)
  }

  return {
    records: [...source.records, ...predecessorRecords],

    state: {
      ...source.state,
      excluded_blocks: [...source.state.excluded_blocks, predecessor]
    }
  }
}

describe(analyzeExperimentComparison, () => {
  it('produces deterministic exact ties and degenerate confidence intervals', () => {
    const source = comparisonFixture({
      tasks: 2,
      repeats: 3
    })

    const first = analyzeExperimentComparison(source)
    const second = analyzeExperimentComparison(source)
    const compositeMetric = first.pairs[0]!.metrics.find(({ metric }) => metric === 'composite')!

    expect(second).toStrictEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(first.bootstrap.resamples).toBe(BOOTSTRAP_RESAMPLES)
    expect(first.bootstrap.seed).toBe(4_241_232_738)
    expect(compositeMetric.meanDelta).toBe(0)

    expect(compositeMetric.confidenceInterval).toStrictEqual({
      lower: 0,
      upper: 0
    })

    expect(compositeMetric.winTieLoss).toStrictEqual({
      wins: 0,
      ties: 2,
      losses: 0
    })

    const frozenBytes = JSON.stringify({
      bootstrap: first.bootstrap,

      composite: {
        pairedObservations: compositeMetric.pairedObservations,
        taskClusters: compositeMetric.taskClusters,
        meanDelta: compositeMetric.meanDelta,
        confidenceInterval: compositeMetric.confidenceInterval,
        winTieLoss: compositeMetric.winTieLoss
      }
    })

    expect(frozenBytes).toBe('{"bootstrap":{"seed":4241232738,"resamples":10000,"confidence":0.95,"intervalMethod":"percentile_type_7","cluster":"task","tieRule":"exact_zero","generator":"mulberry32"},"composite":{"pairedObservations":6,"taskClusters":2,"meanDelta":0,"confidenceInterval":{"lower":0,"upper":0},"winTieLoss":{"wins":0,"ties":2,"losses":0}}}')
  })

  it('uses right-minus-left task means and task-level win tie loss', () => {
    const source = comparisonFixture({
      tasks: 3,
      repeats: 2
    })

    composite(source, 'task-1', 'b', 1)
    composite(source, 'task-2', 'a', 1)

    const analysis = analyzeExperimentComparison(source)
    const pair = analysis.pairs[0]!
    const metric = pair.metrics.find(({ metric }) => metric === 'composite')!

    expect(pair.tasks.map(({ taskId, metrics }) => ({
      taskId,
      delta: metrics.find(({ metric: name }) => name === 'composite')?.delta
    }))).toStrictEqual([
      {
        taskId: 'task-1',
        delta: 1
      },
      {
        taskId: 'task-2',
        delta: -1
      },
      {
        taskId: 'task-3',
        delta: 0
      }
    ])

    expect(metric.meanDelta).toBe(0)

    expect(metric.winTieLoss).toStrictEqual({
      wins: 1,
      ties: 1,
      losses: 1
    })
  })

  it('weights task means equally when usable repeat coverage differs', () => {
    const source = comparisonFixture({
      tasks: 2,
      repeats: 3
    })

    composite(source, 'task-1', 'b', 1)
    composite(source, 'task-2', 'a', 1)

    for (const block of source.state.blocks) {
      if (block.task_id === 'task-2' && block.replicate > 1) {
        Object.assign(block, {
          status: 'invalidated',
          cause: 'incomplete',
          reason: 'Unequal paired coverage fixture'
        })
      }
    }

    const analysis = analyzeExperimentComparison(source)
    const metric = analysis.pairs[0]!.metrics.find(({ metric }) => metric === 'composite')!

    expect(metric.pairedObservations).toBe(4)
    expect(metric.taskClusters).toBe(2)
    expect(metric.meanDelta).toBe(0)

    expect(analysis.pairs[0]!.tasks.map(({ taskId, metrics }) => ({
      taskId,
      paired: metrics.find(({ metric: name }) => name === 'composite')?.pairedObservations,
      delta: metrics.find(({ metric: name }) => name === 'composite')?.delta
    }))).toStrictEqual([
      {
        taskId: 'task-1',
        paired: 3,
        delta: 1
      },
      {
        taskId: 'task-2',
        paired: 1,
        delta: -1
      }
    ])
  })

  it('encodes task failure as zero and retains numeric facet effects', () => {
    const source = comparisonFixture()
    const leftRun = source.state.blocks[0]!.runs.find(({ assignment }) => assignment.arm_id === 'a')!
    const leftRecord = record(source, 'task-1', 1, 'a').record

    Object.assign(leftRun.result!, {
      classification: 'task_failure',
      valid_grade: true
    })

    leftRecord.outcome.classification = 'task_failure'

    facet(source, 'task-1', 1, 'a', 'direct_behavior', 0.2)
    facet(source, 'task-1', 1, 'b', 'direct_behavior', 0.8)

    const analysis = analyzeExperimentComparison(source)
    const pass = analysis.pairs[0]!.metrics.find(({ metric }) => metric === 'pass_rate')!
    const directBehavior = analysis.pairs[0]!.metrics.find(({ metric }) => metric === 'direct_behavior')!

    expect(pass.leftDistribution.mean).toBe(0)
    expect(pass.rightDistribution.mean).toBe(1)
    expect(pass.meanDelta).toBe(1)

    expect(pass.winTieLoss).toStrictEqual({
      wins: 1,
      ties: 0,
      losses: 0
    })

    expect(directBehavior.leftDistribution.mean).toBe(0.2)
    expect(directBehavior.rightDistribution.mean).toBe(0.8)
    expect(directBehavior.meanDelta).toBeCloseTo(0.6)

    expect(directBehavior.winTieLoss).toStrictEqual({
      wins: 1,
      ties: 0,
      losses: 0
    })
  })

  it('uses migrated quality while retaining source operational metrics', () => {
    const source = comparisonFixture()

    migratedRecord(source, 'a', 0.5, 'task_failure', 7)
    migratedRecord(source, 'b', 0.875, 'task_success', 9)

    Object.assign(source, {
      migration: {
        digest: sha('g'),

        record: {
          identity: {
            migration_id: 'scoring-v2',
            revision: '2'
          },

          regrade_provider_calls: 0,

          targets: [{
            task_id: 'task-1',

            source_evaluator: {
              verifier_revision: 'verifier-1',
              scoring_revision: 'scoring-1',
              rubric_revision: 'rubric-1'
            },

            target_evaluator: {
              verifier_revision: 'verifier-2',
              scoring_revision: 'scoring-2',
              rubric_revision: 'rubric-2'
            }
          }]
        }
      }
    })

    const analysis = analyzeExperimentComparison(source)
    const pair = analysis.pairs[0]!
    const composite = pair.metrics.find(({ metric }) => metric === 'composite')!
    const totalSeconds = pair.metrics.find(({ metric }) => metric === 'total_seconds')!
    const passRate = pair.metrics.find(({ metric }) => metric === 'pass_rate')!

    expect(composite.leftDistribution.mean).toBe(0.5)
    expect(composite.rightDistribution.mean).toBe(0.875)
    expect(passRate.meanDelta).toBe(1)
    expect(totalSeconds.leftDistribution.mean).toBe(10)
    expect(totalSeconds.rightDistribution.mean).toBe(10)

    expect(pair.tasks[0]!.reliability).toStrictEqual({
      left: false,
      right: true,
      delta: 1
    })

    expect(analysis.migration?.verifierSeconds).toStrictEqual({
      knownCount: 2,
      unknownCount: 0,
      mean: 8,
      minimum: 7,
      firstQuartile: 7.5,
      median: 8,
      thirdQuartile: 8.5,
      maximum: 9
    })
  })

  it('rejects a block that mixes one regraded arm with one original arm', () => {
    const source = comparisonFixture()

    migratedRecord(source, 'a', 0.5, 'task_success', 7)

    expect(() => analyzeExperimentComparison(source)).toThrowError(
      'Eligible arm results differ in task, environment, runner, verifier, scoring, or budget identity'
    )
  })

  it('bootstraps task clusters instead of treating repeats as independent rows', () => {
    const source = comparisonFixture({
      tasks: 5,
      repeats: 3
    })

    composite(source, 'task-5', 'b', 1)

    const analysis = analyzeExperimentComparison(source)
    const metric = analysis.pairs[0]!.metrics.find(({ metric }) => metric === 'composite')!

    expect(metric.pairedObservations).toBe(15)
    expect(metric.taskClusters).toBe(5)
    expect(metric.meanDelta).toBe(0.2)

    expect(metric.confidenceInterval).toStrictEqual({
      lower: 0,
      upper: 0.6
    })

    expect(metric.winTieLoss).toStrictEqual({
      wins: 1,
      ties: 4,
      losses: 0
    })
  })

  it('keeps numeric, unknown, and not-applicable facets in independent coverage', () => {
    const source = comparisonFixture({ repeats: 3 })
    const notApplicable = record(source, 'task-1', 2, 'b').record.score
    const unknown = record(source, 'task-1', 3, 'b').record.score

    if (notApplicable.status !== 'known' || unknown.status !== 'known') throw new Error('Expected score')

    notApplicable.document.facets.maintainability = {
      status: 'not_applicable',
      reason: 'Not measured',
      evidence: []
    }

    unknown.document.facets.direct_behavior = {
      status: 'unknown',
      reason: 'Evidence unavailable',
      evidence: []
    }

    const analysis = analyzeExperimentComparison(source)
    const pair = analysis.pairs[0]!
    const pass = pair.metrics.find(({ metric }) => metric === 'pass_rate')!
    const maintainability = pair.metrics.find(({ metric }) => metric === 'maintainability')!
    const directBehavior = pair.metrics.find(({ metric }) => metric === 'direct_behavior')!
    const regression = pair.metrics.find(({ metric }) => metric === 'regression')!

    expect(pass.pairedObservations).toBe(3)
    expect(maintainability.pairedObservations).toBe(2)
    expect(maintainability.leftDistribution.unknownCount).toBe(1)
    expect(directBehavior.pairedObservations).toBe(2)
    expect(directBehavior.leftDistribution.unknownCount).toBe(1)
    expect(regression.pairedObservations).toBe(3)
  })

  it('marks all-success reliable and a valid task failure unreliable', () => {
    const allSuccess = analyzeExperimentComparison(comparisonFixture({ repeats: 2 }))

    expect(allSuccess.pairs[0]!.tasks[0]!.reliability).toStrictEqual({
      left: true,
      right: true,
      delta: 0
    })

    const failed = comparisonFixture({ repeats: 2 })
    const right = failed.state.blocks[1]!.runs.find(({ assignment }) => assignment.arm_id === 'b')!
    const failedRecord = record(failed, 'task-1', 2, 'b').record

    Object.assign(right.result!, {
      classification: 'task_failure',
      valid_grade: true
    })

    failedRecord.outcome.classification = 'task_failure'

    const analysis = analyzeExperimentComparison(failed)

    expect(analysis.pairs[0]!.tasks[0]!.reliability).toStrictEqual({
      left: true,
      right: false,
      delta: -1
    })
  })

  it('reports end-to-end reliability independently from quality metrics', () => {
    const source = comparisonFixture({ repeats: 2 })
    const block = source.state.blocks[1]!
    const right = block.runs.find(({ assignment }) => assignment.arm_id === 'b')!
    const rightRecord = record(source, 'task-1', 2, 'b')

    Object.assign(right.result!, {
      classification: 'infrastructure_failure',
      valid_grade: false
    })

    Object.assign(block, {
      status: 'invalidated',
      cause: 'incomplete',
      reason: 'Infrastructure failed'
    })

    rightRecord.record.outcome.classification = 'infrastructure_failure'
    rightRecord.record.outcome.valid_grade = false

    const analysis = analyzeExperimentComparison(source)
    const pair = analysis.pairs[0]!
    const reliability = pair.metrics.find(({ metric }) => metric === 'end_to_end_reliability')!

    expect(pair.tasks[0]!.reliability).toStrictEqual({
      left: true,
      right: false,
      delta: -1
    })

    expect(reliability.meanDelta).toBe(-1)

    expect(reliability.winTieLoss).toStrictEqual({
      wins: 0,
      ties: 0,
      losses: 1
    })

    expect(pair.metrics.find(({ metric }) => metric === 'pass_rate')!.pairedObservations).toBe(1)
  })

  it('marks reliability unknown while a never-started repeat remains pending', () => {
    const source = comparisonFixture({ repeats: 2 })
    const block = source.state.blocks[1]!
    const right = block.runs.find(({ assignment }) => assignment.arm_id === 'b')!
    const filtered = source.records.filter(({ record: item }) => item.identities.run.run_id !== right.assignment.run_id)

    Object.assign(right, {
      status: 'pending',
      started_at: null,
      result: null
    })

    Object.assign(block, {
      status: 'in_progress',
      completed_at: null
    })

    const partial = {
      records: filtered,
      state: source.state
    }

    const analysis = analyzeExperimentComparison(partial)
    const pair = analysis.pairs[0]!

    expect(pair.tasks[0]!.reliability).toStrictEqual({
      left: true,
      right: null,
      delta: null
    })

    expect(pair.eligibleBlocks).toBe(1)
    expect(analysis.omittedBlocks).toHaveLength(1)
  })

  it('marks a started but unverified repeat as unreliable', () => {
    const source = comparisonFixture({ repeats: 2 })
    const block = source.state.blocks[1]!
    const right = block.runs.find(({ assignment }) => assignment.arm_id === 'b')!
    const records = source.records.filter(({ record: item }) => item.identities.run.run_id !== right.assignment.run_id)

    Object.assign(right, {
      status: 'pending',
      started_at: '2026-09-07T12:00:00.000Z',
      result: null
    })

    Object.assign(block, {
      status: 'in_progress',
      completed_at: null
    })

    const analysis = analyzeExperimentComparison({
      records,
      state: source.state
    })

    expect(analysis.pairs[0]!.tasks[0]!.reliability).toStrictEqual({
      left: true,
      right: false,
      delta: -1
    })
  })

  it('summarizes paired and observed timing distributions', () => {
    const source = comparisonFixture({ repeats: 3 })
    const analysis = analyzeExperimentComparison(source)
    const paired = analysis.pairs[0]!.metrics.find(({ metric }) => metric === 'total_seconds')!
    const observed = analysis.observed[0]!.metrics.find(({ metric }) => metric === 'total_seconds')!.distribution

    expect(paired.leftDistribution).toStrictEqual({
      knownCount: 3,
      unknownCount: 0,
      mean: 20,
      minimum: 10,
      firstQuartile: 15,
      median: 20,
      thirdQuartile: 25,
      maximum: 30
    })

    expect(observed).toStrictEqual(paired.leftDistribution)
  })

  it('keeps technical and predecessor attempts in observed distributions only', () => {
    const current = comparisonFixture({ repeats: 2 })
    const technicalBlock = current.state.blocks[1]!
    const technicalRun = technicalBlock.runs.find(({ assignment }) => assignment.arm_id === 'b')!
    const technicalRecord = record(current, 'task-1', 2, 'b').record

    Object.assign(technicalBlock, {
      status: 'invalidated',
      cause: 'incomplete',
      reason: 'Infrastructure failed'
    })

    Object.assign(technicalRun.result!, {
      classification: 'infrastructure_failure',
      valid_grade: false
    })

    technicalRecord.outcome.classification = 'infrastructure_failure'
    technicalRecord.outcome.valid_grade = false

    const source = withPredecessorBlock(current)
    const analysis = analyzeExperimentComparison(source)
    const rightObserved = analysis.observed.find(({ arm }) => arm.armId === 'b')!
    const totalSeconds = rightObserved.metrics.find(({ metric }) => metric === 'total_seconds')!

    expect(analysis.pairs[0]!.eligibleBlocks).toBe(1)
    expect(analysis.pairs[0]!.metrics.find(({ metric }) => metric === 'total_seconds')!.pairedObservations).toBe(1)
    expect(rightObserved.attempts).toBe(3)

    expect(rightObserved.outcomes).toStrictEqual([
      {
        outcome: 'infrastructure_failure',
        count: 1
      },
      {
        outcome: 'task_success',
        count: 2
      }
    ])

    expect(totalSeconds.distribution).toStrictEqual({
      knownCount: 3,
      unknownCount: 0,
      mean: 40 / 3,
      minimum: 10,
      firstQuartile: 10,
      median: 10,
      thirdQuartile: 15,
      maximum: 20
    })
  })

  it('exposes the complete quality, reliability, timing, and usage inventory', () => {
    const analysis = analyzeExperimentComparison(comparisonFixture())
    const pair = analysis.pairs[0]!

    expect(pair.tasks[0]!.metrics.map(({ metric }) => metric)).toStrictEqual([
      ...QUALITY_METRICS,
      ...OPERATIONAL_METRICS
    ])

    expect(pair.metrics.map(({ metric }) => metric)).toStrictEqual([
      ...QUALITY_METRICS,
      'end_to_end_reliability',
      ...OPERATIONAL_METRICS
    ])

    expect(analysis.observed[0]!.metrics.map(({ metric }) => metric)).toStrictEqual(OPERATIONAL_METRICS)
  })

  it('tracks paired and observed unknown usage coverage independently', () => {
    const source = comparisonFixture({ repeats: 3 })
    const leftUnknown = record(source, 'task-1', 2, 'a').record

    leftUnknown.usage.output_tokens = {
      status: 'unknown',
      reason: 'Usage unavailable'
    }

    const analysis = analyzeExperimentComparison(source)
    const paired = analysis.pairs[0]!.metrics.find(({ metric }) => metric === 'output_tokens')!
    const leftObserved = analysis.observed.find(({ arm }) => arm.armId === 'a')!.metrics.find(({ metric }) => metric === 'output_tokens')!
    const rightObserved = analysis.observed.find(({ arm }) => arm.armId === 'b')!.metrics.find(({ metric }) => metric === 'output_tokens')!

    expect(paired.pairedObservations).toBe(2)

    expect(paired.leftDistribution).toMatchObject({
      knownCount: 2,
      unknownCount: 1,
      mean: 40
    })

    expect(paired.rightDistribution).toMatchObject({
      knownCount: 2,
      unknownCount: 1,
      mean: 40
    })

    expect(leftObserved.distribution).toMatchObject({
      knownCount: 2,
      unknownCount: 1,
      mean: 40
    })

    expect(rightObserved.distribution).toMatchObject({
      knownCount: 3,
      unknownCount: 0,
      mean: 40
    })
  })

  it('generates every unordered arm pair in lexical order', () => {
    const source = comparisonFixture({ arms: ['a_1', 'c', 'a-1'] })
    const analysis = analyzeExperimentComparison(source)

    expect(analysis.pairs.map(({ leftArm, rightArm }) => `${leftArm.armId}:${rightArm.armId}`)).toStrictEqual([
      'a-1:a_1',
      'a-1:c',
      'a_1:c'
    ])
  })

  it('orders task clusters independently from the host locale', () => {
    const source = comparisonFixture({ taskIds: ['task_1', 'task-1'] })
    const analysis = analyzeExperimentComparison(source)

    expect(analysis.pairs[0]!.tasks.map(({ taskId }) => taskId)).toStrictEqual([
      'task-1',
      'task_1'
    ])
  })

  it.each([
    ['normalization revision', (source: ExperimentComparisonSource) => {
      Object.assign(record(source, 'task-1', 1, 'b').record, {
        normalization_revision: '2'
      })
    }],
    ['benchmark commit', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'b').record.identities.benchmark_repo_commit = '2'.repeat(40)
    }],
    ['suite revision', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'b').record.identities.suite.revision = '2'
    }],
    ['task revision', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'b').record.identities.task.revision = '2'
    }],
    ['task source', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'b').record.identities.task.source_digest = sha('x')
    }],
    ['task environment', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'b').record.identities.task.environment_image_digest = sha('x')
    }],
    ['budget', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'b').initialRecord.budget.wall_clock_seconds = 601
    }],
    ['agent product', (source: ExperimentComparisonSource) => {
      Object.assign(record(source, 'task-1', 1, 'b').initialRecord.agent, {
        product: 'different-agent'
      })
    }],
    ['requested model', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'b').initialRecord.agent.requested_model = 'different-model'
    }],
    ['effort', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'b').initialRecord.agent.effort = 'high'
    }],
    ['auth mode', (source: ExperimentComparisonSource) => {
      Object.assign(record(source, 'task-1', 1, 'b').initialRecord.agent, {
        auth_mode: 'api'
      })
    }],
    ['network policy', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'b').record.identities.network_policy_digest = sha('x')
    }],
    ['effective permissions', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'b').record.identities.effective_permissions_digest = sha('x')
    }],
    ['MCP tools', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'b').record.identities.mcp_tools_digest = sha('x')
    }],
    ['collector revision', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'b').record.revisions.collector_revision = 'collector-2'
    }],
    ['host identity', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'b').record.identities.host.os_version = 'different'
    }],
    ['verifier revision', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'b').record.revisions.verifier_revision = 'verifier-2'
    }],
    ['verifier image', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'b').record.revisions.verifier_image_digest = sha('x')
    }],
    ['runner revision', (source: ExperimentComparisonSource) => {
      Object.assign(record(source, 'task-1', 1, 'b').record.revisions, {
        runner_version: '0.23.0'
      })
    }],
    ['runner config', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'b').record.revisions.runner_config_digest = sha('x')
    }],
    ['effective concurrency', (source: ExperimentComparisonSource) => {
      Object.assign(record(source, 'task-1', 1, 'b').initialRecord.runner, {
        effective_concurrency: {
          status: 'unknown',
          reason: 'Unavailable'
        }
      })
    }],
    ['scoring revision', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'b').record.revisions.scoring_revision = 'scoring-2'
    }],
    ['rubric revision', (source: ExperimentComparisonSource) => {
      const selected = record(source, 'task-1', 1, 'b').record.score

      if (selected.status === 'known') selected.document.rubric_revision = 'rubric-2'
    }],
    ['stack environment', (source: ExperimentComparisonSource) => {
      source.state.plan.stacks[1]!.environment.revision = '2'
    }],
    ['duplicate harness identity', (source: ExperimentComparisonSource) => {
      source.state.plan.experiment.arms[1]!.harness = structuredClone(source.state.plan.experiment.arms[0]!.harness)
    }],
    ['known provider identity', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'a').record.identities.agent.observed_provider_identity = {
        status: 'known',
        value: 'provider-a'
      }

      record(source, 'task-1', 1, 'b').record.identities.agent.observed_provider_identity = {
        status: 'known',
        value: 'provider-b'
      }
    }]
  ])('rejects incompatible %s instead of dropping the pair', (_name, mutate) => {
    const source = comparisonFixture()

    mutate(source)
    expect(() => analyzeExperimentComparison(source)).toThrowError(StatisticsError)
    expect(() => analyzeExperimentComparison(source)).toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_COMPARISON' }))
  })

  it('rejects unsupported and mismatched analysis revisions', () => {
    const unsupported = comparisonFixture()

    unsupported.state.plan.definition.analysis_revision = '2'
    unsupported.state.plan.experiment.analysis_revision = '2'

    expect(() => analyzeExperimentComparison(unsupported)).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_ANALYSIS_REVISION' }))

    const mismatched = comparisonFixture()

    mismatched.state.plan.definition.analysis_revision = '2'

    expect(() => analyzeExperimentComparison(mismatched)).toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_COMPARISON' }))
  })

  it('rejects superseded plans while leaving operational reporting independent', () => {
    const source = comparisonFixture()

    Object.assign(source.state, { superseded: true })
    expect(() => analyzeExperimentComparison(source)).toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_COMPARISON' }))
  })

  it('rejects missing and unreferenced sealed sources', () => {
    const missing = comparisonFixture()

    expect(() => analyzeExperimentComparison({
      records: missing.records.slice(1),
      state: missing.state
    })).toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_COMPARISON' }))

    const extra = comparisonFixture()
    const forged = structuredClone(extra.records[0]!)

    forged.record.identities.run.run_id = 'unreferenced-run'
    forged.record.identities.run.attempt_id = 'unreferenced-run-attempt-1'

    expect(() => analyzeExperimentComparison({
      records: [...extra.records, forged],
      state: extra.state
    })).toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_COMPARISON' }))
  })

  it.each([
    ['initial identity', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'a').initialRecord.identity.run_id = 'forged-run'
    }],
    ['completion identity', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'a').completionRecord.identity.run_id = 'forged-run'
    }],
    ['experiment family', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'a').record.identities.experiment.experiment_id = 'forged-experiment'
    }],
    ['current experiment revision', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'a').record.identities.experiment.experiment_revision = '2'
    }],
    ['current plan digest', (source: ExperimentComparisonSource) => {
      record(source, 'task-1', 1, 'a').record.identities.experiment.plan_digest = sha('x')
    }],
    ['normalized digest', (source: ExperimentComparisonSource) => {
      Object.assign(record(source, 'task-1', 1, 'a'), { digest: sha('x') })
    }],
    ['normalized path', (source: ExperimentComparisonSource) => {
      Object.assign(record(source, 'task-1', 1, 'a'), {
        recordPath: '/runs/forged/record.json'
      })
    }]
  ])('rejects comparison source tampering in %s', (_name, mutate) => {
    const source = comparisonFixture()

    mutate(source)

    expect(() => analyzeExperimentComparison(source)).toThrowError(expect.objectContaining({
      code: 'INCOMPATIBLE_COMPARISON'
    }))
  })

  it('rejects an attempt reused across current and predecessor roles', () => {
    const source = comparisonFixture()
    const duplicate = structuredClone(source.state.blocks[0]!)

    const conflicted = {
      records: source.records,

      state: {
        ...source.state,
        excluded_blocks: [duplicate]
      }
    }

    expect(() => analyzeExperimentComparison(conflicted)).toThrowError(expect.objectContaining({
      code: 'INCOMPATIBLE_COMPARISON'
    }))
  })
})
