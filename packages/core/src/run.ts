import { inspectHarborTaskPackage, type PackageImageReferences, type PackageRuntimeControls } from './task-package.ts'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import {
  ExperimentDocumentSchema,
  HarnessDocumentSchema,
  InitialRunRecordSchema,
  StackDocumentSchema,
  SuiteDocumentSchema,
  TaskDocumentSchema,
  validateDocumentRelationships,
  type ExperimentDocument,
  type HarnessDocument,
  type InitialRunRecord,
  type StackDocument,
  type SuiteDocument,
  type TaskDocument
} from '@harness-bench/schemas'

import * as v from 'valibot'
import { inspectHarnessBundleForRun } from './harness.ts'
import { RunError } from './run-errors.ts'
import { inspectTaskSource, type TaskTreeEntry } from './task.ts'

const PINNED_CODEX_VERSION = '0.153.2'
const PINNED_HARBOR_VERSION = '0.22.0'
const SHA256_PREFIX = 'sha256:'

interface InputFile {
  readonly digest: string;
  readonly path: string;
}

interface ResolvedRunExperiment {
  readonly id: string;
  readonly revision: string;
  readonly plan_digest: string;
  readonly arm_id: string;
  readonly block_id: string;
  readonly replicate: number;
}

interface ResolvedHarnessBundleInput {
  readonly digest: string;
  readonly path: string;
}

interface ResolvedTaskPackageInput {
  readonly digest: string;
  readonly image_references: PackageImageReferences;
  readonly path: string;
  readonly runtime_controls: PackageRuntimeControls;
}

interface ResolvedTaskSourceInput {
  readonly digest: string;
  readonly entries: readonly TaskTreeEntry[];
  readonly path: string;
}

interface ResolvedRunInputs {
  readonly experiment: InputFile;
  readonly harness_bundle: ResolvedHarnessBundleInput;
  readonly harness_documents: readonly InputFile[];
  readonly stacks: readonly InputFile[];
  readonly suite: InputFile;
  readonly task_documents: readonly InputFile[];
  readonly task_package: ResolvedTaskPackageInput;
  readonly task_source: ResolvedTaskSourceInput;
}

interface ResolvedRunnerControls {
  readonly config_digest: string;
  readonly concurrency: 1;
  readonly max_retries: 0;
  readonly telemetry: 'off';
  readonly version: '0.22.0';
}

export interface RunHostIdentity {
  readonly apple_silicon_model: string;
  readonly architecture: 'arm64';
  readonly benchmark_repo_commit: string;
  readonly container_architecture: 'linux/arm64';
  readonly docker_desktop_version: string;
  readonly docker_engine_version: string;
  readonly linuxkit_kernel: string;
  readonly os: 'macos';
  readonly os_version: string;
}

interface InitialRecordContext {
  readonly attempt: number;
  readonly experiment: ResolvedRunExperiment;
  readonly runId: string;
  readonly stack: StackDocument;
  readonly suite: SuiteDocument;
  readonly task: TaskDocument;
}

const resolvedPlans = new WeakSet<object>()

export interface ResolveRunPlanOptions {
  readonly experiment: string;
  readonly harnessBundle: string;
  readonly harnessDocuments: readonly string[];
  readonly runId: string;
  readonly runsDirectory: string;
  readonly stackDocuments: readonly string[];
  readonly suite: string;
  readonly taskDocuments: readonly string[];
  readonly taskPackage: string;
  readonly taskSource: string;
}

export interface ResolvedRunPlan {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly attempt_id: string;
  readonly attempt: number;
  readonly experiment: ResolvedRunExperiment;
  readonly stack: StackDocument;
  readonly harness: HarnessDocument;
  readonly suite: SuiteDocument;
  readonly task: TaskDocument;
  readonly budget: StackDocument['budget'];
  readonly inputs: ResolvedRunInputs;
  readonly runner: ResolvedRunnerControls;
  readonly runs_directory: string;
}

