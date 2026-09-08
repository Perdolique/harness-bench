import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import * as v from 'valibot'
import { ScoringMigrationScoreSchema, type ScoringMigrationScore } from './regrade-contracts.ts'
import type { ResolvedScoringMigrationTarget } from './regrade-plan.ts'
import { RunError } from './run-errors.ts'

import {
  assertPinnedTaskImages,
  assertScoreEvidence,
  materializePinnedTaskPackage,
  runHarborRegradeProcess,
  type HarborExecutionOutcome,
  type HarborRegradeExecutionContext
} from './run-execution.ts'

import { inspectRunTree, readStableRunFile, type RunTreeSnapshot } from './run.ts'
import { scanCredentialTree } from './secret-scan.ts'
import { assertHarborArtifactInventory } from './task-artifacts.ts'

interface RawManifestEntry {
  readonly digest: string;
  readonly executable: boolean;
  readonly path: string;
  readonly size: number;
}

interface SourceTrialEvidence {
  readonly agentResult: Record<string, unknown>;
  readonly agentInfo: Record<string, unknown>;
  readonly configDigest: string;
  readonly lockDigest: string;
  readonly resultDigest: string;
  readonly taskDigest: string;
  readonly taskName: string;
  readonly trialId: string;
  readonly trialPath: string;
}

export interface HarborRegradeRuntime {
  readonly runHarbor: (
    context: HarborRegradeExecutionContext
  ) => Promise<HarborExecutionOutcome>;
}

export interface ExecuteHarborRegradeOptions {
  readonly migrationDefinitionDigest: string;
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly sourceRunDirectory: string;
  readonly staging: string;
  readonly target: ResolvedScoringMigrationTarget;
}

export interface HarborRegradePreflightOptions {
  readonly sourceRunDirectory: string;
  readonly target: ResolvedScoringMigrationTarget;
}

export interface HarborRegradeEvidence {
  readonly classification: 'task_success' | 'task_failure';
  readonly configDigest: string;
  readonly configPath: string;
  readonly lockDigest: string;
  readonly lockPath: string;
  readonly materializedPackageDigest: string;
  readonly materializedTargetPackagePath: string;
  readonly rawManifest: readonly RawManifestEntry[];
  readonly rawManifestDigest: string;
  readonly rawManifestPath: string;
  readonly resultDigest: string;
  readonly resultPath: string;
  readonly score: ScoringMigrationScore;
  readonly sourceRunTreeDigest: string;
  readonly sourceTrial: SourceTrialEvidence;
  readonly targetDocumentPath: string;
  readonly targetPackagePath: string;
  readonly targetTaskDigest: string;
  readonly verifierResultDigest: string;
  readonly verifierResultPath: string;
  readonly verifierSeconds: number;
}

function sha256(contents: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RunError('INVALID_EVIDENCE', `${label} is missing or invalid`, {
      stage: 'finalization'
    })
  }

  return value
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new RunError('INVALID_EVIDENCE', `${label} is missing or invalid`, {
      stage: 'finalization'
    })
  }

  return value
}

async function jsonFile(
  path: string,
  label: string
): Promise<{ readonly contents: Buffer; readonly value: unknown }> {
  const contents = await readStableRunFile(path)
  let value: unknown

  try {
    value = JSON.parse(contents.toString('utf8'))
  } catch (error) {
    throw new RunError('INVALID_EVIDENCE', `${label} is not valid JSON`, {
      cause: error,
      stage: 'finalization'
    })
  }

  return {
    contents,
    value
  }
}

async function onlyTrial(jobRoot: string): Promise<string> {
  const entries = await readdir(jobRoot, { withFileTypes: true })

  const directories = entries.filter(
    (entry) =>
      entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      entry.name !== '.sources'
  )

  if (directories.length !== 1) {
    throw new RunError(
      'INVALID_EVIDENCE',
      'Harbor source must contain exactly one local trial',
      { stage: 'finalization' }
    )
  }

  return resolve(jobRoot, directories[0]!.name)
}

function assertArtifactManifest(candidate: unknown): void {
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw new RunError(
      'INVALID_EVIDENCE',
      'Harbor source artifact manifest is missing',
      { stage: 'finalization' }
    )
  }

  for (const entry of candidate) {
    const record = requiredRecord(entry, 'Harbor artifact manifest entry')
    const status = record.status

    if (status !== 'ok' && status !== 'empty') {
      throw new RunError(
        'INVALID_EVIDENCE',
        'Harbor source contains a failed or skipped artifact',
        { stage: 'finalization' }
      )
    }
  }
}

