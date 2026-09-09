import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { TaskDocumentSchema, type TaskDocument } from '@harness-bench/schemas'
import * as v from 'valibot'
import { ScoringMigrationDefinitionSchema, type ScoringMigrationDefinition } from './regrade-contracts.ts'
import type { ExperimentPlan } from './experiment-contracts.ts'
import { experimentHash } from './experiment-storage.ts'
import { RunError } from './run-errors.ts'
import { inspectRunTree, readStableRunFile, type RunTreeSnapshot } from './run.ts'
import { scanCredentialBytes } from './secret-scan.ts'
import { inspectHarborTaskPackage, type TaskPackageInspection } from './task-package.ts'

export interface ResolvedScoringMigrationTarget {
  readonly documentDigest: string;
  readonly documentPath: string;
  readonly packageDigest: string;
  readonly packageInspection: TaskPackageInspection;
  readonly packagePath: string;
  readonly packageSnapshot: RunTreeSnapshot;
  readonly sourceTask: TaskDocument;
  readonly targetTask: TaskDocument;
  readonly taskId: string;
}

export interface ResolvedScoringMigrationDefinition {
  readonly definition: ScoringMigrationDefinition;
  readonly digest: string;
  readonly targets: readonly ResolvedScoringMigrationTarget[];
}

interface ParsedDocument<T> {
  readonly digest: string;
  readonly document: T;
}

function sha256(contents: Uint8Array): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

async function parseDocument<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  path: string,
  schema: TSchema,
  label: string
): Promise<ParsedDocument<v.InferOutput<TSchema>>> {
  const contents = await readStableRunFile(path)

  if (scanCredentialBytes(contents, { path: label }).length > 0) {
    throw new RunError('INVALID_DOCUMENT', `${label} contains a credential pattern`)
  }

  let candidate: unknown

  try {
    candidate = JSON.parse(contents.toString('utf8'))
  } catch (error) {
    throw new RunError('INVALID_DOCUMENT', `${label} is not valid JSON`, {
      cause: error
    })
  }

  const parsed = v.safeParse(schema, candidate)

  if (!parsed.success) {
    throw new RunError('INVALID_DOCUMENT', `${label} is invalid`)
  }

  return {
    digest: sha256(contents),
    document: parsed.output
  }
}

