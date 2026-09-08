import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { RegradedRunRecordV1Schema, ScoringMigrationRecordV1Schema } from '../src/regrade-schemas.ts'

const digest = (character: string): string => `sha256:${character.repeat(64)}`

async function regradedRecord(): Promise<Record<string, unknown>> {
  const score = JSON.parse(await readFile(resolve(
    import.meta.dirname,
    '../../../tests/fixtures/results/harbor-0.22.0/raw/harbor/job/trial-fixture/verifier/score.json'
  ), 'utf8'))

  score.run_id = 'fixture-run'
  score.score_id = 'score-fixture-run-v2'
  score.scoring_revision = '2'
  score.rubric_revision = '2'
  score.harbor_reward.numeric_values.provider_calls = 0
  score.verifier_result_digest = digest('8')

  const evaluator = {
    verifier_revision: '2',
    verifier_image_digest: digest('2'),

    verifier_network_enforcement_sidecar_digest: {
      status: 'not_applicable',
      reason: 'Docker network mode none is direct'
    },

    scoring_revision: '2',
    rubric_revision: '2'
  }

  return {
    document_type: 'regraded_run',
    schema_version: 1,
    regrade_revision: '1',
    record_type: 'regraded',
    created_at: '2026-09-08T10:00:00.000Z',
    migration_definition_digest: digest('1'),

    source: {
      run_id: 'fixture-run',
      attempt_id: 'fixture-run-attempt-1',
      normalized_digest: digest('2'),
      normalized_record_path: 'normalized/fixture/record.json',
      raw_manifest_digest: digest('3'),
      run_tree_digest: digest('4'),
      agent_identity_digest: digest('5'),
      usage_digest: digest('6'),

      evaluator: {
        ...evaluator,
        verifier_revision: '1',
        scoring_revision: '1',
        rubric_revision: '1'
      },

      trial: {
        trial_id: 'trial-fixture',
        task_name: 'fixture-task',
        task_digest: digest('7'),
        config_digest: digest('8'),
        lock_digest: digest('9'),
        result_digest: digest('a')
      }
    },

    target: {
      task_id: 'fixture-task',
      task_document_digest: digest('b'),
      task_package_digest: digest('c'),
      materialized_task_package_digest: digest('d'),
      task_lock_digest: digest('e'),
      evaluator
    },

    provenance: {
      harbor_version: '0.22.0',
      action: 'regrade',
      source_trial_id: 'trial-fixture',
      source_task_digest: digest('7'),
      target_task_digest: digest('e')
    },

    outcome: {
      classification: 'task_success',
      valid_grade: true
    },

    score,
    timings: { verifier_seconds: 3 },
    regrade_provider_calls: 0,

    evidence: {
      target_document_path: 'inputs/task.json',
      target_package_path: 'inputs/task-package',
      materialized_target_package_path: 'raw/runner/materialized-task-package',
      raw_manifest_path: 'raw-manifest.json',
      config_path: 'raw/harbor/trial/config.json',
      lock_path: 'raw/harbor/trial/lock.json',
      result_path: 'raw/harbor/trial/result.json',
      verifier_result_path: 'raw/harbor/trial/verifier/verifier-result.json',
      raw_manifest_digest: digest('f'),
      config_digest: digest('1'),
      lock_digest: digest('2'),
      result_digest: digest('3'),
      verifier_result_digest: digest('8')
    }
  }
}

describe('regrade result schemas', () => {
  it('accepts exact v1 relationships and rejects provider or unknown-field drift', async () => {
    const record = await regradedRecord()

    expect(v.safeParse(RegradedRunRecordV1Schema, record).success).toBe(true)

    const providerDrift = structuredClone(record) as unknown as {
      score: {
        harbor_reward: {
          numeric_values: Record<string, number>;
        };
      };
    }

    providerDrift.score.harbor_reward.numeric_values.provider_calls = 1

    expect(v.safeParse(RegradedRunRecordV1Schema, providerDrift).success).toBe(false)

    const unknownField = {
      ...record,
      invented: true
    }

    expect(v.safeParse(RegradedRunRecordV1Schema, unknownField).success).toBe(false)
  })

  it('requires one unambiguous migration entry per run and attempt', () => {
    const evaluator = {
      verifier_revision: '2',
      verifier_image_digest: digest('2'),

      verifier_network_enforcement_sidecar_digest: {
        status: 'not_applicable',
        reason: 'Docker network mode none is direct'
      },

      scoring_revision: '2',
      rubric_revision: '2'
    }

    const entry = {
      run_id: 'fixture-run',
      attempt_id: 'fixture-attempt',
      source_normalized_digest: digest('3'),
      status: 'retained_technical',
      classification: 'runner_failure'
    }

    const record = {
      document_type: 'scoring_migration',
      schema_version: 1,
      migration_revision: '1',
      record_type: 'migration',
      created_at: '2026-09-08T10:00:00.000Z',

      identity: {
        migration_id: 'fixture-migration',
        revision: '2',
        definition_digest: digest('4')
      },

      experiment: {
        experiment_id: 'fixture-experiment',
        experiment_revision: '1',
        plan_digest: digest('5')
      },

      targets: [{
        task_id: 'fixture-task',
        task_document_digest: digest('6'),
        task_package_digest: digest('7'),

        source_evaluator: {
          ...evaluator,
          scoring_revision: '1'
        },

        target_evaluator: evaluator
      }],

      entries: [entry],
      regrade_provider_calls: 0
    }

    expect(v.safeParse(ScoringMigrationRecordV1Schema, record).success).toBe(true)

    expect(v.safeParse(ScoringMigrationRecordV1Schema, {
      ...record,
      entries: [entry, entry]
    }).success).toBe(false)
  })
})