async function inspectSourceTrial(
  sourceRunDirectory: string
): Promise<SourceTrialEvidence> {
  const trialPath = await onlyTrial(
    resolve(sourceRunDirectory, 'raw/harbor/job')
  )

  const configPath = resolve(trialPath, 'config.json')
  const lockPath = resolve(trialPath, 'lock.json')
  const resultPath = resolve(trialPath, 'result.json')
  const manifestPath = resolve(trialPath, 'artifacts/manifest.json')

  const [configFile, lockFile, resultFile, manifestFile] = await Promise.all([
    jsonFile(configPath, 'Harbor source config'),
    jsonFile(lockPath, 'Harbor source lock'),
    jsonFile(resultPath, 'Harbor source result'),
    jsonFile(manifestPath, 'Harbor source artifact manifest')
  ])

  const config = requiredRecord(configFile.value, 'Harbor source config')
  const lock = requiredRecord(lockFile.value, 'Harbor source lock')
  const result = requiredRecord(resultFile.value, 'Harbor source result')
  const task = requiredRecord(lock.task, 'Harbor source task lock')
  const agentInfo = requiredRecord(result.agent_info, 'Harbor source agent identity')
  const agentResult = requiredRecord(result.agent_result, 'Harbor source agent result')
  const taskName = requiredString(task.name, 'Harbor source task name')
  const taskDigest = requiredString(task.digest, 'Harbor source task digest')
  const trialId = requiredString(result.id, 'Harbor source trial ID')

  if (
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(taskName) ||
    !/^sha256:[a-f0-9]{64}$/.test(taskDigest) ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(trialId) ||
    task.type !== 'local' ||
    config.source_trial !== undefined ||
    lock.source_trial !== undefined ||
    result.step_results !== null ||
    result.exception_info !== null ||
    result.verifier_environment_mode !== 'separate' ||
    result.environment_setup === null ||
    result.agent_setup === null ||
    result.agent_execution === null
  ) {
    throw new RunError(
      'INVALID_EVIDENCE',
      'Harbor source is not a completed single-step local trial',
      { stage: 'finalization' }
    )
  }

  assertArtifactManifest(manifestFile.value)
  await assertHarborArtifactInventory(resolve(trialPath, 'artifacts'))

  return {
    agentInfo,
    agentResult,
    configDigest: sha256(configFile.contents),
    lockDigest: sha256(lockFile.contents),
    resultDigest: sha256(resultFile.contents),
    taskDigest,
    taskName,
    trialId,
    trialPath
  }
}

async function writeCopiedFile(
  destination: string,
  contents: Buffer,
  executable: boolean
): Promise<void> {
  await mkdir(dirname(destination), {
    recursive: true,
    mode: 0o700
  })

  await writeFile(destination, contents, {
    flag: 'wx',
    mode: executable ? 0o700 : 0o600
  })
}

async function copySnapshot(
  snapshot: RunTreeSnapshot,
  destination: string,
  label: string
): Promise<void> {
  for (const entry of snapshot.entries) {
    const contents = snapshot.files.get(entry.path)

    if (contents === undefined) {
      throw new RunError('INPUT_CHANGED', `${label} snapshot is incomplete`)
    }

    await writeCopiedFile(
      resolve(destination, entry.path),
      contents,
      entry.executable
    )
  }

  const copied = await inspectRunTree(destination)

  if (copied.digest !== snapshot.digest) {
    throw new RunError('INPUT_CHANGED', `${label} changed while it was copied`)
  }
}

async function rawManifest(rawRoot: string): Promise<readonly RawManifestEntry[]> {
  const snapshot = await inspectRunTree(rawRoot)

  return snapshot.entries.map((entry) => ({
    digest: entry.digest,
    executable: entry.executable,
    path: entry.path,
    size: entry.size
  }))
}

function relativeEvidencePath(staging: string, path: string): string {
  return relative(staging, path).split('\\').join('/')
}

function verifierSeconds(result: Record<string, unknown>): number {
  const verifier = requiredRecord(result.verifier, 'Harbor regrade verifier timing')
  const startedAt = requiredString(verifier.started_at, 'Harbor verifier start')
  const finishedAt = requiredString(verifier.finished_at, 'Harbor verifier finish')
  const elapsed = Date.parse(finishedAt) - Date.parse(startedAt)

  if (!Number.isFinite(elapsed) || elapsed < 0) {
    throw new RunError(
      'INVALID_EVIDENCE',
      'Harbor regrade verifier timing is invalid',
      { stage: 'finalization' }
    )
  }

  return Math.ceil(elapsed / 1_000)
}

