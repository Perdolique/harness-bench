import { readFile, readdir } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  RunError,
  executeHarborRegrade,
  experimentHash,
  inspectRunTree,
  lockExperiment,
  preflightHarborRegrade,
  readExperimentPlan,
  resolveScoringMigrationDefinition,
  type ExecuteHarborRegradeOptions,
  type HarborRegradeEvidence,
  type HarborRegradePreflightOptions,
  type ResolvedScoringMigrationTarget
} from '@harness-bench/core'

import type { TaskDocument } from '@harness-bench/schemas'
import { readExperimentComparisonSource } from './experiment.ts'
import { ResultError } from './errors.ts'
import type { ReadNormalizedRunRecordResult } from './read.ts'

import type {
  RegradeEvaluatorIdentity,
  RegradedRunRecordV1,
  ScoringMigrationEntryV1,
  ScoringMigrationRecordV1
} from './regrade-schemas.ts'

import {
  findRegradedRunRecord,
  prepareRegradeStaging,
  quarantineRegradeStaging,
  sealRegradedRunRecord,
  writeScoringMigrationRecord,
  type ReadRegradedRunRecordResult,
  type StoredScoringMigrationRecord
} from './regrade-storage.ts'

import { sha256, withRunResultLocks } from './storage.ts'

export interface ExperimentRegradeRuntime {
  readonly execute: (
    options: ExecuteHarborRegradeOptions
  ) => Promise<HarborRegradeEvidence>;
  readonly now: () => Date;
  readonly preflight: (
    options: HarborRegradePreflightOptions
  ) => Promise<void>;
}

export interface ExperimentRegradeResult {
  readonly migration: StoredScoringMigrationRecord;
  readonly regradedRuns: number;
  readonly retainedTechnicalRuns: number;
}

const defaultRuntime: ExperimentRegradeRuntime = {
  execute: executeHarborRegrade,
  now: () => new Date(),
  preflight: preflightHarborRegrade
}

function evaluatorIdentity(task: TaskDocument): RegradeEvaluatorIdentity {
  return {
    verifier_revision: task.verifier.revision,
    verifier_image_digest: task.verifier.image_digest,

    verifier_network_enforcement_sidecar_digest:
      task.verifier.network_enforcement_sidecar_digest,

    scoring_revision: task.scoring.revision,
    rubric_revision: task.scoring.rubric_revision
  }
}

function sourceEvaluatorIdentity(
  source: ReadNormalizedRunRecordResult,
  target: ResolvedScoringMigrationTarget
): RegradeEvaluatorIdentity {
  const score = source.record.score

  if (score.status !== 'known') return evaluatorIdentity(target.sourceTask)

  return {
    verifier_revision: source.record.revisions.verifier_revision,
    verifier_image_digest: source.record.revisions.verifier_image_digest,

    verifier_network_enforcement_sidecar_digest:
      source.record.revisions.verifier_network_enforcement_sidecar_digest,

    scoring_revision: source.record.revisions.scoring_revision,
    rubric_revision: score.document.rubric_revision
  }
}

function validSourceEvaluatorIdentity(
  source: ReadNormalizedRunRecordResult
): RegradeEvaluatorIdentity {
  if (source.record.score.status !== 'known') {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Regraded source does not have an original valid score',
      { stage: 'input' }
    )
  }

  return {
    verifier_revision: source.record.revisions.verifier_revision,
    verifier_image_digest: source.record.revisions.verifier_image_digest,

    verifier_network_enforcement_sidecar_digest:
      source.record.revisions.verifier_network_enforcement_sidecar_digest,

    scoring_revision: source.record.revisions.scoring_revision,
    rubric_revision: source.record.score.document.rubric_revision
  }
}

function targetForSource(
  targets: readonly ResolvedScoringMigrationTarget[],
  source: ReadNormalizedRunRecordResult
): ResolvedScoringMigrationTarget {
  const taskId = source.record.identities.task.id
  const matching = targets.filter((target) => target.taskId === taskId)

  if (matching.length !== 1) {
    throw new RunError(
      'RELATIONSHIP_MISMATCH',
      'Verified experiment run has no unique scoring migration target'
    )
  }

  return matching[0]!
}

