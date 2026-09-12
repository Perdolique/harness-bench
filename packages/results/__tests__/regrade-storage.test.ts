import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inspectRunTree, type ExperimentPlan } from '@harness-bench/core'
import * as v from 'valibot'
import { RegradedRunRecordV1Schema, ScoringMigrationRecordV1Schema } from '../src/regrade-schemas.ts'

import {
  findRegradedRunRecord,
  prepareRegradeStaging,
  quarantineRegradeStaging,
  readRegradedRunRecord,
  readScoringMigrationRecord,
  sealRegradedRunRecord,
  writeScoringMigrationRecord
} from '../src/regrade-storage.ts'

import { sha256 } from '../src/storage.ts'

const digest = (character: string): string => `sha256:${character.repeat(64)}`
let root: string

beforeEach(async () => {
  root = await mkdtemp('/tmp/harness-bench-regrade-storage-')

  await mkdir(resolve(root, '.experiments'), { mode: 0o700 })
})

afterEach(async () => {
  async function makeWritable(path: string): Promise<void> {
    const metadata = await lstat(path)

    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      await chmod(path, 0o700)

      for (const name of await readdir(path)) {
        await makeWritable(resolve(path, name))
      }

      return
    }

    if (!metadata.isSymbolicLink()) await chmod(path, 0o600)
  }

  await makeWritable(root)

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
    rubric_revision: '2',
    rubric_digest: digest('7')
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
        scoring_revision: '1',
        rubric_revision: '1',
        rubric_digest: digest('6')
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

async function writeEvidence(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true,
    mode: 0o700
  })

  await writeFile(path, source, { mode: 0o600 })
}

async function sealRunRegrade(
  createdAt: string,
  validateBeforePublish?: () => Promise<void>
) {
  const staging = await prepareRegradeStaging(root, 'fixture-run')
  const rawRoot = resolve(staging, 'raw')
  const targetDocumentPath = resolve(staging, 'inputs/task-document.json')
  const targetPackagePath = resolve(staging, 'inputs/task-package')
  const materializedPackagePath = resolve(rawRoot, 'runner/materialized-task-package')
  const configPath = resolve(rawRoot, 'harbor/trial/config.json')
  const lockPath = resolve(rawRoot, 'harbor/trial/lock.json')
  const resultPath = resolve(rawRoot, 'harbor/trial/result.json')
  const verifierResultPath = resolve(rawRoot, 'harbor/trial/verifier/verifier-result.json')
  const targetDocument = '{}\n'
  const config = '{"source_trial":{"action":"regrade"}}\n'
  const lock = '{"source_trial":{"action":"regrade"}}\n'
  const result = '{"verifier_environment_mode":"separate"}\n'
  const verifierResult = '{"integrity":{"passed":true}}\n'

  await Promise.all([
    writeEvidence(targetDocumentPath, targetDocument),
    writeEvidence(resolve(targetPackagePath, 'task.toml'), 'version = 1\n'),
    writeEvidence(resolve(materializedPackagePath, 'task.toml'), 'version = 1\n'),
    writeEvidence(configPath, config),
    writeEvidence(lockPath, lock),
    writeEvidence(resultPath, result),
    writeEvidence(verifierResultPath, verifierResult)
  ])

  const [targetPackage, materializedPackage, raw] = await Promise.all([
    inspectRunTree(targetPackagePath),
    inspectRunTree(materializedPackagePath),
    inspectRunTree(rawRoot)
  ])

  const rawManifest = `${JSON.stringify(raw.entries, null, 2)}\n`
  const rawManifestPath = resolve(staging, 'raw-manifest.json')

  await writeEvidence(rawManifestPath, rawManifest)

  const score = JSON.parse(await readFile(resolve(
    import.meta.dirname,
    '../../../tests/fixtures/results/harbor-0.23.0/raw/harbor/job/trial-fixture/verifier/score.json'
  ), 'utf8'))

  const verifierResultDigest = sha256(verifierResult)

  Object.assign(score, {
    run_id: 'fixture-run',
    score_id: 'score-fixture-run-v2',
    scoring_revision: '2',
    rubric_revision: '2',
    verifier_result_digest: verifierResultDigest
  })

  score.harbor_reward.numeric_values.provider_calls = 0

  const evaluator = {
    verifier_revision: '2',
    verifier_image_digest: digest('2'),

    verifier_network_enforcement_sidecar_digest: {
      status: 'not_applicable',
      reason: 'Docker network mode none is direct'
    },

    scoring_revision: '2',
    rubric_revision: '2',
    rubric_digest: digest('d')
  }

  const regradeRecord = v.parse(RegradedRunRecordV1Schema, {
    document_type: 'regraded_run',
    schema_version: 1,
    regrade_revision: '1',
    record_type: 'regraded',
    created_at: createdAt,
    migration_definition_digest: digest('1'),

    source: {
      run_id: 'fixture-run',
      attempt_id: 'fixture-run-attempt-1',
      normalized_digest: digest('2'),
      normalized_record_path: 'normalized/address/record.json',
      raw_manifest_digest: digest('3'),
      run_tree_digest: digest('4'),
      agent_identity_digest: digest('5'),
      usage_digest: digest('6'),

      evaluator: {
        ...evaluator,
        verifier_revision: '1',
        scoring_revision: '1',
        rubric_revision: '1',
        rubric_digest: digest('c')
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
      task_document_digest: sha256(targetDocument),
      task_package_digest: targetPackage.digest,
      materialized_task_package_digest: materializedPackage.digest,
      task_lock_digest: digest('e'),
      evaluator
    },

    provenance: {
      harbor_version: '0.23.0',
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
      target_document_path: 'inputs/task-document.json',
      target_package_path: 'inputs/task-package',
      materialized_target_package_path: 'raw/runner/materialized-task-package',
      raw_manifest_path: 'raw-manifest.json',
      config_path: 'raw/harbor/trial/config.json',
      lock_path: 'raw/harbor/trial/lock.json',
      result_path: 'raw/harbor/trial/result.json',
      verifier_result_path: 'raw/harbor/trial/verifier/verifier-result.json',
      raw_manifest_digest: sha256(rawManifest),
      config_digest: sha256(config),
      lock_digest: sha256(lock),
      result_digest: sha256(result),
      verifier_result_digest: verifierResultDigest
    }
  })

  return sealRegradedRunRecord(
    staging,
    regradeRecord,
    validateBeforePublish
  )
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

    const foreignPlan = structuredClone(selectedPlan)

    Object.assign(foreignPlan.experiment, {
      experiment_id: 'foreign-experiment'
    })

    await expect(
      readScoringMigrationRecord(stored.recordPath, foreignPlan)
    ).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })

    const wrongLeaf = resolve(
      dirname(dirname(stored.recordPath)),
      'f'.repeat(64)
    )

    await mkdir(wrongLeaf, { mode: 0o700 })
    await cp(stored.recordPath, resolve(wrongLeaf, 'record.json'))
    await chmod(resolve(wrongLeaf, 'record.json'), 0o400)
    await chmod(wrongLeaf, 0o500)

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

  it.each(['leaf-mode', 'record-mode', 'extra-entry'] as const)(
    'rejects migration storage %s drift',
    async (mutation) => {
      const selectedPlan = plan()
      const stored = await writeScoringMigrationRecord(selectedPlan, record())
      const leaf = dirname(stored.recordPath)

      if (mutation === 'leaf-mode') await chmod(leaf, 0o700)

      if (mutation === 'record-mode') await chmod(stored.recordPath, 0o500)

      if (mutation === 'extra-entry') {
        await chmod(leaf, 0o700)
        await writeFile(resolve(leaf, 'extra'), '', { mode: 0o400 })
        await chmod(leaf, 0o500)
      }

      await expect(
        readScoringMigrationRecord(stored.recordPath, selectedPlan)
      ).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
    }
  )
})