async function assertSameTree(
  source: string,
  regraded: string,
  label: string
): Promise<void> {
  const [sourceTree, regradedTree] = await Promise.all([
    inspectRunTree(source),
    inspectRunTree(regraded)
  ])

  if (sourceTree.digest !== regradedTree.digest) {
    throw new RunError(
      'INVALID_EVIDENCE',
      `Harbor regrade changed recorded ${label}`,
      { stage: 'finalization' }
    )
  }
}

async function validateRegradeTrial(
  source: SourceTrialEvidence,
  regradedTrial: string,
  options: ExecuteHarborRegradeOptions
): Promise<Omit<HarborRegradeEvidence,
  | 'materializedPackageDigest'
  | 'materializedTargetPackagePath'
  | 'rawManifest'
  | 'rawManifestDigest'
  | 'rawManifestPath'
  | 'sourceRunTreeDigest'
  | 'targetDocumentPath'
  | 'targetPackagePath'
>> {
  const configPath = resolve(regradedTrial, 'config.json')
  const lockPath = resolve(regradedTrial, 'lock.json')
  const resultPath = resolve(regradedTrial, 'result.json')
  const verifierResultPath = resolve(regradedTrial, 'verifier/verifier-result.json')
  const scorePath = resolve(regradedTrial, 'verifier/score.json')

  const [configFile, lockFile, resultFile, verifierFile, scoreFile] = await Promise.all([
    jsonFile(configPath, 'Harbor regrade config'),
    jsonFile(lockPath, 'Harbor regrade lock'),
    jsonFile(resultPath, 'Harbor regrade result'),
    jsonFile(verifierResultPath, 'Harbor regrade verifier result'),
    jsonFile(scorePath, 'Harbor regrade score')
  ])

  const config = requiredRecord(configFile.value, 'Harbor regrade config')
  const lock = requiredRecord(lockFile.value, 'Harbor regrade lock')
  const result = requiredRecord(resultFile.value, 'Harbor regrade result')
  const configSource = requiredRecord(config.source_trial, 'Harbor config source_trial')
  const lockSource = requiredRecord(lock.source_trial, 'Harbor lock source_trial')
  const sourceTask = requiredRecord(lockSource.task, 'Harbor source task provenance')
  const targetTask = requiredRecord(lock.task, 'Harbor target task lock')
  const verifier = requiredRecord(lock.verifier, 'Harbor target verifier lock')
  const verifierEnvironment = requiredRecord(verifier.env, 'Harbor target verifier environment')
  const targetTaskDigest = requiredString(targetTask.digest, 'Harbor target task digest')

  const resolvedSourcePath = await realpath(
    requiredString(configSource.path, 'Harbor config source path')
  )

  const resolvedLockSourcePath = await realpath(
    requiredString(lockSource.path, 'Harbor lock source path')
  )

  const resolvedExpectedSource = await realpath(source.trialPath)

  if (
    configSource.action !== 'regrade' ||
    configSource.type !== 'local' ||
    configSource.trial_id !== source.trialId ||
    lockSource.action !== 'regrade' ||
    lockSource.type !== 'local' ||
    lockSource.trial_id !== source.trialId ||
    resolvedSourcePath !== resolvedExpectedSource ||
    resolvedLockSourcePath !== resolvedExpectedSource ||
    sourceTask.name !== source.taskName ||
    sourceTask.digest !== source.taskDigest ||
    targetTask.name !== source.taskName ||
    !/^sha256:[a-f0-9]{64}$/.test(targetTaskDigest) ||
    verifier.environment_mode !== 'separate' ||
    verifierEnvironment.HARBOR_RUN_ID !== options.runId ||
    result.verifier_environment_mode !== 'separate' ||
    result.exception_info !== null ||
    result.step_results !== null ||
    result.environment_setup !== null ||
    result.agent_setup !== null ||
    result.agent_execution !== null ||
    !isDeepStrictEqual(result.agent_info, source.agentInfo) ||
    !isDeepStrictEqual(result.agent_result, source.agentResult)
  ) {
    throw new RunError(
      'INVALID_EVIDENCE',
      'Harbor regrade provenance or retained agent evidence differs',
      { stage: 'finalization' }
    )
  }

  await Promise.all([
    assertSameTree(
      resolve(source.trialPath, 'agent'),
      resolve(regradedTrial, 'agent'),
      'agent evidence'
    ),
    assertSameTree(
      resolve(source.trialPath, 'artifacts'),
      resolve(regradedTrial, 'artifacts'),
      'artifact evidence'
    )
  ])

  const verifierResult = requiredRecord(
    verifierFile.value,
    'Harbor regrade verifier result'
  )

  const integrity = requiredRecord(
    verifierResult.integrity,
    'Harbor regrade verifier integrity'
  )

  const scoreResult = v.safeParse(ScoringMigrationScoreSchema, scoreFile.value)

  if (
    !scoreResult.success ||
    !scoreResult.output.valid_grade ||
    integrity.passed !== true ||
    integrity.credentialsAbsent !== true ||
    integrity.networkIsolated !== true
  ) {
    throw new RunError(
      'INVALID_EVIDENCE',
      'Harbor regrade did not produce a credential-free offline valid grade',
      { stage: 'finalization' }
    )
  }

  const score = scoreResult.output
  const verifierResultDigest = sha256(verifierFile.contents)
  const providerCalls = score.harbor_reward.numeric_values.provider_calls

  if (
    score.run_id !== options.runId ||
    score.scoring_revision !== options.target.targetTask.scoring.revision ||
    score.rubric_revision !== options.target.targetTask.scoring.rubric_revision ||
    score.verifier_result_digest !== verifierResultDigest ||
    providerCalls !== 0
  ) {
    throw new RunError(
      'INVALID_EVIDENCE',
      'Harbor regrade score identity or provider-call evidence differs',
      { stage: 'finalization' }
    )
  }

  assertScoreEvidence(score, verifierResult)

  const classification =
    score.gates.direct_behavior_pass &&
    score.gates.regression_pass &&
    score.gates.verifier_integrity_pass
      ? 'task_success'
      : 'task_failure'

  return {
    classification,
    configDigest: sha256(configFile.contents),
    configPath: relativeEvidencePath(options.staging, configPath),
    lockDigest: sha256(lockFile.contents),
    lockPath: relativeEvidencePath(options.staging, lockPath),
    resultDigest: sha256(resultFile.contents),
    resultPath: relativeEvidencePath(options.staging, resultPath),
    score,
    sourceTrial: source,
    targetTaskDigest,
    verifierResultDigest,
    verifierResultPath: relativeEvidencePath(options.staging, verifierResultPath),
    verifierSeconds: verifierSeconds(result)
  }
}