function regradedRecord(
  source: ReadNormalizedRunRecordResult,
  target: ResolvedScoringMigrationTarget,
  evidence: HarborRegradeEvidence,
  migrationDefinitionDigest: string,
  createdAt: string
): RegradedRunRecordV1 {
  const originalEvaluator = sourceEvaluatorIdentity(source, target)
  const targetEvaluator = evaluatorIdentity(target.targetTask)

  return {
    document_type: 'regraded_run',
    schema_version: 1,
    regrade_revision: '1',
    record_type: 'regraded',
    created_at: createdAt,
    migration_definition_digest: migrationDefinitionDigest,

    source: {
      run_id: source.record.identities.run.run_id,
      attempt_id: source.record.identities.run.attempt_id,
      normalized_digest: source.digest,

      normalized_record_path: relative(
        resolve(
          dirname(source.runDirectory),
          '.results',
          source.record.identities.run.run_id
        ),
        source.recordPath
      ).split('\\').join('/'),

      raw_manifest_digest: source.record.source_digests.raw_manifest,
      run_tree_digest: evidence.sourceRunTreeDigest,
      agent_identity_digest: experimentHash(source.record.identities.agent),
      usage_digest: experimentHash(source.record.usage),
      evaluator: originalEvaluator,

      trial: {
        trial_id: evidence.sourceTrial.trialId,
        task_name: evidence.sourceTrial.taskName,
        task_digest: evidence.sourceTrial.taskDigest,
        config_digest: evidence.sourceTrial.configDigest,
        lock_digest: evidence.sourceTrial.lockDigest,
        result_digest: evidence.sourceTrial.resultDigest
      }
    },

    target: {
      task_id: target.taskId,
      task_document_digest: target.documentDigest,
      task_package_digest: target.packageDigest,
      materialized_task_package_digest: evidence.materializedPackageDigest,
      task_lock_digest: evidence.targetTaskDigest,
      evaluator: targetEvaluator
    },

    provenance: {
      harbor_version: '0.22.0',
      action: 'regrade',
      source_trial_id: evidence.sourceTrial.trialId,
      source_task_digest: evidence.sourceTrial.taskDigest,
      target_task_digest: evidence.targetTaskDigest
    },

    outcome: {
      classification: evidence.classification,
      valid_grade: true
    },

    score: evidence.score,

    timings: {
      verifier_seconds: evidence.verifierSeconds
    },

    regrade_provider_calls: 0,

    evidence: {
      target_document_path: evidence.targetDocumentPath,
      target_package_path: evidence.targetPackagePath,

      materialized_target_package_path:
        evidence.materializedTargetPackagePath,

      raw_manifest_path: evidence.rawManifestPath,
      config_path: evidence.configPath,
      lock_path: evidence.lockPath,
      result_path: evidence.resultPath,
      verifier_result_path: evidence.verifierResultPath,
      raw_manifest_digest: evidence.rawManifestDigest,
      config_digest: evidence.configDigest,
      lock_digest: evidence.lockDigest,
      result_digest: evidence.resultDigest,
      verifier_result_digest: evidence.verifierResultDigest
    }
  }
}

async function sourceTrialDirectory(
  source: ReadNormalizedRunRecordResult
): Promise<string> {
  const jobRoot = resolve(source.runDirectory, 'raw/harbor/job')
  const entries = await readdir(jobRoot, { withFileTypes: true })

  const trials = entries.filter(
    (entry) =>
      entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      entry.name !== '.sources'
  )

  if (trials.length !== 1) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Source run does not contain exactly one Harbor trial',
      { stage: 'input' }
    )
  }

  return resolve(jobRoot, trials[0]!.name)
}

async function digestFile(path: string): Promise<string> {
  return sha256(await readFile(path))
}

