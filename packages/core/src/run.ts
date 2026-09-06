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

import { parse as parseToml } from 'smol-toml'
import * as v from 'valibot'
import { parse as parseYaml } from 'yaml'
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

interface PackageImageReferences {
  readonly agent: string;
  readonly collector: string;
  readonly verifier: string;
}

interface PackageRuntimeControls {
  readonly agent_timeout_seconds: number;
  readonly collector_timeout_seconds: number;
  readonly verifier_timeout_seconds: number;
}

interface TaskPackageInspection {
  readonly imageReferences: PackageImageReferences;
  readonly runtimeControls: PackageRuntimeControls;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function requiredTable(table: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = table[key]

  if (!isRecord(value)) {
    throw new RunError('INVALID_TASK_PACKAGE', `Task package is missing [${key}]`)
  }

  return value
}

function requiredString(table: Record<string, unknown>, key: string): string {
  const value = table[key]

  if (typeof value !== 'string' || value === '') {
    throw new RunError('INVALID_TASK_PACKAGE', `Task package field ${key} must be a string`)
  }

  return value
}

function requiredPositiveInteger(
  table: Record<string, unknown>,
  key: string
): number {
  const value = table[key]

  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new RunError(
      'INVALID_TASK_PACKAGE',
      `Task package field ${key} must be a positive integer`
    )
  }

  return Number(value)
}

function parseCompose(source: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown

  if (source.includes('${')) {
    throw new RunError(
      'INVALID_TASK_PACKAGE',
      `${label} must not contain environment interpolation`
    )
  }

  try {
    parsed = parseYaml(source.toString('utf8'), {
      maxAliasCount: 0,
      uniqueKeys: true
    })
  } catch (error) {
    throw new RunError('INVALID_TASK_PACKAGE', `${label} is invalid YAML`, {
      cause: error
    })
  }

  if (!isRecord(parsed)) {
    throw new RunError('INVALID_TASK_PACKAGE', `${label} must be a YAML object`)
  }

  return parsed
}

function assertSafeVolume(volume: unknown, label: string): void {
  if (typeof volume === 'string') {
    const [source, target] = volume.split(':')

    if (
      source === undefined ||
      target === undefined ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source) ||
      !target.startsWith('/') ||
      target.includes('docker.sock')
    ) {
      throw new RunError(
        'INVALID_TASK_PACKAGE',
        `${label} may use only named Docker volumes`
      )
    }

    return
  }

  if (
    !isRecord(volume) ||
    volume.type !== 'volume' ||
    typeof volume.source !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(volume.source) ||
    typeof volume.target !== 'string' ||
    !volume.target.startsWith('/') ||
    volume.target.includes('docker.sock')
  ) {
    throw new RunError(
      'INVALID_TASK_PACKAGE',
      `${label} may use only named Docker volumes`
    )
  }
}

function assertSafeComposeService(
  service: Record<string, unknown>,
  label: string
): void {
  if (
    service.build !== undefined ||
    service.cpus !== undefined ||
    service.privileged === true ||
    service.pid === 'host' ||
    service.ipc === 'host' ||
    service.userns_mode === 'host' ||
    service.network_mode === 'host' ||
    service.cap_add !== undefined ||
    service.configs !== undefined ||
    service.deploy !== undefined ||
    service.devices !== undefined ||
    service.env_file !== undefined ||
    service.expose !== undefined ||
    service.extends !== undefined ||
    service.mem_limit !== undefined ||
    service.mem_reservation !== undefined ||
    service.ports !== undefined ||
    service.profiles !== undefined ||
    service.pull_policy !== undefined ||
    service.restart !== undefined ||
    service.secrets !== undefined ||
    service.security_opt !== undefined ||
    service.volumes_from !== undefined
  ) {
    throw new RunError(
      'INVALID_TASK_PACKAGE',
      `${label} requests unsupported host or privilege access`
    )
  }

  if (service.volumes === undefined) {
    return
  }

  if (!Array.isArray(service.volumes)) {
    throw new RunError('INVALID_TASK_PACKAGE', `${label} volumes must be an array`)
  }

  for (const volume of service.volumes) {
    assertSafeVolume(volume, label)
  }
}

function assertExactComposeServices(
  services: Record<string, Record<string, unknown>>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(services).sort(compareText)

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new RunError(
      'INVALID_TASK_PACKAGE',
      `${label} service inventory is not exact`
    )
  }
}

function assertExactServiceVolumes(
  service: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  if (
    !Array.isArray(service.volumes) ||
    JSON.stringify(service.volumes) !== JSON.stringify(expected)
  ) {
    throw new RunError(
      'INVALID_TASK_PACKAGE',
      `${label} volume contract is not exact`
    )
  }
}