// Projects the task fields that a scoring migration is never allowed to change.
export function scoringMigrationTaskBehaviorIdentity(task: TaskDocument): unknown {
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

export interface ScoringMigrationEvaluatorIdentity {
  readonly verifier_revision: string;
  readonly verifier_image_digest: string;
  readonly verifier_network_enforcement_sidecar_digest:
    TaskDocument['verifier']['network_enforcement_sidecar_digest'];
  readonly scoring_revision: string;
  readonly rubric_revision: string;
  readonly rubric_digest: string;
}

// Projects the evaluator identity persisted in regrade and migration records.
export function scoringMigrationEvaluatorIdentity(
  task: TaskDocument
): ScoringMigrationEvaluatorIdentity {
  return {
    verifier_revision: task.verifier.revision,
    verifier_image_digest: task.verifier.image_digest,

    verifier_network_enforcement_sidecar_digest:
      task.verifier.network_enforcement_sidecar_digest,

    scoring_revision: task.scoring.revision,
    rubric_revision: task.scoring.rubric_revision,
    rubric_digest: experimentHash(task.rubric)
  }
}

function evaluatorChangeIdentity(task: TaskDocument): unknown {
  return {
    verifier: task.verifier,
    scoring: task.scoring,
    rubric: task.rubric
  }
}

function sourceTaskInput(plan: ExperimentPlan, taskId: string): string {
  const taskIndex = plan.experiment.tasks.findIndex(
    ({ task_id }) => task_id === taskId
  )

  const binding = plan.definition.tasks[taskIndex]

  if (taskIndex < 0 || binding === undefined) {
    throw new RunError(
      'RELATIONSHIP_MISMATCH',
      'Scoring migration target does not belong to the experiment'
    )
  }

  return binding.document
}

function assertPlanInputDigest(
  plan: ExperimentPlan,
  path: string,
  digest: string
): void {
  const absolutePath = resolve(path)

  const inputs = plan.inputs.filter(
    (input) => input.kind === 'task_document' && resolve(input.path) === absolutePath
  )

  if (inputs.length !== 1 || inputs[0]?.digest !== digest) {
    throw new RunError(
      'INPUT_CHANGED',
      'Original TaskDocument differs from the frozen experiment plan'
    )
  }
}

function assertTargetSet(
  plan: ExperimentPlan,
  definition: ScoringMigrationDefinition
): void {
  const planned = plan.experiment.tasks
    .map(({ task_id }) => task_id)
    .sort()

  const targeted = definition.targets
    .map(({ task_id }) => task_id)
    .sort()

  if (!isDeepStrictEqual(planned, targeted)) {
    throw new RunError(
      'RELATIONSHIP_MISMATCH',
      'Scoring migration must target every experiment task exactly once'
    )
  }
}

export async function resolveScoringMigrationDefinition(
  path: string,
  plan: ExperimentPlan
): Promise<ResolvedScoringMigrationDefinition> {
  const definitionPath = resolve(path)

  const parsed = await parseDocument(
    definitionPath,
    ScoringMigrationDefinitionSchema,
    'Scoring migration definition'
  )

  const definition = parsed.document

  if (
    definition.experiment_id !== plan.experiment.experiment_id ||
    definition.experiment_revision !== plan.experiment.revision ||
    definition.plan_digest !== plan.experiment.plan_digest
  ) {
    throw new RunError(
      'RELATIONSHIP_MISMATCH',
      'Scoring migration definition does not match the frozen experiment plan'
    )
  }

  assertTargetSet(plan, definition)

  const base = dirname(definitionPath)
  const targets: ResolvedScoringMigrationTarget[] = []
  let evaluatorChanged = false

  for (const binding of definition.targets) {
    const sourceDocumentPath = sourceTaskInput(plan, binding.task_id)
    const targetDocumentPath = resolve(base, binding.document)
    const packagePath = resolve(base, binding.package)

    const source = await parseDocument(
      sourceDocumentPath,
      TaskDocumentSchema,
      'Original TaskDocument'
    )

    const target = await parseDocument(
      targetDocumentPath,
      TaskDocumentSchema,
      'Target TaskDocument'
    )

    assertPlanInputDigest(plan, sourceDocumentPath, source.digest)

    if (
      target.document.task_id !== binding.task_id ||
      !isDeepStrictEqual(
        scoringMigrationTaskBehaviorIdentity(source.document),
        scoringMigrationTaskBehaviorIdentity(target.document)
      )
    ) {
      throw new RunError(
        'RELATIONSHIP_MISMATCH',
        'Scoring migration target changes the task behavior contract'
      )
    }

    const sourceRubricDigest = experimentHash(source.document.rubric)
    const targetRubricDigest = experimentHash(target.document.rubric)

    if (
      sourceRubricDigest !== targetRubricDigest &&
      source.document.scoring.rubric_revision ===
        target.document.scoring.rubric_revision
    ) {
      throw new RunError(
        'RELATIONSHIP_MISMATCH',
        'Scoring migration changes rubric content without a rubric revision change'
      )
    }

    evaluatorChanged ||= !isDeepStrictEqual(
      evaluatorChangeIdentity(source.document),
      evaluatorChangeIdentity(target.document)
    )

    const packageSnapshot = await inspectRunTree(packagePath)

    const packageInspection = inspectHarborTaskPackage(
      packageSnapshot,
      target.document,
      plan.experiment.budget
    )

    targets.push({
      documentDigest: target.digest,
      documentPath: targetDocumentPath,
      packageDigest: packageSnapshot.digest,
      packageInspection,
      packagePath,
      packageSnapshot,
      sourceTask: source.document,
      targetTask: target.document,
      taskId: binding.task_id
    })
  }

  if (!evaluatorChanged) {
    throw new RunError(
      'RELATIONSHIP_MISMATCH',
      'Scoring migration does not change verifier, scoring, or rubric identity'
    )
  }

  targets.sort((left, right) => left.taskId.localeCompare(right.taskId))

  const digest = experimentHash({
    document_type: definition.document_type,
    schema_version: definition.schema_version,
    migration_id: definition.migration_id,
    revision: definition.revision,
    experiment_id: definition.experiment_id,
    experiment_revision: definition.experiment_revision,
    plan_digest: definition.plan_digest,

    targets: targets.map((target) => ({
      task_id: target.taskId,
      document_digest: target.documentDigest,
      package_digest: target.packageDigest,
      verifier: target.targetTask.verifier,
      scoring: target.targetTask.scoring
    }))
  })

  return {
    definition,
    digest,
    targets
  }
}