export async function assertRegradeSourceIntegrity(
  regrade: ReadRegradedRunRecordResult,
  source: ReadNormalizedRunRecordResult,
  migrationDefinitionDigest: string
): Promise<void> {
  const record = regrade.record
  const sourceTree = await inspectRunTree(source.runDirectory)
  const sourceTrial = await sourceTrialDirectory(source)

  const regradedTrial = dirname(
    resolve(regrade.leaf, record.evidence.config_path)
  )

  const [sourceAgent, regradedAgent, sourceArtifacts, regradedArtifacts] =
    await Promise.all([
      inspectRunTree(resolve(sourceTrial, 'agent')),
      inspectRunTree(resolve(regradedTrial, 'agent')),
      inspectRunTree(resolve(sourceTrial, 'artifacts')),
      inspectRunTree(resolve(regradedTrial, 'artifacts'))
    ])

  const [configDigest, lockDigest, resultDigest] = await Promise.all([
    digestFile(resolve(sourceTrial, 'config.json')),
    digestFile(resolve(sourceTrial, 'lock.json')),
    digestFile(resolve(sourceTrial, 'result.json'))
  ])

  const expectedSourceEvaluator = validSourceEvaluatorIdentity(source)

  const matches =
    record.migration_definition_digest === migrationDefinitionDigest &&
    record.source.run_id === source.record.identities.run.run_id &&
    record.source.attempt_id === source.record.identities.run.attempt_id &&
    record.source.normalized_digest === source.digest &&
    record.source.normalized_record_path ===
      relative(
        resolve(
          dirname(source.runDirectory),
          '.results',
          source.record.identities.run.run_id
        ),
        source.recordPath
      ).split('\\').join('/') &&
    record.source.raw_manifest_digest ===
      source.record.source_digests.raw_manifest &&
    record.source.run_tree_digest === sourceTree.digest &&
    record.source.agent_identity_digest ===
      experimentHash(source.record.identities.agent) &&
    record.source.usage_digest === experimentHash(source.record.usage) &&
    record.source.trial.config_digest === configDigest &&
    record.source.trial.lock_digest === lockDigest &&
    record.source.trial.result_digest === resultDigest &&
    record.target.task_id === source.record.identities.task.id &&
    isDeepStrictEqual(record.source.evaluator, expectedSourceEvaluator) &&
    sourceAgent.digest === regradedAgent.digest &&
    sourceArtifacts.digest === regradedArtifacts.digest

  if (!matches) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Regraded result does not match its immutable source or migration target',
      { stage: 'input' }
    )
  }
}

async function assertRegradeMatchesSource(
  regrade: ReadRegradedRunRecordResult,
  source: ReadNormalizedRunRecordResult,
  target: ResolvedScoringMigrationTarget,
  migrationDefinitionDigest: string
): Promise<void> {
  await assertRegradeSourceIntegrity(
    regrade,
    source,
    migrationDefinitionDigest
  )

  const record = regrade.record
  const expectedTargetEvaluator = evaluatorIdentity(target.targetTask)

  const targetMatches =
    record.target.task_id === target.taskId &&
    record.target.task_document_digest === target.documentDigest &&
    record.target.task_package_digest === target.packageDigest &&
    isDeepStrictEqual(record.target.evaluator, expectedTargetEvaluator)

  if (!targetMatches) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Regraded result does not match the resolved migration target',
      { stage: 'input' }
    )
  }
}

function technicalEntry(
  source: ReadNormalizedRunRecordResult
): ScoringMigrationEntryV1 {
  const classification = source.record.outcome.classification

  if (classification === 'task_success' || classification === 'task_failure') {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Quality outcome is missing its valid grade',
      { stage: 'input' }
    )
  }

  return {
    run_id: source.record.identities.run.run_id,
    attempt_id: source.record.identities.run.attempt_id,
    source_normalized_digest: source.digest,
    status: 'retained_technical',
    classification
  }
}