async function defaultRunHarbor(
  context: HarborRegradeExecutionContext
): Promise<HarborExecutionOutcome> {
  const repositoryRoot = resolve(import.meta.dirname, '../../..')
  const harbor = resolve(repositoryRoot, '.venv/bin/harbor')

  return runHarborRegradeProcess(context, harbor)
}

const defaultRuntime: HarborRegradeRuntime = {
  runHarbor: defaultRunHarbor
}

export async function preflightHarborRegrade(
  options: HarborRegradePreflightOptions
): Promise<void> {
  await inspectRunTree(options.sourceRunDirectory)

  const [targetDocument, currentPackage, sourceScan, targetScan] = await Promise.all([
    readStableRunFile(options.target.documentPath),
    inspectRunTree(options.target.packagePath),
    scanCredentialTree({ root: options.sourceRunDirectory }),
    scanCredentialTree({ root: options.target.packagePath })
  ])

  await inspectSourceTrial(options.sourceRunDirectory)

  if (sourceScan.findings.length > 0 || targetScan.findings.length > 0) {
    throw new RunError(
      'INVALID_EVIDENCE',
      'Regrade source or target contains a credential pattern',
      { stage: 'setup' }
    )
  }

  if (
    sha256(targetDocument) !== options.target.documentDigest ||
    currentPackage.digest !== options.target.packageDigest ||
    !isDeepStrictEqual(
      currentPackage.entries,
      options.target.packageSnapshot.entries
    )
  ) {
    throw new RunError(
      'INPUT_CHANGED',
      'Scoring migration target changed after definition resolution'
    )
  }

  await assertPinnedTaskImages(
    options.target.targetTask,
    options.target.packageInspection.imageReferences
  )
}