function assertSafeTopLevelVolumes(
  compose: Record<string, unknown>,
  label: string,
  expected: readonly string[]
): void {
  if (compose.volumes === undefined) {
    if (expected.length > 0) {
      throw new RunError(
        'INVALID_TASK_PACKAGE',
        `${label} named volume inventory is not exact`
      )
    }

    return
  }

  if (!isRecord(compose.volumes)) {
    throw new RunError('INVALID_TASK_PACKAGE', `${label} volumes must be an object`)
  }

  for (const [name, volume] of Object.entries(compose.volumes)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) ||
      (volume !== null && (!isRecord(volume) || Object.keys(volume).length > 0))
    ) {
      throw new RunError(
        'INVALID_TASK_PACKAGE',
        `${label} may declare only ordinary project-local named volumes`
      )
    }
  }

  const actual = Object.keys(compose.volumes).sort(compareText)

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new RunError(
      'INVALID_TASK_PACKAGE',
      `${label} named volume inventory is not exact`
    )
  }
}

function composeServices(
  compose: Record<string, unknown>,
  label: string
): Record<string, Record<string, unknown>> {
  const services = compose.services

  if (!isRecord(services)) {
    throw new RunError('INVALID_TASK_PACKAGE', `${label} must declare services`)
  }

  const result: Record<string, Record<string, unknown>> = {}

  for (const [name, service] of Object.entries(services)) {
    if (!isRecord(service)) {
      throw new RunError('INVALID_TASK_PACKAGE', `${label} service ${name} is invalid`)
    }

    assertSafeComposeService(service, `${label} service ${name}`)

    result[name] = service
  }

  return result
}

function requiredEnvironmentVariables(
  service: Record<string, unknown>,
  label: string
): Record<string, unknown> {
  if (!isRecord(service.environment)) {
    throw new RunError('INVALID_TASK_PACKAGE', `${label} environment must be an object`)
  }

  return service.environment
}

