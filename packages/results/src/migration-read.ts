import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { inspectHarborTaskPackage, inspectRunTree, type ExperimentPlan } from '@harness-bench/core'
import { TaskDocumentSchema, type TaskDocument } from '@harness-bench/schemas'
import * as v from 'valibot'

import {
  readExperimentComparisonSource,
  type ExperimentComparisonRunRecord,
  type ExperimentComparisonSource
} from './experiment.ts'

import { ResultError } from './errors.ts'
import { readStableFile } from './storage.ts'
import { readRegradedRunRecord, readScoringMigrationRecord } from './regrade-storage.ts'
import { assertRegradeSourceIntegrity } from './regrade.ts'
import type { RegradeEvaluatorIdentity } from './regrade-schemas.ts'

function taskBehaviorIdentity(task: TaskDocument): unknown {
  return {
    task_id: task.task_id,
    revision: task.revision,
    base_commit: task.base_commit,
    source_digest: task.source_digest,
    environment: task.environment,
    collector: task.collector,
    prompt: task.prompt,
    declared_artifacts: task.declared_artifacts,
    scope: task.scope,
    online_reachability: task.online_reachability,
    retention: task.retention
  }
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

async function taskDocument(path: string): Promise<TaskDocument | null> {
  const source = await readStableFile(path)
  let candidate: unknown

  try {
    candidate = JSON.parse(source.toString('utf8'))
  } catch {
    return null
  }

  const parsed = v.safeParse(TaskDocumentSchema, candidate)

  return parsed.success ? parsed.output : null
}

async function sourceTaskDocument(
  runDirectory: string,
  taskId: string
): Promise<TaskDocument> {
  const documentsRoot = resolve(runDirectory, 'inputs/documents')
  const matches: TaskDocument[] = []

  for (const name of await readdir(documentsRoot)) {
    const candidate = await taskDocument(resolve(documentsRoot, name))

    if (candidate?.task_id === taskId) matches.push(candidate)
  }

  if (matches.length !== 1) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Source run does not retain exactly one matching TaskDocument',
      { stage: 'input' }
    )
  }

  return matches[0]!
}

async function assertTargetContract(
  plan: ExperimentPlan,
  source: ExperimentComparisonRunRecord,
  regrade: NonNullable<ExperimentComparisonRunRecord['regrade']>,
  sourceTask: TaskDocument
): Promise<void> {
  const targetDocumentPath = resolve(
    regrade.leaf,
    regrade.record.evidence.target_document_path
  )

  const targetTask = await taskDocument(targetDocumentPath)

  if (
    targetTask === null ||
    !isDeepStrictEqual(
      taskBehaviorIdentity(sourceTask),
      taskBehaviorIdentity(targetTask)
    ) ||
    !isDeepStrictEqual(
      evaluatorIdentity(targetTask),
      regrade.record.target.evaluator
    )
  ) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Regrade target changes the task behavior contract or evaluator identity',
      { stage: 'input' }
    )
  }

  const targetPackagePath = resolve(
    regrade.leaf,
    regrade.record.evidence.target_package_path
  )

  const targetPackage = await inspectRunTree(targetPackagePath)

  inspectHarborTaskPackage(targetPackage, targetTask, plan.experiment.budget)

  if (source.record.identities.task.id !== targetTask.task_id) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Regrade target task identity differs from its source run',
      { stage: 'input' }
    )
  }
}

function assertExactTargetSet(
  plan: ExperimentPlan,
  migration: Awaited<ReturnType<typeof readScoringMigrationRecord>>
): void {
  const expected = plan.experiment.tasks.map(({ task_id }) => task_id).sort()
  const actual = migration.record.targets.map(({ task_id }) => task_id).sort()

  if (!isDeepStrictEqual(expected, actual)) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Scoring migration task inventory differs from its experiment',
      { stage: 'input' }
    )
  }
}

export async function readRegradedExperimentComparisonSource(
  plan: ExperimentPlan,
  migrationPath: string
): Promise<ExperimentComparisonSource> {
  const source = await readExperimentComparisonSource(plan)
  const migration = await readScoringMigrationRecord(migrationPath, plan)

  assertExactTargetSet(plan, migration)

  if (migration.record.entries.length !== source.records.length) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Scoring migration does not cover every verified experiment assignment',
      { stage: 'input' }
    )
  }

  const entries = new Map(
    migration.record.entries.map((entry) => [entry.run_id, entry])
  )

  const records: ExperimentComparisonRunRecord[] = []

  for (const normalized of source.records) {
    const runId = normalized.record.identities.run.run_id
    const entry = entries.get(runId)

    if (
      entry === undefined ||
      entry.attempt_id !== normalized.record.identities.run.attempt_id ||
      entry.source_normalized_digest !== normalized.digest
    ) {
      throw new ResultError(
        'INCOMPATIBLE_EVIDENCE',
        'Scoring migration entry differs from its verified assignment',
        { stage: 'input' }
      )
    }

    const sourceTask = await sourceTaskDocument(
      normalized.runDirectory,
      normalized.record.identities.task.id
    )

    const target = migration.record.targets.find(
      ({ task_id }) => task_id === sourceTask.task_id
    )

    if (
      target === undefined ||
      !isDeepStrictEqual(target.source_evaluator, evaluatorIdentity(sourceTask))
    ) {
      throw new ResultError(
        'INCOMPATIBLE_EVIDENCE',
        'Scoring migration source evaluator identity differs',
        { stage: 'input' }
      )
    }

    if (!normalized.record.outcome.valid_grade) {
      if (
        entry.status !== 'retained_technical' ||
        entry.classification !== normalized.record.outcome.classification
      ) {
        throw new ResultError(
          'INCOMPATIBLE_EVIDENCE',
          'Technical source outcome was replaced with an invented grade',
          { stage: 'input' }
        )
      }

      records.push(normalized)

      continue
    }

    if (entry.status !== 'regraded') {
      throw new ResultError(
        'INCOMPATIBLE_EVIDENCE',
        'Valid source grade is missing its regraded result',
        { stage: 'input' }
      )
    }

    const expectedPath = resolve(plan.runs_directory, entry.regraded_record_path)
    const regrade = await readRegradedRunRecord(expectedPath)

    if (
      regrade.digest !== entry.regraded_record_digest ||
      regrade.record.migration_definition_digest !==
        migration.record.identity.definition_digest ||
      regrade.record.target.task_document_digest !== target.task_document_digest ||
      regrade.record.target.task_package_digest !== target.task_package_digest ||
      !isDeepStrictEqual(regrade.record.target.evaluator, target.target_evaluator)
    ) {
      throw new ResultError(
        'INCOMPATIBLE_EVIDENCE',
        'Regraded result differs from its scoring migration manifest',
        { stage: 'input' }
      )
    }

    await assertRegradeSourceIntegrity(
      regrade,
      normalized,
      migration.record.identity.definition_digest
    )

    const record: ExperimentComparisonRunRecord = {
      ...normalized,
      regrade
    }

    await assertTargetContract(plan, record, regrade, sourceTask)
    records.push(record)
  }

  return {
    records,
    state: source.state,
    migration
  }
}