// Shared sentinel used by result disposition to prevent run-ID reuse.
export function runDispositionReservationPath(
  runsDirectory: string,
  runId: string
): string {
  return resolve(runsDirectory, '.run-reservations', runId)
}

export type RunExecutionResult =
  | {
      readonly classification: 'task_success' | 'task_failure';
      readonly completion_path: string;
      readonly run_directory: string;
      readonly valid_grade: true;
    }
  | {
      readonly classification:
        | 'agent_failure'
        | 'provider_failure'
        | 'runner_failure'
        | 'verifier_failure'
        | 'infrastructure_failure'
        | 'cancellation';
      readonly completion_path: string;
      readonly run_directory: string;
      readonly valid_grade: false;
    }

function sha256(contents: Uint8Array | string): string {
  return `${SHA256_PREFIX}${createHash('sha256').update(contents).digest('hex')}`
}

function gitObjectId(type: 'blob' | 'commit' | 'tree', contents: Buffer): Buffer {
  const header = Buffer.from(`${type} ${contents.byteLength}\0`)

  return createHash('sha1').update(header).update(contents).digest()
}

async function deterministicBaseCommit(
  sourceRoot: string,
  entries: readonly TaskTreeEntry[]
): Promise<string> {
  interface TreeNode {
    readonly files: Map<string, { readonly executable: boolean; readonly id: Buffer }>;
    readonly directories: Map<string, TreeNode>;
  }

  const root: TreeNode = {
    directories: new Map(),
    files: new Map()
  }

  for (const entry of entries) {
    const segments = entry.path.split('/')
    const filename = segments.pop()

    if (filename === undefined) {
      throw new RunError('INVALID_DOCUMENT', 'Task source path is empty')
    }

    let node = root

    for (const segment of segments) {
      let child = node.directories.get(segment)

      if (child === undefined) {
        child = {
          directories: new Map(),
          files: new Map()
        }

        node.directories.set(segment, child)
      }

      node = child
    }

    node.files.set(filename, {
      executable: entry.executable,
      id: gitObjectId('blob', await readStableRunFile(resolve(sourceRoot, entry.path)))
    })
  }

  function treeId(node: TreeNode): Buffer {
    const children = [
      ...[...node.files].map(([name, file]) => ({
        id: file.id,
        mode: file.executable ? '100755' : '100644',
        name,
        sortName: name
      })),
      ...[...node.directories].map(([name, directory]) => ({
        id: treeId(directory),
        mode: '40000',
        name,
        sortName: `${name}/`
      }))
    ].sort((left, right) => compareText(left.sortName, right.sortName))

    const contents = Buffer.concat(children.map(({ id, mode, name }) =>
      Buffer.concat([Buffer.from(`${mode} ${name}\0`), id])
    ))

    return gitObjectId('tree', contents)
  }

  const tree = treeId(root).toString('hex')
  const identity = 'Harness Bench <benchmark@example.invalid> 946684800 +0000'

  const commit = Buffer.from(
    `tree ${tree}\nauthor ${identity}\ncommitter ${identity}\n\nchore: materialize task base\n`
  )

  return gitObjectId('commit', commit).toString('hex')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function issueText(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues
    .map((issue) => `${v.getDotPath(issue) ?? '<document>'}: ${issue.message}`)
    .join('; ')
}

export async function readStableRunFile(path: string): Promise<Buffer> {
  const absolutePath = resolve(path)
  let handle

  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)

    const before = await handle.stat()
    const contents = await handle.readFile()
    const after = await handle.stat()
    const current = await lstat(absolutePath)

    if (
      !before.isFile() ||
      !after.isFile() ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.dev !== current.dev ||
      after.ino !== current.ino
    ) {
      throw new RunError('INPUT_CHANGED', 'Input changed while it was read')
    }

    return contents
  } catch (error) {
    if (error instanceof RunError) {
      throw error
    }

    throw new RunError('INVALID_DOCUMENT', 'Input document is unavailable', {
      cause: error
    })
  } finally {
    await handle?.close()
  }
}

