import { chmod, cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExperimentPlan } from '@harness-bench/core'
import * as v from 'valibot'
import { ScoringMigrationRecordV1Schema } from '../src/regrade-schemas.ts'
import { readScoringMigrationRecord, writeScoringMigrationRecord } from '../src/regrade-storage.ts'

const digest = (character: string): string => `sha256:${character.repeat(64)}`
let root: string

beforeEach(async () => {
  root = await mkdtemp('/tmp/harness-bench-regrade-storage-')

  await mkdir(resolve(root, '.experiments'), { mode: 0o700 })
})

afterEach(async () => {
  await rm(root, {
    force: true,
    recursive: true
  })
})

function plan(): ExperimentPlan {
  return {
    runs_directory: root,

    experiment: {
      experiment_id: 'fixture-experiment',
      revision: '1',
      plan_digest: digest('1')
    }
  } as unknown as ExperimentPlan
}

function record() {
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

  return v.parse(ScoringMigrationRecordV1Schema, {
    document_type: 'scoring_migration',
    schema_version: 1,
    migration_revision: '1',
    record_type: 'migration',
    created_at: '2026-09-08T10:00:00.000Z',

    identity: {
      migration_id: 'fixture-migration',
      revision: '2',
      definition_digest: digest('3')
    },

    experiment: {
      experiment_id: 'fixture-experiment',
      experiment_revision: '1',
      plan_digest: digest('1')
    },

    targets: [{
      task_id: 'fixture-task',
      task_document_digest: digest('4'),
      task_package_digest: digest('5'),

      source_evaluator: {
        ...evaluator,
        scoring_revision: '1'
      },

      target_evaluator: evaluator
    }],

    entries: [{
      run_id: 'fixture-run',
      attempt_id: 'fixture-attempt',
      source_normalized_digest: digest('6'),
      status: 'retained_technical',
      classification: 'runner_failure'
    }],

    regrade_provider_calls: 0
  })
}

describe('scoring migration storage', () => {
  it('round-trips one content-addressed record and rejects a wrong address', async () => {
    const selectedPlan = plan()
    const stored = await writeScoringMigrationRecord(selectedPlan, record())

    const reread = await readScoringMigrationRecord(
      stored.recordPath,
      selectedPlan
    )

    expect(reread.digest).toBe(stored.digest)
    expect(reread.record).toStrictEqual(stored.record)

    const wrongLeaf = resolve(
      dirname(dirname(stored.recordPath)),
      'f'.repeat(64)
    )

    await mkdir(wrongLeaf, { mode: 0o700 })
    await cp(stored.recordPath, resolve(wrongLeaf, 'record.json'))
    await chmod(resolve(wrongLeaf, 'record.json'), 0o400)

    await expect(
      readScoringMigrationRecord(
        resolve(wrongLeaf, 'record.json'),
        selectedPlan
      )
    ).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
  })

  it('resumes identical content and rejects identity reuse with changed entries', async () => {
    const selectedPlan = plan()
    const first = await writeScoringMigrationRecord(selectedPlan, record())

    const resumed = await writeScoringMigrationRecord(selectedPlan, {
      ...record(),
      created_at: '2026-09-08T11:00:00.000Z'
    })

    expect(resumed.digest).toBe(first.digest)

    const conflicting = record()

    Object.assign(conflicting.entries[0]!, {
      classification: 'provider_failure'
    })

    await expect(
      writeScoringMigrationRecord(selectedPlan, conflicting)
    ).rejects.toMatchObject({ code: 'RECORD_CONFLICT' })
  })
})