describe('per-run regrade storage', () => {
  it('quarantines structured technical failure diagnostics separately', async () => {
    const staging = await prepareRegradeStaging(root, 'fixture-run')

    const diagnostic = {
      document_type: 'regrade_failure',
      schema_version: 1,
      classification: 'cancellation'
    }

    const failed = await quarantineRegradeStaging(staging, diagnostic)
    const source = await readFile(resolve(failed, 'failure.json'), 'utf8')

    expect(JSON.parse(source)).toStrictEqual(diagnostic)
    expect((await lstat(failed)).mode & 0o777).toBe(0o500)
    expect((await lstat(resolve(failed, 'failure.json'))).mode & 0o777).toBe(0o400)
  })

  it('seals and rereads an exact content-addressed evidence tree', async () => {
    const stored = await sealRunRegrade('2026-09-08T10:00:00.000Z')
    const reread = await readRegradedRunRecord(stored.recordPath)

    expect(reread.digest).toBe(stored.digest)
    expect((await lstat(reread.leaf)).mode & 0o777).toBe(0o500)
    expect((await lstat(reread.recordPath)).mode & 0o777).toBe(0o400)
  })

  it('does not publish a canonical leaf before semantic validation succeeds', async () => {
    await expect(
      sealRunRegrade(
        '2026-09-08T10:00:00.000Z',
        async () => { throw new Error('semantic mismatch') }
      )
    ).rejects.toThrow('semantic mismatch')

    const categoryRoot = resolve(root, '.results/fixture-run/regrades')
    const entries = await readdir(categoryRoot)

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(/^\.staging-/)
  })

  it.each(['record-mode', 'raw-manifest-mode', 'extra-entry'] as const)(
    'rejects sealed regrade %s drift',
    async (mutation) => {
      const stored = await sealRunRegrade('2026-09-08T10:00:00.000Z')

      if (mutation === 'record-mode') await chmod(stored.recordPath, 0o500)

      if (mutation === 'raw-manifest-mode') {
        await chmod(resolve(stored.leaf, 'raw-manifest.json'), 0o500)
      }

      if (mutation === 'extra-entry') {
        await chmod(stored.leaf, 0o700)
        await writeFile(resolve(stored.leaf, 'extra'), '', { mode: 0o400 })
        await chmod(stored.leaf, 0o500)
      }

      await expect(
        readRegradedRunRecord(stored.recordPath)
      ).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
    }
  )

  it('rejects ambiguous exact-resume records', async () => {
    await sealRunRegrade('2026-09-08T10:00:00.000Z')
    await sealRunRegrade('2026-09-08T11:00:00.000Z')

    await expect(
      findRegradedRunRecord(root, 'fixture-run', digest('1'))
    ).rejects.toMatchObject({ code: 'RECORD_CONFLICT' })
  })
})
