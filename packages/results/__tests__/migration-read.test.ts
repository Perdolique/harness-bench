import { describe, expect, it, vi } from 'vitest'
import { scoringMigrationEvaluatorIdentity, type ExperimentPlan } from '@harness-bench/core'
import type { TaskDocument } from '@harness-bench/schemas'
import { readRegradedExperimentComparisonSource, type MigrationReadDependencies } from '../src/migration-read.ts'
import type { ExperimentComparisonSource } from '../src/experiment.ts'
import type { ReadRegradedRunRecordResult } from '../src/regrade-storage.ts'
import type { StoredScoringMigrationRecord } from '../src/regrade-storage.ts'

const digest = (character: string): string => `sha256:${character.repeat(64)}`

function task(): TaskDocument {
  return {
    task_id: 'fixture-task',

    verifier: {
      revision: '2',
      image_digest: digest('a'),

      network_enforcement_sidecar_digest: {
        status: 'not_applicable',
        reason: 'Docker network mode is none'
      }
    },

    scoring: {
      revision: '2',
      rubric_revision: '2'
    },

    rubric: [{ obligation_id: 'fixture' }]
  } as unknown as TaskDocument
}

function plan(): ExperimentPlan {
  return {
    runs_directory: '/runs',

    experiment: {
      experiment_id: 'fixture-experiment',
      revision: '1',
      plan_digest: digest('1'),
      tasks: [{ task_id: 'fixture-task' }]
    }
  } as unknown as ExperimentPlan
}

function source(): ExperimentComparisonSource {
  return {
    records: [
      {
        digest: digest('2'),
        runDirectory: '/runs/run-valid',

        record: {
          identities: {
            run: {
              run_id: 'run-valid',
              attempt_id: 'run-valid-attempt-1'
            },

            task: { id: 'fixture-task' }
          },

          outcome: {
            classification: 'task_success',
            valid_grade: true
          }
        }
      },
      {
        digest: digest('3'),
        runDirectory: '/runs/run-technical',

        record: {
          identities: {
            run: {
              run_id: 'run-technical',
              attempt_id: 'run-technical-attempt-1'
            },

            task: { id: 'fixture-task' }
          },

          outcome: {
            classification: 'runner_failure',
            valid_grade: false
          }
        }
      }
    ],

    state: {}
  } as unknown as ExperimentComparisonSource
}

function migrationRecord(sourceTask: TaskDocument): StoredScoringMigrationRecord {
  const evaluator = scoringMigrationEvaluatorIdentity(sourceTask)

  return {
    digest: digest('4'),
    recordPath: '/runs/.experiments/migrations/record.json',

    record: {
      identity: {
        definition_digest: digest('5')
      },

      targets: [{
        task_id: 'fixture-task',
        task_document_digest: digest('6'),
        task_package_digest: digest('7'),
        source_evaluator: evaluator,
        target_evaluator: evaluator
      }],

      entries: [
        {
          run_id: 'run-valid',
          attempt_id: 'run-valid-attempt-1',
          source_normalized_digest: digest('2'),
          status: 'regraded',
          regraded_record_digest: digest('8'),
          regraded_record_path: '.results/run-valid/regrades/record.json'
        },
        {
          run_id: 'run-technical',
          attempt_id: 'run-technical-attempt-1',
          source_normalized_digest: digest('3'),
          status: 'retained_technical',
          classification: 'runner_failure'
        }
      ]
    }
  } as unknown as StoredScoringMigrationRecord
}

function regrade(sourceTask: TaskDocument): ReadRegradedRunRecordResult {
  return {
    digest: digest('8'),
    leaf: '/runs/.results/run-valid/regrades/address',

    record: {
      migration_definition_digest: digest('5'),

      target: {
        task_document_digest: digest('6'),
        task_package_digest: digest('7'),
        evaluator: scoringMigrationEvaluatorIdentity(sourceTask)
      }
    }
  } as unknown as ReadRegradedRunRecordResult
}

function harness() {
  const sourceTask = task()
  const comparisonSource = source()
  const migration = migrationRecord(sourceTask)
  const regraded = regrade(sourceTask)

  const dependencies = {
    assertSourceIntegrity: vi.fn(async () => Promise.resolve()),
    assertTargetContract: vi.fn(async () => Promise.resolve()),
    readMigration: vi.fn(async () => migration),
    readRegrade: vi.fn(async () => regraded),
    readSource: vi.fn(async () => comparisonSource),
    readSourceTask: vi.fn(async () => sourceTask)
  } as unknown as MigrationReadDependencies

  return {
    comparisonSource,
    dependencies,
    migration,
    regraded,
    sourceTask
  }
}

describe('readRegradedExperimentComparisonSource', () => {
  it('builds a complete overlay and retains the technical source unchanged', async () => {
    const test = harness()

    const result = await readRegradedExperimentComparisonSource(
      plan(),
      '/migration.json',
      test.dependencies
    )

    expect(result.records).toHaveLength(2)
    expect(result.records[0]?.regrade).toBe(test.regraded)
    expect(result.records[1]?.regrade).toBeUndefined()
    expect(test.dependencies.assertSourceIntegrity).toHaveBeenCalledOnce()
  })

  it.each([
    'missing-entry',
    'wrong-attempt',
    'invented-technical-grade',
    'source-evaluator-drift',
    'target-evaluator-drift',
    'missing-target'
  ] as const)('rejects %s migration evidence', async (mutation) => {
    const test = harness()
    const entries = test.migration.record.entries as unknown as Array<Record<string, unknown>>
    const targets = test.migration.record.targets as unknown as Array<Record<string, unknown>>

    if (mutation === 'missing-entry') entries.pop()

    if (mutation === 'wrong-attempt') {
      Object.assign(entries[0]!, { attempt_id: 'foreign-attempt' })
    }

    if (mutation === 'invented-technical-grade') {
      Object.assign(entries[1]!, {
        status: 'regraded',
        regraded_record_digest: digest('9'),
        regraded_record_path: '.results/run-technical/regrades/record.json'
      })
    }

    if (mutation === 'source-evaluator-drift') {
      const sourceEvaluator = targets[0]!.source_evaluator as Record<string, unknown>

      sourceEvaluator.scoring_revision = 'foreign'
    }

    if (mutation === 'target-evaluator-drift') {
      const evaluator = test.regraded.record.target.evaluator as unknown as Record<string, unknown>

      evaluator.scoring_revision = 'foreign'
    }

    if (mutation === 'missing-target') targets.pop()

    await expect(
      readRegradedExperimentComparisonSource(
        plan(),
        '/migration.json',
        test.dependencies
      )
    ).rejects.toMatchObject({ code: 'INCOMPATIBLE_EVIDENCE' })
  })
})