async function parseDocument<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  path: string,
  schema: TSchema
): Promise<{ readonly digest: string; readonly output: v.InferOutput<TSchema>; readonly path: string }> {
  const absolutePath = resolve(path)
  const contents = await readStableRunFile(absolutePath)
  let candidate: unknown

  try {
    candidate = JSON.parse(contents.toString('utf8'))
  } catch (error) {
    throw new RunError('INVALID_DOCUMENT', 'Input document is not valid JSON', {
      cause: error
    })
  }

  const parsed = v.safeParse(schema, candidate)

  if (!parsed.success) {
    throw new RunError(
      'INVALID_DOCUMENT',
      `Input document does not satisfy schema v1: ${issueText(parsed.issues)}`
    )
  }

  return {
    digest: sha256(contents),
    output: parsed.output,
    path: absolutePath
  }
}

export interface RunTreeSnapshot {
  readonly digest: string;
  readonly entries: readonly TaskTreeEntry[];
  readonly files: ReadonlyMap<string, Buffer>;
}

export async function inspectRunTree(rootPath: string): Promise<RunTreeSnapshot> {
  const root = await realpath(rootPath)
  const rootMetadata = await stat(root)

  if (!rootMetadata.isDirectory()) {
    throw new RunError('INVALID_TASK_PACKAGE', 'Task package must be a directory')
  }

  const entries: { digest: string; executable: boolean; path: string; size: number }[] = []
  const files = new Map<string, Buffer>()

  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true })

    children.sort((left, right) => compareText(left.name, right.name))

    for (const child of children) {
      const absolutePath = resolve(directory, child.name)
      const path = relative(root, absolutePath).split('\\').join('/')
      const metadata = await lstat(absolutePath)
      const segments = path.split('/')

      if (
        path.startsWith('/') ||
        path.includes('\\') ||
        segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
        segments.some((segment) =>
          ['.git', 'auth', 'credentials', 'solution'].includes(segment.toLowerCase())
        )
      ) {
        throw new RunError('INVALID_TASK_PACKAGE', 'Task package contains an unsafe path')
      }

      if (metadata.isSymbolicLink()) {
        throw new RunError('INVALID_TASK_PACKAGE', 'Task package contains a symbolic link')
      }

      if (metadata.isDirectory()) {
        await visit(absolutePath)

        continue
      }

      if (!metadata.isFile()) {
        throw new RunError('INVALID_TASK_PACKAGE', 'Task package contains a special entry')
      }

      const contents = await readStableRunFile(absolutePath)
      const digest = sha256(contents)

      entries.push({
        digest,
        executable: (metadata.mode & 0o111) !== 0,
        path,
        size: contents.byteLength
      })

      files.set(path, contents)
    }
  }

  await visit(root)

  if (entries.length === 0) {
    throw new RunError('INVALID_TASK_PACKAGE', 'Task package is empty')
  }

  return {
    digest: sha256(JSON.stringify(entries)),
    entries,
    files
  }
}

function runnerControlDigest(stack: StackDocument): string {
  return sha256(JSON.stringify({
    agent: 'codex',
    agent_cli_version: stack.agent.cli_version,
    agent_timeout_seconds: stack.budget.wall_clock_seconds,
    concurrency: 1,
    cpu_count: stack.budget.cpu_count,
    cpu_enforcement_policy: 'limit',
    environment: 'docker',
    harbor_version: stack.runner.version,
    max_retries: 0,
    memory_megabytes: stack.budget.memory_megabytes,
    memory_enforcement_policy: 'limit',
    n_attempts: 1,
    network_policy: stack.network_policy.mode,
    telemetry: stack.runner.telemetry.effective,
    verifier_environment: 'separate',
    verifier_network: 'none'
  }))
}