function assertTaskPackage(
  snapshot: RunTreeSnapshot,
  stack: StackDocument,
  task: TaskDocument
): TaskPackageInspection {
  const taskToml = snapshot.files.get('task.toml')
  const compose = snapshot.files.get('environment/docker-compose.yaml')
  const verifierCompose = snapshot.files.get('tests/docker-compose.yaml')

  if (taskToml === undefined || compose === undefined || verifierCompose === undefined) {
    throw new RunError(
      'INVALID_TASK_PACKAGE',
      'Task package must contain task.toml and environment/docker-compose.yaml'
    )
  }

  const prompt = snapshot.files.get(task.prompt.path)

  if (prompt === undefined || sha256(prompt) !== task.prompt.digest) {
    throw new RunError(
      'INVALID_TASK_PACKAGE',
      'Task package prompt does not match TaskDocument'
    )
  }

  if ([...snapshot.files.values()].some((contents) => contents.includes('__'))) {
    throw new RunError('INVALID_TASK_PACKAGE', 'Task package contains unresolved template tokens')
  }

  let parsed: unknown

  try {
    parsed = parseToml(taskToml.toString('utf8'))
  } catch (error) {
    throw new RunError('INVALID_TASK_PACKAGE', 'Task package task.toml is invalid', {
      cause: error
    })
  }

  if (!isRecord(parsed)) {
    throw new RunError('INVALID_TASK_PACKAGE', 'Task package task.toml must be a table')
  }

  const metadata = requiredTable(parsed, 'metadata')
  const agent = requiredTable(parsed, 'agent')
  const environment = requiredTable(parsed, 'environment')
  const verifier = requiredTable(parsed, 'verifier')
  const verifierEnvironment = requiredTable(verifier, 'environment')
  const verifierEnvironmentVariables = requiredTable(verifier, 'env')
  const agentTimeout = requiredPositiveInteger(agent, 'timeout_sec')
  const verifierTimeout = requiredPositiveInteger(verifier, 'timeout_sec')
  const collect = verifier.collect
  const artifacts = parsed.artifacts

  const declaredArtifacts = [...task.declared_artifacts]
    .map(({ path, required }) => ({
      path,
      required
    }))
    .sort((left, right) => compareText(left.path, right.path))

  if (
    JSON.stringify(declaredArtifacts) !== JSON.stringify([
      {
        path: 'workspace-metadata.json',
        required: true
      },
      {
        path: 'workspace.patch',
        required: true
      }
    ])
  ) {
    throw new RunError(
      'INVALID_TASK_PACKAGE',
      'Issue 7 requires the exact trusted collector artifact contract'
    )
  }

  if (!Array.isArray(collect) || collect.length !== 1 || !isRecord(collect[0])) {
    throw new RunError(
      'INVALID_TASK_PACKAGE',
      'Task package must declare exactly one trusted collector hook'
    )
  }

  const collectorHook = collect[0]
  const collectorTimeout = requiredPositiveInteger(collectorHook, 'timeout_sec')

  if (
    collectorHook.service !== 'collector' ||
    typeof collectorHook.command !== 'string' ||
    !/^node(?: --experimental-strip-types)? \/opt\/collector\/[A-Za-z0-9._/-]+$/.test(
      collectorHook.command
    ) ||
    !Array.isArray(artifacts) ||
    artifacts.length !== 1 ||
    !isRecord(artifacts[0]) ||
    artifacts[0].source !== '/evidence' ||
    artifacts[0].destination !== 'trusted-collector' ||
    artifacts[0].service !== 'collector'
  ) {
    throw new RunError(
      'INVALID_TASK_PACKAGE',
      'Task package collector and artifact declarations are not exact'
    )
  }

  if (
    metadata.provider_calls !== 0 ||
    metadata.automatic_retries !== 0 ||
    metadata.harbor_telemetry !== 'off' ||
    agentTimeout !== stack.budget.wall_clock_seconds ||
    agent.network_mode !== 'public' ||
    environment.cpus !== stack.budget.cpu_count ||
    environment.memory_mb !== stack.budget.memory_megabytes ||
    environment.network_mode !== 'public' ||
    verifier.environment_mode !== 'separate' ||
    verifier.network_mode !== 'no-network' ||
    verifierEnvironment.cpus !== stack.budget.cpu_count ||
    verifierEnvironment.memory_mb !== stack.budget.memory_megabytes ||
    verifierEnvironment.network_mode !== 'no-network' ||
    verifierEnvironmentVariables.TASK_BASE_COMMIT !== task.base_commit ||
    verifierEnvironmentVariables.TASK_SOURCE_DIGEST !== task.source_digest
  ) {
    throw new RunError(
      'INVALID_TASK_PACKAGE',
      'Task package controls do not match the selected stack and task'
    )
  }

  const environmentCompose = parseCompose(compose, 'Agent Compose file')
  const verifierComposeDocument = parseCompose(verifierCompose, 'Verifier Compose file')

  assertSafeTopLevelVolumes(environmentCompose, 'Agent Compose file', ['workspace'])
  assertSafeTopLevelVolumes(verifierComposeDocument, 'Verifier Compose file', [])

  const environmentServices = composeServices(environmentCompose, 'Agent Compose file')
  const verifierServices = composeServices(verifierComposeDocument, 'Verifier Compose file')
  const mainService = environmentServices.main
  const collectorService = environmentServices.collector
  const verifierMainService = verifierServices.main

  assertExactComposeServices(
    environmentServices,
    ['collector', 'main'],
    'Agent Compose file'
  )

  assertExactComposeServices(verifierServices, ['main'], 'Verifier Compose file')

  if (
    mainService === undefined ||
    collectorService === undefined ||
    verifierMainService === undefined ||
    (
      mainService.network_mode !== undefined &&
      mainService.network_mode !== 'bridge' &&
      mainService.network_mode !== 'default'
    ) ||
    mainService.image !== undefined ||
    collectorService.network_mode !== 'none' ||
    collectorService.command !== undefined ||
    collectorService.entrypoint !== undefined ||
    verifierMainService.image !== undefined ||
    verifierMainService.network_mode !== 'none'
  ) {
    throw new RunError(
      'INVALID_TASK_PACKAGE',
      'Task collector or verifier controls do not match TaskDocument'
    )
  }

  assertExactServiceVolumes(mainService, ['workspace:/app'], 'Agent main service')

  assertExactServiceVolumes(
    collectorService,
    ['workspace:/workspace:ro'],
    'Collector service'
  )

  if (verifierMainService.volumes !== undefined) {
    throw new RunError(
      'INVALID_TASK_PACKAGE',
      'Verifier service must not declare volumes'
    )
  }

  const collectorEnvironment = requiredEnvironmentVariables(
    collectorService,
    'Collector service'
  )

  if (
    collectorEnvironment.TASK_BASE_COMMIT !== task.base_commit ||
    collectorEnvironment.TASK_SOURCE_DIGEST !== task.source_digest
  ) {
    throw new RunError(
      'INVALID_TASK_PACKAGE',
      'Task collector identity does not match TaskDocument'
    )
  }

  const collectorImage = collectorService.image

  if (typeof collectorImage !== 'string' || collectorImage === '') {
    throw new RunError('INVALID_TASK_PACKAGE', 'Collector service image is missing')
  }

  return {
    imageReferences: {
      agent: requiredString(environment, 'docker_image'),
      collector: collectorImage,
      verifier: requiredString(verifierEnvironment, 'docker_image')
    },

    runtimeControls: {
      agent_timeout_seconds: agentTimeout,
      collector_timeout_seconds: collectorTimeout,
      verifier_timeout_seconds: verifierTimeout
    }
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
}

export async function resolveRunPlan(
  options: ResolveRunPlanOptions
): Promise<ResolvedRunPlan> {
  if (!isAbsolute(options.runsDirectory)) {
    throw new RunError('INVALID_DOCUMENT', 'runs-dir must be an absolute directory')
  }

  const [experimentInput, suiteInput, stackInputs, harnessInputs, taskInputs] = await Promise.all([
    parseDocument(options.experiment, ExperimentDocumentSchema),
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

  const packageInspection = assertTaskPackage(packageSnapshot, stack, task)
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