async function executeHarborRegradeOnce(
  options: ExecuteHarborRegradeOptions,
  runtime: HarborRegradeRuntime,
  sourceRunTreeDigest: string
): Promise<HarborRegradeEvidence> {
  const sourceTrial = await inspectSourceTrial(options.sourceRunDirectory)
  const inputsRoot = resolve(options.staging, 'inputs')
  const rawRoot = resolve(options.staging, 'raw')
  const targetDocumentPath = resolve(inputsRoot, 'task-document.json')
  const targetPackagePath = resolve(inputsRoot, 'task-package')
  const runnerRoot = resolve(rawRoot, 'runner')
  const harborRoot = resolve(rawRoot, 'harbor')

  await Promise.all([
    mkdir(inputsRoot, {
      recursive: true,
      mode: 0o700
    }),
    mkdir(runnerRoot, {
      recursive: true,
      mode: 0o700
    }),
    mkdir(harborRoot, {
      recursive: true,
      mode: 0o700
    })
  ])

  const targetDocument = await readStableRunFile(options.target.documentPath)

  if (sha256(targetDocument) !== options.target.documentDigest) {
    throw new RunError('INPUT_CHANGED', 'Target TaskDocument changed after resolution')
  }

  await writeCopiedFile(targetDocumentPath, targetDocument, false)

  await copySnapshot(
    options.target.packageSnapshot,
    targetPackagePath,
    'Target task package'
  )

  const workRoot = await mkdtemp('/tmp/harness-bench-regrade-')

  try {
    const taskRoot = resolve(workRoot, 'tasks')
    const materializedTarget = resolve(taskRoot, sourceTrial.taskName)

    const retainedMaterializedTarget = resolve(
      runnerRoot,
      'materialized-task-package'
    )

    await mkdir(taskRoot, {
      recursive: true,
      mode: 0o700
    })

    await materializePinnedTaskPackage(
      options.target.targetTask,
      targetPackagePath,
      materializedTarget
    )

    const materializedSnapshot = await inspectRunTree(materializedTarget)

    await copySnapshot(
      materializedSnapshot,
      retainedMaterializedTarget,
      'Materialized target task package'
    )

    const trialName = `regrade-${options.runId}-${options.migrationDefinitionDigest.slice(7, 19)}`

    const outcome = await runtime.runHarbor({
      runDirectory: workRoot,
      runId: options.runId,
      sourceTrial: sourceTrial.trialPath,
      stderrPath: resolve(runnerRoot, 'stderr.log'),
      stdoutPath: resolve(runnerRoot, 'stdout.log'),
      targetTaskPath: materializedTarget,
      trialName,
      trialsDirectory: harborRoot,

      wallClockSeconds:
        options.target.packageInspection.runtimeControls.verifier_timeout_seconds + 60,

      ...(options.signal === undefined ? {} : { signal: options.signal })
    })

    if (
      outcome.cancelled ||
      outcome.timedOut ||
      outcome.signal !== null ||
      outcome.exitCode !== 0
    ) {
      throw new RunError(
        'EXECUTION_FAILED',
        'Harbor verifier-only regrade failed',
        { stage: 'verification' }
      )
    }

    const regradedTrial = await onlyTrial(harborRoot)

    const validated = await validateRegradeTrial(
      sourceTrial,
      regradedTrial,
      options
    )

    const manifest = await rawManifest(rawRoot)
    const manifestSource = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
    const rawManifestPath = resolve(options.staging, 'raw-manifest.json')

    await writeFile(rawManifestPath, manifestSource, {
      flag: 'wx',
      mode: 0o600
    })

    return {
      ...validated,
      materializedPackageDigest: materializedSnapshot.digest,

      materializedTargetPackagePath: relativeEvidencePath(
        options.staging,
        retainedMaterializedTarget
      ),

      rawManifest: manifest,
      rawManifestDigest: sha256(manifestSource),
      rawManifestPath: relativeEvidencePath(options.staging, rawManifestPath),
      sourceRunTreeDigest,
      targetDocumentPath: relativeEvidencePath(options.staging, targetDocumentPath),
      targetPackagePath: relativeEvidencePath(options.staging, targetPackagePath)
    }
  } finally {
    await chmod(workRoot, 0o700).catch(() => undefined)

    await rm(workRoot, {
      force: true,
      recursive: true
    })
  }
}

export async function executeHarborRegrade(
  options: ExecuteHarborRegradeOptions,
  runtime: HarborRegradeRuntime = defaultRuntime
): Promise<HarborRegradeEvidence> {
  await preflightHarborRegrade(options)

  const sourceBefore = await inspectRunTree(options.sourceRunDirectory)

  let execution:
    | { readonly status: 'completed'; readonly evidence: HarborRegradeEvidence }
    | { readonly status: 'failed'; readonly error: unknown }

  try {
    execution = {
      status: 'completed',

      evidence: await executeHarborRegradeOnce(
        options,
        runtime,
        sourceBefore.digest
      )
    }
  } catch (error) {
    execution = {
      status: 'failed',
      error
    }
  }

  const sourceAfter = await inspectRunTree(options.sourceRunDirectory)

  if (sourceAfter.digest !== sourceBefore.digest) {
    throw new RunError(
      'INVALID_EVIDENCE',
      'Source run changed during verifier-only regrade',
      { stage: 'finalization' }
    )
  }

  if (execution.status === 'failed') throw execution.error

  return execution.evidence
}