export function buildInitialRunRecord(
  context: InitialRecordContext,
  host: RunHostIdentity,
  createdAt: string
): InitialRunRecord {
  const { experiment, stack, suite, task } = context

  return v.parse(InitialRunRecordSchema, {
    document_type: 'run',
    schema_version: 1,
    record_type: 'initial',

    identity: {
      run_id: context.runId,
      attempt_id: `${context.runId}-attempt-${context.attempt}`,
      attempt: context.attempt
    },

    created_at: createdAt,
    benchmark_repo_commit: host.benchmark_repo_commit,

    stack: {
      id: stack.stack_id,
      revision: stack.revision,
      digest: stack.digest
    },

    suite: {
      id: suite.suite_id,
      revision: suite.revision,
      digest: suite.digest
    },

    task: {
      id: task.task_id,
      revision: task.revision,
      base_commit: task.base_commit,
      source_digest: task.source_digest,
      environment_image_digest: task.environment.digest
    },

    collector: task.collector,
    verifier: task.verifier,
    scoring_revision: task.scoring.revision,

    runner: {
      name: stack.runner.name,
      version: stack.runner.version,
      config_digest: stack.runner.config_digest,
      telemetry: stack.runner.telemetry.effective,
      requested_concurrency: stack.runner.concurrency.requested,
      effective_concurrency: stack.runner.concurrency.effective,
      concurrency_enforcement_status: stack.runner.concurrency.enforcement_status
    },

    agent: {
      product: stack.agent.product,
      cli_version: stack.agent.cli_version,
      requested_model: stack.agent.requested_model,
      observed_provider_identity: stack.agent.observed_provider_identity,
      effort: stack.agent.effort,
      auth_mode: stack.agent.auth.mode
    },

    harness: stack.harness,
    network_policy_digest: stack.network_policy.digest,
    effective_permissions_digest: stack.effective_permissions_digest,
    mcp_tools_digest: stack.mcp_tools_digest,
    budget: stack.budget,

    experiment: {
      experiment_id: experiment.id,
      experiment_revision: experiment.revision,
      plan_digest: experiment.plan_digest,
      arm_id: experiment.arm_id,
      block_id: experiment.block_id,
      replicate: experiment.replicate
    },

    retention: task.retention,

    host: {
      os: host.os,
      os_version: host.os_version,
      architecture: host.architecture,
      apple_silicon_model: host.apple_silicon_model,
      docker_desktop_version: host.docker_desktop_version,
      docker_engine_version: host.docker_engine_version,
      linuxkit_kernel: host.linuxkit_kernel,
      container_architecture: host.container_architecture
    }
  })
}

function unresolvedHost(): RunHostIdentity {
  return {
    apple_silicon_model: 'unresolved',
    architecture: 'arm64',
    benchmark_repo_commit: '0000000000000000000000000000000000000000',
    container_architecture: 'linux/arm64',
    docker_desktop_version: 'unresolved',
    docker_engine_version: 'unresolved',
    linuxkit_kernel: 'unresolved',
    os: 'macos',
    os_version: 'unresolved'
  }
}

function assertRuntimeControls(stack: StackDocument, experiment: ExperimentDocument): string {
  if (stack.runner.version !== PINNED_HARBOR_VERSION) {
    throw new RunError('PIN_MISMATCH', `Harbor must be pinned to ${PINNED_HARBOR_VERSION}`)
  }

  if (stack.agent.cli_version !== PINNED_CODEX_VERSION) {
    throw new RunError('PIN_MISMATCH', `Codex must be pinned to ${PINNED_CODEX_VERSION}`)
  }

  if (
    stack.runner.telemetry.requested !== 'off' ||
    stack.runner.telemetry.effective !== 'off' ||
    stack.runner.telemetry.owner_opt_in ||
    stack.runner.concurrency.effective.status !== 'known' ||
    stack.runner.concurrency.effective.value !== 1 ||
    stack.runner.concurrency.enforcement_status !== 'enforced' ||
    experiment.retry_policy.max_attempts_per_arm !== 1 ||
    experiment.retry_policy.retryable_classifications.length !== 0 ||
    stack.budget.cpu_enforcement_status !== 'enforced' ||
    stack.budget.memory_enforcement_status !== 'enforced'
  ) {
    throw new RunError('UNSUPPORTED_CONTROL', 'Run controls are not enforceable by issue 7')
  }

  if (stack.budget.token_or_turn_limit.status === 'known') {
    throw new RunError(
      'UNSUPPORTED_CONTROL',
      'Pinned subscription execution cannot enforce token or turn limits'
    )
  }

  const digest = runnerControlDigest(stack)

  if (digest !== stack.runner.config_digest) {
    throw new RunError(
      'RELATIONSHIP_MISMATCH',
      'Stack runner.config_digest does not match canonical runner controls'
    )
  }

  return digest
}