async function regradeSource(
  source: ReadNormalizedRunRecordResult,
  target: ResolvedScoringMigrationTarget,
  definitionDigest: string,
  runtime: ExperimentRegradeRuntime
): Promise<ReadRegradedRunRecordResult> {
  const runId = source.record.identities.run.run_id

  const existing = await findRegradedRunRecord(
    dirname(source.runDirectory),
    runId,
    definitionDigest
  )

  if (existing !== null) {
    await assertRegradeMatchesSource(
      existing,
      source,
      target,
      definitionDigest
    )

    return existing
  }

  const runsRoot = dirname(source.runDirectory)
  const staging = await prepareRegradeStaging(runsRoot, runId)

  try {
    const evidence = await runtime.execute({
      migrationDefinitionDigest: definitionDigest,
      runId,
      sourceRunDirectory: source.runDirectory,
      staging,
      target
    })

    const record = regradedRecord(
      source,
      target,
      evidence,
      definitionDigest,
      runtime.now().toISOString()
    )

    const sealed = await sealRegradedRunRecord(staging, record)

    await assertRegradeMatchesSource(
      sealed,
      source,
      target,
      definitionDigest
    )

    return sealed
  } catch (error) {
    await quarantineRegradeStaging(staging).catch(() => undefined)

    throw error
  }
}

function assertExperimentComplete(
  source: Awaited<ReturnType<typeof readExperimentComparisonSource>>
): void {
  const incomplete = source.state.blocks.some(
    (block) =>
      block.status !== 'completed' ||
      block.runs.some((run) => run.status !== 'verified')
  )

  if (source.state.superseded || incomplete) {
    throw new RunError(
      'EXECUTION_FAILED',
      'Only a complete current experiment plan can be regraded'
    )
  }
}

export async function regradeExperiment(
  planPath: string,
  definitionPath: string,
  runtime: ExperimentRegradeRuntime = defaultRuntime
): Promise<ExperimentRegradeResult> {
  const plan = await readExperimentPlan(planPath)
  const releaseExperiment = await lockExperiment(plan)

  try {
    const source = await readExperimentComparisonSource(plan)

    assertExperimentComplete(source)

    const migration = await resolveScoringMigrationDefinition(
      definitionPath,
      plan
    )

    const runIds = source.records.map(
      ({ record }) => record.identities.run.run_id
    )

    return withRunResultLocks(plan.runs_directory, runIds, async () => {
      const entries: ScoringMigrationEntryV1[] = []
      let regradedRuns = 0
      let retainedTechnicalRuns = 0

      for (const record of source.records) {
        if (!record.record.outcome.valid_grade) continue

        await runtime.preflight({
          sourceRunDirectory: record.runDirectory,
          target: targetForSource(migration.targets, record)
        })
      }

      for (const record of source.records) {
        const target = targetForSource(migration.targets, record)

        if (!record.record.outcome.valid_grade) {
          entries.push(technicalEntry(record))

          retainedTechnicalRuns += 1

          continue
        }

        const regraded = await regradeSource(
          record,
          target,
          migration.digest,
          runtime
        )

        const recordPath = relative(
          plan.runs_directory,
          regraded.recordPath
        ).split('\\').join('/')

        entries.push({
          run_id: record.record.identities.run.run_id,
          attempt_id: record.record.identities.run.attempt_id,
          source_normalized_digest: record.digest,
          status: 'regraded',
          regraded_record_digest: regraded.digest,
          regraded_record_path: recordPath
        })

        regradedRuns += 1
      }

      entries.sort((left, right) => left.run_id.localeCompare(right.run_id))

      const migrationRecord: ScoringMigrationRecordV1 = {
        document_type: 'scoring_migration',
        schema_version: 1,
        migration_revision: '1',
        record_type: 'migration',
        created_at: runtime.now().toISOString(),

        identity: {
          migration_id: migration.definition.migration_id,
          revision: migration.definition.revision,
          definition_digest: migration.digest
        },

        experiment: {
          experiment_id: plan.experiment.experiment_id,
          experiment_revision: plan.experiment.revision,
          plan_digest: plan.experiment.plan_digest
        },

        targets: migration.targets.map((target) => ({
          task_id: target.taskId,
          task_document_digest: target.documentDigest,
          task_package_digest: target.packageDigest,
          source_evaluator: evaluatorIdentity(target.sourceTask),
          target_evaluator: evaluatorIdentity(target.targetTask)
        })),

        entries,
        regrade_provider_calls: 0
      }

      const stored = await writeScoringMigrationRecord(plan, migrationRecord)

      return {
        migration: stored,
        regradedRuns,
        retainedTechnicalRuns
      }
    })
  } finally {
    await releaseExperiment()
  }
}