function uniqueById<T>(values: readonly T[], id: (value: T) => string, label: string): Map<string, T> {
  const result = new Map<string, T>()

  for (const value of values) {
    const key = id(value)

    if (result.has(key)) {
      throw new RunError('INVALID_DOCUMENT', `Duplicate ${label} id: ${key}`)
    }

    result.set(key, value)
  }

  return result
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value
  }

  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, key))
  }

  return Object.freeze(value)
}

function sealResolvedRunPlan(plan: ResolvedRunPlan): ResolvedRunPlan {
  const sealed = deepFreeze(plan)

  resolvedPlans.add(sealed)

  return sealed
}

export function assertResolvedRunPlan(plan: ResolvedRunPlan): void {
  if (!resolvedPlans.has(plan) || !Object.isFrozen(plan)) {
    throw new RunError(
      'RELATIONSHIP_MISMATCH',
      'Run plan must be the immutable result of resolveRunPlan'
    )
  }
}

async function inspectTaskSourceForRun(path: string) {
  try {
    return await inspectTaskSource(path)
  } catch (error) {
    if (error instanceof RunError) {
      throw error
    }

    throw new RunError('INVALID_TASK_PACKAGE', 'Task source is unavailable or unsafe', {
      cause: error
    })
  }
}

async function inspectTaskPackageForRun(path: string): Promise<RunTreeSnapshot> {
  try {
    return await inspectRunTree(path)
  } catch (error) {
    if (error instanceof RunError) {
      throw error
    }

    throw new RunError('INVALID_TASK_PACKAGE', 'Task package is unavailable or unsafe', {
      cause: error
    })
  }
}

async function realRunInputPath(path: string, label: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    throw new RunError('INVALID_TASK_PACKAGE', `${label} is unavailable`, {
      cause: error
    })
  }
}

async function assertRunDestination(
  runsDirectory: string,
  runId: string
): Promise<void> {
  try {
    const runsMetadata = await lstat(runsDirectory)

    if (
      runsMetadata.isSymbolicLink() ||
      !runsMetadata.isDirectory() ||
      (runsMetadata.mode & 0o777) !== 0o700
    ) {
      throw new RunError(
        'DESTINATION_EXISTS',
        'Existing runs-dir must be a real mode-0700 directory'
      )
    }
  } catch (error) {
    if (error instanceof RunError) {
      throw error
    }

    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new RunError('DESTINATION_EXISTS', 'runs-dir is unavailable', {
        cause: error
      })
    }
  }

  const runDirectory = resolve(runsDirectory, runId)

  try {
    await lstat(runDirectory)

    throw new RunError('DESTINATION_EXISTS', 'Run directory already exists')
  } catch (error) {
    if (error instanceof RunError) {
      throw error
    }

    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new RunError('DESTINATION_EXISTS', 'Run destination is unavailable', {
        cause: error
      })
    }
  }

  const reservationPath = runDispositionReservationPath(runsDirectory, runId)

  try {
    await lstat(reservationPath)

    throw new RunError(
      'DESTINATION_EXISTS',
      'Run ID is reserved by an incomplete or completed disposition'
    )
  } catch (error) {
    if (error instanceof RunError) {
      throw error
    }

    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new RunError('DESTINATION_EXISTS', 'Run reservation is unavailable', {
        cause: error
      })
    }
  }
}

export async function resolveRunPlan(
  options: ResolveRunPlanOptions,
  assignedExperiment?: ExperimentDocument
): Promise<ResolvedRunPlan> {
  if (!isAbsolute(options.runsDirectory)) {
    throw new RunError('INVALID_DOCUMENT', 'runs-dir must be an absolute directory')
  }

  const [experimentInput, suiteInput, stackInputs, harnessInputs, taskInputs] = await Promise.all([
    assignedExperiment === undefined
      ? parseDocument(options.experiment, ExperimentDocumentSchema)
      : {
          output: v.parse(ExperimentDocumentSchema, assignedExperiment),
          path: resolve(options.experiment),
          digest: sha256(`${JSON.stringify(assignedExperiment)}\n`)
        },
    parseDocument(options.suite, SuiteDocumentSchema),
    Promise.all(options.stackDocuments.map((path) => parseDocument(path, StackDocumentSchema))),
    Promise.all(options.harnessDocuments.map((path) => parseDocument(path, HarnessDocumentSchema))),
    Promise.all(options.taskDocuments.map((path) => parseDocument(path, TaskDocumentSchema)))
  ])

  const experiment = experimentInput.output
  const suite = suiteInput.output
  const stacks = stackInputs.map(({ output }) => output)
  const harnesses = harnessInputs.map(({ output }) => output)
  const tasks = taskInputs.map(({ output }) => output)
  const stacksById = uniqueById(stacks, ({ stack_id }) => stack_id, 'stack')
  const tasksById = uniqueById(tasks, ({ task_id }) => task_id, 'task')

  uniqueById(harnesses, ({ harness_id }) => harness_id, 'harness')

  const assignments = experiment.blocks.flatMap((block) =>
    block.runs
      .filter(({ run_id }) => run_id === options.runId)
      .map((run) => ({
        armId: run.arm_id,
        attempt: run.attempt,
        blockId: block.block_id,
        completionStatus: block.completion_status,
        replicate: block.replicate,
        selected: run.selected,
        taskId: block.task_id
      }))
  )

  if (assignments.length !== 1) {
    throw new RunError(
      'RELATIONSHIP_MISMATCH',
      `run_id must resolve to exactly one assignment; found ${assignments.length}`
    )
  }

  const assignment = assignments[0]!

  if (assignment.completionStatus !== 'in_progress' || assignment.selected) {
    throw new RunError(
      'RELATIONSHIP_MISMATCH',
      'Assigned run must be unselected in an in-progress experiment block'
    )
  }

  const arm = experiment.arms.find(({ arm_id }) => arm_id === assignment.armId)

  if (arm === undefined) {
    throw new RunError('RELATIONSHIP_MISMATCH', 'Assigned experiment arm is missing')
  }

  const stack = stacksById.get(arm.stack.id)
  const task = tasksById.get(assignment.taskId)

  if (stack === undefined || task === undefined) {
    throw new RunError('RELATIONSHIP_MISMATCH', 'Assigned stack or task is missing')
  }

  const runnerDigest = assertRuntimeControls(stack, experiment)

  const resolvedExperiment = {
    id: experiment.experiment_id,
    revision: experiment.revision,
    plan_digest: experiment.plan_digest,
    arm_id: assignment.armId,
    block_id: assignment.blockId,
    replicate: assignment.replicate
  }

  const initial = buildInitialRunRecord({
    attempt: assignment.attempt,
    experiment: resolvedExperiment,
    runId: options.runId,
    stack,
    suite,
    task
  }, unresolvedHost(), '2000-01-01T00:00:00Z')

  const relationshipIssues = validateDocumentRelationships({
    stacks,
    harnesses,
    suite,
    tasks,
    experiment,
    initial_run: initial,
    initial_run_digest: sha256(JSON.stringify(initial))
  })

  if (relationshipIssues.length > 0) {
    throw new RunError(
      'RELATIONSHIP_MISMATCH',
      relationshipIssues.map(({ path, message }) => `${path}: ${message}`).join('; ')
    )
  }

  const [bundle, sourceSnapshot, packageSnapshot] = await Promise.all([
    inspectHarnessBundleForRun(options.harnessBundle),
    inspectTaskSourceForRun(options.taskSource),
    inspectTaskPackageForRun(options.taskPackage)
  ])

  if (
    bundle.manifest.harness_id !== arm.harness.id ||
    bundle.manifest.revision !== arm.harness.revision ||
    bundle.manifest.digest !== arm.harness.digest ||
    JSON.stringify(bundle.manifest) !== JSON.stringify(
      harnesses.find(({ harness_id }) => harness_id === arm.harness.id)
    )
  ) {
    throw new RunError('INVALID_HARNESS', 'Physical harness bundle does not match selected arm')
  }

  if (bundle.manifest.entries.some(({ path }) => /^rules\/[^/]+\.rules$/.test(path))) {
    throw new RunError(
      'UNSUPPORTED_CONTROL',
      'Harness rules cannot be enforced by the pinned Harbor Codex adapter'
    )
  }

  const mcpEntry = bundle.manifest.entries.find(({ path }) => path === 'mcp-tools.json')

  if (mcpEntry?.digest !== stack.mcp_tools_digest) {
    throw new RunError('RELATIONSHIP_MISMATCH', 'Stack MCP digest does not match harness bundle')
  }

  if (sourceSnapshot.digest !== task.source_digest) {
    throw new RunError('INPUT_CHANGED', 'Task source digest does not match TaskDocument')
  }

  const baseCommit = await deterministicBaseCommit(
    await realRunInputPath(options.taskSource, 'Task source'),
    sourceSnapshot.entries
  )

  if (baseCommit !== task.base_commit) {
    throw new RunError(
      'INPUT_CHANGED',
      'Task source deterministic base commit does not match TaskDocument'
    )
  }

  const packageInspection = inspectHarborTaskPackage(packageSnapshot, task, stack.budget)
  const runsDirectory = resolve(options.runsDirectory)

  await assertRunDestination(runsDirectory, options.runId)

  const plan: ResolvedRunPlan = {
    schema_version: 1,
    run_id: options.runId,
    attempt_id: `${options.runId}-attempt-${assignment.attempt}`,
    attempt: assignment.attempt,
    experiment: resolvedExperiment,
    stack,
    harness: bundle.manifest,
    suite,
    task,
    budget: stack.budget,

    inputs: {
      experiment: {
        digest: experimentInput.digest,
        path: experimentInput.path
      },

      harness_bundle: {
        digest: bundle.manifest.digest,
        path: bundle.bundlePath
      },

      harness_documents: harnessInputs.map(({ digest, path }) => ({
        digest,
        path
      })),

      stacks: stackInputs.map(({ digest, path }) => ({
        digest,
        path
      })),

      suite: {
        digest: suiteInput.digest,
        path: suiteInput.path
      },

      task_documents: taskInputs.map(({ digest, path }) => ({
        digest,
        path
      })),

      task_package: {
        digest: packageSnapshot.digest,
        image_references: packageInspection.imageReferences,
        path: await realRunInputPath(options.taskPackage, 'Task package'),
        runtime_controls: packageInspection.runtimeControls
      },

      task_source: {
        digest: sourceSnapshot.digest,
        entries: sourceSnapshot.entries,
        path: await realRunInputPath(options.taskSource, 'Task source')
      }
    },

    runner: {
      config_digest: runnerDigest,
      concurrency: 1,
      max_retries: 0,
      telemetry: 'off',
      version: PINNED_HARBOR_VERSION
    },

    runs_directory: runsDirectory
  }

  return sealResolvedRunPlan(plan)
}
