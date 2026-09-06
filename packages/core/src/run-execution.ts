import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { FileHandle } from 'node:fs/promises'

import {
  CompletionRunRecordSchema,
  ScoreDocumentSchema,
  type CompletionRunRecord,
  type ScoreDocument
} from '@harness-bench/schemas'

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import * as v from 'valibot'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { validateWithPinnedCodex } from './codex.ts'
import { materializeHarnessBundle } from './harness.ts'
import { RunError } from './run-errors.ts'

import {
  assertResolvedRunPlan,
  buildInitialRunRecord,
  inspectRunTree,
  readStableRunFile,
  type ResolvedRunPlan,
  type RunExecutionResult,
  type RunHostIdentity
} from './run.ts'

import { inspectTaskSource } from './task.ts'
import { verifyWorkspaceArtifacts } from './task-artifacts.ts'
import { scanCredentialTree } from './secret-scan.ts'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const SHUTDOWN_GRACE_MS = 30_000
const SHA256_PREFIX = 'sha256:'
const HARBOR_VERSION_PATTERN = /(?:^|\s)0\.22\.0(?:$|\s)/
const CODEX_VERSION_PATTERN = /(?:^|\s)0\.153\.2(?:$|\s)/

export interface HarborExecutionContext {
  readonly authDescriptor: number;
  readonly configPath: string;
  readonly runDirectory: string;
  readonly stderrPath: string;
  readonly stdoutPath: string;
  readonly wallClockSeconds: number;
}

export interface HarborExecutionOutcome {
  readonly cancelled: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

export interface RunRuntime {
  readonly inspectHost: (plan: ResolvedRunPlan) => Promise<RunHostIdentity>;
  readonly now: () => Date;
  readonly runHarbor: (
    context: HarborExecutionContext
  ) => Promise<HarborExecutionOutcome>;
}

interface EvidenceOutcome {
  readonly classification: 'task_success' | 'task_failure';
  readonly collection: CompletionRunRecord['collection'];
  readonly score: ScoreDocument;
  readonly verifier: CompletionRunRecord['verifier'];
}

interface RawManifestEntry {
  readonly digest: string;
  readonly executable: boolean;
  readonly path: string;
  readonly size: number;
}

interface SelectedCredential {
  readonly handle: FileHandle;
  readonly leafValues: readonly Buffer[];
  readonly material: Buffer;
  readonly path: string;
}

function sha256(contents: Uint8Array | string): string {
  return `${SHA256_PREFIX}${createHash('sha256').update(contents).digest('hex')}`
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toSeconds(milliseconds: number): number {
  return Math.max(0, Math.ceil(milliseconds / 1_000))
}

function knownEvidence(digest: string): {
  readonly evidence_digest: { readonly status: 'known'; readonly value: string };
  readonly status: 'passed';
} {
  return {
    status: 'passed',

    evidence_digest: {
      status: 'known',
      value: digest
    }
  }
}

function missingEvidence(): {
  readonly evidence_digest: { readonly status: 'unknown'; readonly reason: string };
  readonly status: 'missing';
} {
  return {
    status: 'missing',

    evidence_digest: {
      status: 'unknown',
      reason: 'Trusted evidence was not produced'
    }
  }
}

function safeEnvironment(authPath: string, home = '/tmp'): NodeJS.ProcessEnv {
  return {
    CI: '1',
    CODEX_AUTH_JSON_PATH: authPath,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    DOCKER_HOST: process.env.DOCKER_HOST,
    HARBOR_TELEMETRY: 'off',
    HOME: home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    PATH: process.env.PATH,
    TERM: 'dumb',
    TMPDIR: '/tmp'
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string
): Promise<string> {
  try {
    const result = await execFileAsync(command, [...args], {
      cwd,
      encoding: 'utf8',
      env: safeEnvironment('/dev/null'),
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 60_000
    })

    return result.stdout.trim()
  } catch (error) {
    throw new RunError('HOST_UNSUPPORTED', 'Required host preflight failed', {
      cause: error,
      stage: 'setup'
    })
  }
}

function parseDockerVersion(source: string): {
  readonly engine: string;
  readonly platform: string;
} {
  let candidate: unknown

  try {
    candidate = JSON.parse(source)
  } catch (error) {
    throw new RunError('HOST_UNSUPPORTED', 'Docker version output is invalid', {
      cause: error,
      stage: 'setup'
    })
  }

  if (!isRecord(candidate)) {
    throw new RunError('HOST_UNSUPPORTED', 'Docker version output is invalid')
  }

  const server = candidate.Server

  if (!isRecord(candidate.Client) || !isRecord(server)) {
    throw new RunError('HOST_UNSUPPORTED', 'Docker client and server are required')
  }

  const engine = server.Version
  const os = server.Os
  const architecture = server.Arch

  if (
    typeof engine !== 'string' ||
    typeof os !== 'string' ||
    typeof architecture !== 'string'
  ) {
    throw new RunError('HOST_UNSUPPORTED', 'Docker server identity is incomplete')
  }

  return {
    engine,
    platform: `${os}/${architecture}`
  }
}

function parseImageIdentity(source: string): {
  readonly architecture: string;
  readonly id: string;
  readonly os: string;
} {
  let candidate: unknown

  try {
    candidate = JSON.parse(source)
  } catch (error) {
    throw new RunError('HOST_UNSUPPORTED', 'Docker image identity is invalid', {
      cause: error,
      stage: 'setup'
    })
  }

  if (
    !isRecord(candidate) ||
    typeof candidate.Id !== 'string' ||
    typeof candidate.Os !== 'string' ||
    typeof candidate.Architecture !== 'string'
  ) {
    throw new RunError('HOST_UNSUPPORTED', 'Docker image identity is incomplete', {
      stage: 'setup'
    })
  }

  return {
    architecture: candidate.Architecture,
    id: candidate.Id,
    os: candidate.Os
  }
}

async function inspectDefaultHost(plan: ResolvedRunPlan): Promise<RunHostIdentity> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new RunError(
      'HOST_UNSUPPORTED',
      'Issue 7 supports only macOS on Apple Silicon',
      { stage: 'setup' }
    )
  }

  const repositoryRoot = resolve(import.meta.dirname, '../../..')
  const harbor = resolve(repositoryRoot, '.venv/bin/harbor')
  const codex = resolve(repositoryRoot, 'node_modules/.bin/codex')

  const [
    harborVersion,
    codexVersion,
    osVersion,
    model,
    dockerVersionSource,
    dockerDesktopVersion,
    kernel,
    benchmarkCommit,
    benchmarkStatus
  ] = await Promise.all([
    runCommand(harbor, ['--version'], repositoryRoot),
    runCommand(codex, ['--version'], repositoryRoot),
    runCommand('/usr/bin/sw_vers', ['-productVersion'], repositoryRoot),
    runCommand('/usr/sbin/sysctl', ['-n', 'hw.model'], repositoryRoot),
    runCommand('docker', ['version', '--format={{json .}}'], repositoryRoot),
    runCommand(
      '/usr/bin/defaults',
      ['read', '/Applications/Docker.app/Contents/Info', 'CFBundleShortVersionString'],
      repositoryRoot
    ),
    runCommand('docker', ['info', '--format={{.KernelVersion}}'], repositoryRoot),
    runCommand('git', ['rev-parse', 'HEAD'], repositoryRoot),
    runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], repositoryRoot)
  ])

  if (!HARBOR_VERSION_PATTERN.test(harborVersion)) {
    throw new RunError('PIN_MISMATCH', 'Installed Harbor is not version 0.22.0')
  }

  if (!CODEX_VERSION_PATTERN.test(codexVersion)) {
    throw new RunError('PIN_MISMATCH', 'Installed Codex is not version 0.153.2')
  }

  if (benchmarkStatus !== '') {
    throw new RunError(
      'HOST_UNSUPPORTED',
      'Benchmark repository must be clean before a production run',
      { stage: 'setup' }
    )
  }

  const docker = parseDockerVersion(dockerVersionSource)

  if (
    docker.platform !== 'linux/arm64' ||
    !kernel.toLowerCase().includes('linuxkit')
  ) {
    throw new RunError('HOST_UNSUPPORTED', 'Docker must provide linux/arm64 containers')
  }

  const expectedImages = [
    [plan.inputs.task_package.image_references.agent, plan.task.environment.digest],
    [plan.inputs.task_package.image_references.collector, plan.task.collector.image_digest],
    [plan.inputs.task_package.image_references.verifier, plan.task.verifier.image_digest]
  ] as const

  for (const [reference, expectedDigest] of expectedImages) {
    const imageSource = await runCommand(
      'docker',
      ['image', 'inspect', '--format={{json .}}', reference],
      repositoryRoot
    )

    const image = parseImageIdentity(imageSource)

    if (
      image.id !== expectedDigest ||
      image.os !== 'linux' ||
      image.architecture !== 'arm64'
    ) {
      throw new RunError('PIN_MISMATCH', 'Task package image ID does not match TaskDocument')
    }
  }

  return {
    apple_silicon_model: model,
    architecture: 'arm64',
    benchmark_repo_commit: benchmarkCommit,
    container_architecture: 'linux/arm64',
    docker_desktop_version: dockerDesktopVersion,
    docker_engine_version: docker.engine,
    linuxkit_kernel: kernel,
    os: 'macos',
    os_version: osVersion
  }
}

export async function runHarborProcess(
  context: HarborExecutionContext,
  harbor: string
): Promise<HarborExecutionOutcome> {
  let stdoutHandle: FileHandle | undefined
  let stderrHandle: FileHandle | undefined

  try {
    stdoutHandle = await open(context.stdoutPath, 'wx', 0o600)
    stderrHandle = await open(context.stderrPath, 'wx', 0o600)

    const stdoutDescriptor = stdoutHandle.fd
    const stderrDescriptor = stderrHandle.fd
    const processControlPath = resolve(dirname(context.stdoutPath), 'process-control.json')

    const processControl = {
      auth_transport: 'inherited-fd-3',
      harbor_telemetry: 'off',
      shell: false
    }

    await writeFile(processControlPath, `${JSON.stringify(processControl, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600
    })

    return await new Promise((resolveOutcome, rejectOutcome) => {
      const child = spawn(harbor, ['run', '--config', context.configPath, '--yes'], {
        cwd: context.runDirectory,
        env: safeEnvironment('/dev/fd/3', context.runDirectory),
        shell: false,
        stdio: ['ignore', stdoutDescriptor, stderrDescriptor, context.authDescriptor]
      })

      let cancelled = false
      let timedOut = false
      let forceTimer: NodeJS.Timeout | undefined

      const beginShutdown = (signal: NodeJS.Signals, timeout: boolean): void => {
        const delivered = child.kill(signal)

        cancelled ||= !timeout && delivered
        timedOut ||= timeout && delivered

        if (delivered) {
          forceTimer ??= setTimeout(() => child.kill('SIGKILL'), SHUTDOWN_GRACE_MS)
        }
      }

      const interrupt = (): void => beginShutdown('SIGINT', false)
      const terminate = (): void => beginShutdown('SIGTERM', false)

      const deadline = setTimeout(
        () => beginShutdown('SIGTERM', true),
        context.wallClockSeconds * 1_000
      )

      process.once('SIGINT', interrupt)
      process.once('SIGTERM', terminate)

      child.once('error', (error) => {
        clearTimeout(deadline)

        if (forceTimer !== undefined) clearTimeout(forceTimer)

        process.off('SIGINT', interrupt)
        process.off('SIGTERM', terminate)

        rejectOutcome(new RunError('EXECUTION_FAILED', 'Harbor could not start', {
          cause: error,
          stage: 'setup'
        }))
      })

      child.once('close', (exitCode, signal) => {
        clearTimeout(deadline)

        if (forceTimer !== undefined) clearTimeout(forceTimer)

        process.off('SIGINT', interrupt)
        process.off('SIGTERM', terminate)

        resolveOutcome({
          cancelled,
          exitCode,
          signal,
          timedOut
        })
      })
    })
  } finally {
    await Promise.all([stdoutHandle?.close(), stderrHandle?.close()])
  }
}

async function runDefaultHarbor(
  context: HarborExecutionContext
): Promise<HarborExecutionOutcome> {
  const repositoryRoot = resolve(import.meta.dirname, '../../..')
  const harbor = resolve(repositoryRoot, '.venv/bin/harbor')

  return runHarborProcess(context, harbor)
}

const defaultRuntime: RunRuntime = {
  inspectHost: inspectDefaultHost,
  now: () => new Date(),
  runHarbor: runDefaultHarbor
}

async function atomicJson(path: string, document: unknown): Promise<string> {
  const contents = Buffer.from(`${JSON.stringify(document, null, 2)}\n`)
  const temporaryPath = `${path}.tmp`
  const handle = await open(temporaryPath, 'wx', 0o600)

  try {
    await handle.writeFile(contents)
    await handle.sync()
  } finally {
    await handle.close()
  }

  await rename(temporaryPath, path)
  await chmod(path, 0o400)

  return sha256(contents)
}

async function readCredential(
  selectedPath: string
): Promise<SelectedCredential> {
  if (!isAbsolute(selectedPath)) {
    throw new RunError('AUTH_REQUIRED', 'CODEX_AUTH_JSON_PATH must be absolute')
  }

  const path = resolve(selectedPath)

  const selectedMetadata = await lstat(path).catch((error: unknown) => {
    throw new RunError('AUTH_REQUIRED', 'Selected Codex credential file is unavailable', {
      cause: error
    })
  })

  if (
    selectedMetadata.isSymbolicLink() ||
    !selectedMetadata.isFile() ||
    (selectedMetadata.mode & 0o777) !== 0o600
  ) {
    throw new RunError(
      'AUTH_REQUIRED',
      'Selected Codex credential must be a regular mode-0600 file'
    )
  }

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: unknown) => {
      throw new RunError('AUTH_REQUIRED', 'Selected Codex credential file is unavailable', {
        cause: error
      })
    }
  )

  try {
    const before = await handle.stat()

    if (!Number.isSafeInteger(before.size) || before.size > MAX_OUTPUT_BYTES) {
      throw new RunError('AUTH_REQUIRED', 'Selected Codex credential file is too large')
    }

    const material = Buffer.alloc(before.size)
    let offset = 0

    while (offset < material.byteLength) {
      const { bytesRead } = await handle.read(
        material,
        offset,
        material.byteLength - offset,
        offset
      )

      if (bytesRead === 0) {
        throw new RunError('AUTH_REQUIRED', 'Selected Codex credential changed while reading')
      }

      offset += bytesRead
    }

    const after = await handle.stat()

    if (
      !before.isFile() ||
      before.dev !== selectedMetadata.dev ||
      before.ino !== selectedMetadata.ino ||
      (before.mode & 0o777) !== 0o600 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new RunError('AUTH_REQUIRED', 'Selected Codex credential changed while reading')
    }

    let candidate: unknown

    try {
      candidate = JSON.parse(material.toString('utf8'))

      if (!isRecord(candidate)) {
        throw new Error('Credential JSON must be an object')
      }
    } catch (error) {
      throw new RunError('AUTH_REQUIRED', 'Selected Codex credential is not valid JSON', {
        cause: error
      })
    }

    const leafValues: Buffer[] = []

    function collectCredentialLeaves(value: unknown, key = ''): void {
      if (typeof value === 'string') {
        if (
          value.length >= 8 &&
          /(?:api[_-]?key|password|secret|token)/i.test(key)
        ) {
          leafValues.push(Buffer.from(value))
        }

        return
      }

      if (Array.isArray(value)) {
        for (const entry of value) {
          collectCredentialLeaves(entry, key)
        }

        return
      }

      if (isRecord(value)) {
        for (const [childKey, child] of Object.entries(value)) {
          collectCredentialLeaves(child, childKey)
        }
      }
    }

    collectCredentialLeaves(candidate)

    return {
      handle,
      leafValues,
      material,
      path
    }
  } catch (error) {
    await handle.close()

    throw error
  }
}

function pathIsInside(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path)

  return pathFromRoot === '' || (
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(pathFromRoot)
  )
}

async function treeContainsInode(
  root: string,
  device: number,
  inode: number
): Promise<boolean> {
  async function visit(path: string): Promise<boolean> {
    const metadata = await lstat(path)

    if (metadata.isSymbolicLink()) {
      return false
    }

    if (metadata.isDirectory()) {
      for (const entry of await readdir(path)) {
        if (await visit(resolve(path, entry))) {
          return true
        }
      }

      return false
    }

    return metadata.isFile() && metadata.dev === device && metadata.ino === inode
  }

  return visit(root)
}

async function assertCredentialExternal(
  plan: ResolvedRunPlan,
  credential: { readonly handle: FileHandle; readonly path: string }
): Promise<void> {
  const repositoryRoot = resolve(import.meta.dirname, '../../..')

  const forbiddenRoots = [
    repositoryRoot,
    plan.runs_directory,
    plan.inputs.harness_bundle.path,
    plan.inputs.task_package.path,
    plan.inputs.task_source.path
  ]

  if (forbiddenRoots.some((root) => pathIsInside(root, credential.path))) {
    throw new RunError(
      'AUTH_REQUIRED',
      'Selected Codex credential must be outside repository and run inputs'
    )
  }

  const metadata = await credential.handle.stat()

  const documentPaths = [
    plan.inputs.experiment.path,
    ...plan.inputs.stacks.map(({ path }) => path),
    ...plan.inputs.harness_documents.map(({ path }) => path),
    plan.inputs.suite.path,
    ...plan.inputs.task_documents.map(({ path }) => path)
  ]

  for (const documentPath of documentPaths) {
    const documentMetadata = await lstat(documentPath)

    if (
      documentMetadata.dev === metadata.dev &&
      documentMetadata.ino === metadata.ino
    ) {
      throw new RunError('AUTH_REQUIRED', 'Selected credential aliases an input document')
    }
  }

  for (const root of forbiddenRoots.slice(2)) {
    if (await treeContainsInode(root, metadata.dev, metadata.ino)) {
      throw new RunError('AUTH_REQUIRED', 'Selected credential aliases a run input')
    }
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

async function copySnapshotEvidence(
  snapshot: Awaited<ReturnType<typeof inspectRunTree>>,
  destination: string,
  label: string
): Promise<void> {
  for (const entry of snapshot.entries) {
    const contents = snapshot.files.get(entry.path)

    if (contents === undefined) {
      throw new RunError('INPUT_CHANGED', `${label} snapshot is incomplete`)
    }

    await writeCopiedFile(resolve(destination, entry.path), contents, entry.executable)
  }

  const copied = await inspectRunTree(destination)

  if (copied.digest !== snapshot.digest) {
    throw new RunError('INPUT_CHANGED', `${label} evidence digest mismatch`)
  }
}

async function copyResolvedInputs(
  plan: ResolvedRunPlan,
  inputsRoot: string
): Promise<{ readonly packagePath: string; readonly sourcePath: string }> {
  const documentRoot = resolve(inputsRoot, 'documents')

  await mkdir(documentRoot, {
    recursive: true,
    mode: 0o700
  })

  const documentInputs = [
    plan.inputs.experiment,
    ...plan.inputs.stacks,
    ...plan.inputs.harness_documents,
    plan.inputs.suite,
    ...plan.inputs.task_documents
  ]

  for (const [index, input] of documentInputs.entries()) {
    const contents = await readStableRunFile(input.path)

    if (sha256(contents) !== input.digest) {
      throw new RunError('INPUT_CHANGED', 'Input document changed after resolution')
    }

    const destination = resolve(documentRoot, `${String(index).padStart(3, '0')}.json`)

    await writeCopiedFile(destination, contents, false)

    if (sha256(await readFile(destination)) !== input.digest) {
      throw new RunError('INPUT_CHANGED', 'Copied input document digest mismatch')
    }
  }

  const currentSource = await inspectTaskSource(plan.inputs.task_source.path)

  if (currentSource.digest !== plan.inputs.task_source.digest) {
    throw new RunError('INPUT_CHANGED', 'Task source changed after resolution')
  }

  const currentPackage = await inspectRunTree(plan.inputs.task_package.path)

  if (currentPackage.digest !== plan.inputs.task_package.digest) {
    throw new RunError('INPUT_CHANGED', 'Task package changed after resolution')
  }

  const sourcePath = resolve(inputsRoot, 'task-source')
  const datasetRoot = resolve(inputsRoot, 'task-dataset')
  const packagePath = resolve(datasetRoot, plan.task.task_id)

  await mkdir(datasetRoot, {
    recursive: true,
    mode: 0o700
  })

  for (const entry of plan.inputs.task_source.entries) {
    const source = resolve(plan.inputs.task_source.path, entry.path)
    const contents = await readStableRunFile(source)

    if (sha256(contents) !== entry.digest || contents.byteLength !== entry.size) {
      throw new RunError('INPUT_CHANGED', 'Task source entry changed after resolution')
    }

    await writeCopiedFile(resolve(sourcePath, entry.path), contents, entry.executable)
  }

  for (const entry of currentPackage.entries) {
    const contents = currentPackage.files.get(entry.path)

    if (contents === undefined) {
      throw new RunError('INPUT_CHANGED', 'Task package snapshot is incomplete')
    }

    await writeCopiedFile(resolve(packagePath, entry.path), contents, entry.executable)
  }

  const [copiedSource, copiedPackage] = await Promise.all([
    inspectTaskSource(sourcePath),
    inspectRunTree(packagePath)
  ])

  if (
    copiedSource.digest !== plan.inputs.task_source.digest ||
    copiedPackage.digest !== plan.inputs.task_package.digest
  ) {
    throw new RunError('INPUT_CHANGED', 'Copied run input digest mismatch')
  }

  return {
    packagePath,
    sourcePath
  }
}

async function materializePinnedTaskPackage(
  plan: ResolvedRunPlan,
  sourcePackage: string,
  destination: string
): Promise<void> {
  const snapshot = await inspectRunTree(sourcePackage)

  for (const entry of snapshot.entries) {
    const contents = snapshot.files.get(entry.path)

    if (contents === undefined) {
      throw new RunError('INPUT_CHANGED', 'Task package snapshot is incomplete')
    }

    await writeCopiedFile(resolve(destination, entry.path), contents, entry.executable)
  }

  const taskTomlPath = resolve(destination, 'task.toml')
  const taskToml = parseToml(await readFile(taskTomlPath, 'utf8'))

  if (!isRecord(taskToml)) {
    throw new RunError('INVALID_TASK_PACKAGE', 'Materialized task.toml is invalid')
  }

  const environment = taskToml.environment
  const verifier = taskToml.verifier

  if (!isRecord(environment) || !isRecord(verifier) || !isRecord(verifier.environment)) {
    throw new RunError('INVALID_TASK_PACKAGE', 'Materialized task image controls are missing')
  }

  environment.docker_image = plan.task.environment.digest
  verifier.environment.docker_image = plan.task.verifier.image_digest

  await writeFile(taskTomlPath, stringifyToml(taskToml), { mode: 0o600 })

  const composePath = resolve(destination, 'environment/docker-compose.yaml')

  const compose = parseYaml(await readFile(composePath, 'utf8'), {
    maxAliasCount: 0,
    uniqueKeys: true
  }) as unknown

  if (!isRecord(compose) || !isRecord(compose.services)) {
    throw new RunError('INVALID_TASK_PACKAGE', 'Materialized agent Compose file is invalid')
  }

  const collector = compose.services.collector

  if (!isRecord(collector)) {
    throw new RunError('INVALID_TASK_PACKAGE', 'Materialized collector service is missing')
  }

  collector.image = plan.task.collector.image_digest

  await writeFile(composePath, stringifyYaml(compose, { lineWidth: 0 }), {
    mode: 0o600
  })
}

async function compileEffectiveConfig(codexHome: string): Promise<void> {
  const configPath = resolve(codexHome, 'config.toml')
  const overridePath = resolve(codexHome, 'AGENTS.override.md')
  const agentsPath = resolve(codexHome, 'AGENTS.md')
  let instructionPath: string | undefined

  try {
    await stat(overridePath)

    instructionPath = overridePath
  } catch {
    try {
      await stat(agentsPath)

      instructionPath = agentsPath
    } catch {
      instructionPath = undefined
    }
  }

  if (instructionPath === undefined) {
    return
  }

  const configSource = await readFile(configPath, 'utf8')
  const instructions = await readFile(instructionPath, 'utf8')
  const config = parseToml(configSource)
  const existing = config.developer_instructions

  if (existing !== undefined && typeof existing !== 'string') {
    throw new RunError(
      'INVALID_HARNESS',
      'config.toml developer_instructions must be a string'
    )
  }

  config.developer_instructions = typeof existing === 'string' && existing !== ''
    ? `${existing}\n\n${instructions}`
    : instructions

  const derived = Buffer.from(stringifyToml(config))

  await writeFile(configPath, derived, { mode: 0o600 })
  await chmod(configPath, 0o600)
  await validateWithPinnedCodex(derived)
}

async function buildJobConfig(
  plan: ResolvedRunPlan,
  runDirectory: string,
  packagePath: string,
  harnessRoot: string,
  rawRoot: string
): Promise<string> {
  const codexHome = resolve(harnessRoot, 'codex-home')
  const skillsRoot = resolve(harnessRoot, 'home/.agents/skills')
  const mcpPath = resolve(harnessRoot, 'mcp-tools.json')
  const mcpDocument = JSON.parse(await readFile(mcpPath, 'utf8')) as unknown

  const mcpServers = isRecord(mcpDocument) && Array.isArray(mcpDocument.mcp_servers)
    ? mcpDocument.mcp_servers
    : undefined

  if (mcpServers === undefined) {
    throw new RunError('INVALID_HARNESS', 'mcp-tools.json must declare mcp_servers')
  }

  const skillPaths: string[] = []

  try {
    for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        skillPaths.push(relative(runDirectory, resolve(skillsRoot, entry.name)))
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  skillPaths.sort(compareText)

  const config = {
    debug: false,
    job_name: 'job',
    jobs_dir: relative(runDirectory, resolve(rawRoot, 'harbor')),
    n_attempts: 1,
    n_concurrent_trials: 1,
    quiet: true,
    retry: { max_retries: 0 },

    environment: {
      type: 'docker',
      delete: true,
      cpu_enforcement_policy: 'limit',
      memory_enforcement_policy: 'limit',
      override_cpus: plan.budget.cpu_count,
      override_memory_mb: plan.budget.memory_megabytes
    },

    verifier: {
      env: { HARBOR_RUN_ID: plan.run_id }
    },

    agents: [{
      name: 'codex',
      model_name: plan.stack.agent.requested_model,
      n_concurrent: 1,
      skills: skillPaths,
      mcp_servers: mcpServers,

      kwargs: {
        config: relative(runDirectory, resolve(codexHome, 'config.toml')),
        reasoning_effort: plan.stack.agent.effort,
        version: plan.stack.agent.cli_version
      }
    }],

    tasks: [{ path: relative(runDirectory, packagePath) }]
  }

  const configPath = resolve(rawRoot, 'runner/job-config.json')

  await mkdir(dirname(configPath), {
    recursive: true,
    mode: 0o700
  })

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600
  })

  return relative(runDirectory, configPath)
}

async function onlyTrial(rawRoot: string): Promise<string> {
  const jobRoot = resolve(rawRoot, 'harbor/job')
  const entries = await readdir(jobRoot, { withFileTypes: true })

  const trialDirectories = entries.filter(
    (entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== '.sources'
  )

  if (trialDirectories.length !== 1) {
    throw new RunError(
      'INVALID_EVIDENCE',
      'Harbor 0.22.0 output must contain exactly one trial',
      { stage: 'finalization' }
    )
  }

  return resolve(jobRoot, trialDirectories[0]!.name)
}

async function parseJsonFile(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new RunError('INVALID_EVIDENCE', `${label} is missing or invalid`, {
      cause: error,
      stage: 'finalization'
    })
  }
}

function assertScoreEvidence(
  score: ScoreDocument,
  verifierResult: Record<string, unknown>
): void {
  const checks = verifierResult.checks
  const scopeViolations = verifierResult.scopeViolations

  if (!isRecord(checks) || !Array.isArray(scopeViolations)) {
    throw new RunError(
      'INVALID_EVIDENCE',
      'Verifier checks or scope violations are missing'
    )
  }

  const facetEntries = Object.entries(score.facets)
  const referencedChecks = new Set<string>()

  for (const [facetName, facet] of facetEntries) {
    for (const evidence of facet.evidence) {
      const check = checks[evidence.check_id]

      if (
        !isRecord(check) ||
        typeof check.passed !== 'boolean' ||
        check.facet !== facetName ||
        referencedChecks.has(evidence.check_id)
      ) {
        throw new RunError(
          'INVALID_EVIDENCE',
          'Score does not bind each verifier check to exactly one matching facet'
        )
      }

      referencedChecks.add(evidence.check_id)

      const expectedOutcome = check.passed ? 'passed' : 'failed'
      const expectedDigest = sha256(JSON.stringify(check))

      if (
        evidence.outcome !== expectedOutcome ||
        evidence.evidence_digest !== expectedDigest
      ) {
        throw new RunError(
          'INVALID_EVIDENCE',
          'Score evidence does not match the verifier check'
        )
      }
    }
  }

  if (
    referencedChecks.size !== Object.keys(checks).length ||
    Object.keys(checks).some((checkId) => !referencedChecks.has(checkId))
  ) {
    throw new RunError(
      'INVALID_EVIDENCE',
      'Score omits one or more verifier checks'
    )
  }

  const directEvidence = score.facets.direct_behavior.evidence
  const regressionEvidence = score.facets.regression.evidence

  const directPassed = directEvidence.length > 0 && directEvidence.every(
    ({ outcome }) => outcome === 'passed'
  )

  const regressionPassed = regressionEvidence.length > 0 && regressionEvidence.every(
    ({ outcome }) => outcome === 'passed'
  )

  if (
    score.gates.direct_behavior_pass !== directPassed ||
    score.gates.regression_pass !== regressionPassed
  ) {
    throw new RunError('INVALID_EVIDENCE', 'Score gates do not match verifier checks')
  }

  const expectedViolations = scopeViolations.map((violation) => {
    if (
      !isRecord(violation) ||
      typeof violation.path !== 'string' ||
      typeof violation.reason !== 'string'
    ) {
      throw new RunError('INVALID_EVIDENCE', 'Verifier scope violation is invalid')
    }

    return {
      path: violation.path,
      reason: violation.reason,
      evidence_digest: sha256(JSON.stringify(violation))
    }
  })

  if (JSON.stringify(score.scope_violations) !== JSON.stringify(expectedViolations)) {
    throw new RunError(
      'INVALID_EVIDENCE',
      'Score scope violations do not match verifier evidence'
    )
  }
}

async function validateEvidence(
  plan: ResolvedRunPlan,
  rawRoot: string,
  trustedSource: string
): Promise<EvidenceOutcome> {
  const trial = await onlyTrial(rawRoot)
  const trialLogPath = resolve(trial, 'trial.log')
  const artifactManifestPath = resolve(trial, 'artifacts/manifest.json')
  const collectorPath = resolve(trial, 'artifacts/trusted-collector')
  const resultPath = resolve(trial, 'result.json')
  const verifierResultPath = resolve(trial, 'verifier/verifier-result.json')
  const scorePath = resolve(trial, 'verifier/score.json')

  const [trialLog, artifactManifest, result, verifierResult, scoreCandidate] = await Promise.all([
    readFile(trialLogPath, 'utf8'),
    parseJsonFile(artifactManifestPath, 'Harbor artifact manifest'),
    parseJsonFile(resultPath, 'Harbor trial result'),
    parseJsonFile(verifierResultPath, 'Verifier result'),
    parseJsonFile(scorePath, 'Score document')
  ])

  const stopIndex = trialLog.indexOf('Main service stopped')
  const collectIndex = trialLog.indexOf('Collect hook in service \'collector\' completed')

  if (
    stopIndex < 0 ||
    collectIndex <= stopIndex ||
    trialLog.includes('Failed to stop main service before sidecar collection') ||
    trialLog.includes('Collect hook in service \'collector\' failed') ||
    trialLog.includes('Collect hook in service \'collector\' exited with code')
  ) {
    throw new RunError('INVALID_EVIDENCE', 'Harbor quiescence or collector evidence is invalid')
  }

  if (
    !Array.isArray(artifactManifest) ||
    artifactManifest.length !== 2 ||
    !isRecord(artifactManifest[0]) ||
    artifactManifest[0].source !== '/logs/artifacts' ||
    artifactManifest[0].destination !== 'artifacts/logs/artifacts' ||
    artifactManifest[0].type !== 'directory' ||
    artifactManifest[0].status !== 'empty' ||
    artifactManifest[0].service !== null ||
    !isRecord(artifactManifest[1]) ||
    artifactManifest[1].source !== '/evidence' ||
    artifactManifest[1].destination !== 'artifacts/trusted-collector' ||
    artifactManifest[1].type !== 'directory' ||
    artifactManifest[1].status !== 'ok' ||
    artifactManifest[1].service !== 'collector'
  ) {
    throw new RunError('INVALID_EVIDENCE', 'Harbor artifact manifest is not exact')
  }

  if (!isRecord(result) || result.verifier_environment_mode !== 'separate') {
    throw new RunError('INVALID_EVIDENCE', 'Harbor did not record a separate verifier environment')
  }

  if (
    !isRecord(verifierResult) ||
    !isRecord(verifierResult.integrity) ||
    verifierResult.integrity.passed !== true ||
    verifierResult.integrity.credentialsAbsent !== true ||
    verifierResult.integrity.networkIsolated !== true
  ) {
    throw new RunError('INVALID_EVIDENCE', 'Verifier integrity evidence is invalid')
  }

  const replayRoot = await mkdtemp('/tmp/harness-bench-replay-')

  try {
    await verifyWorkspaceArtifacts({
      artifacts: collectorPath,
      destination: resolve(replayRoot, 'workspace'),
      expectedBaseCommit: plan.task.base_commit,
      expectedSourceDigest: plan.task.source_digest,
      source: trustedSource
    })
  } finally {
    await rm(replayRoot, {
      force: true,
      recursive: true
    })
  }

  const scoreResult = v.safeParse(ScoreDocumentSchema, scoreCandidate)

  if (!scoreResult.success || !scoreResult.output.valid_grade) {
    throw new RunError('INVALID_EVIDENCE', 'Verifier score document is not a valid grade')
  }

  const score = scoreResult.output
  const verifierResultDigest = sha256(await readFile(verifierResultPath))

  if (
    score.run_id !== plan.run_id ||
    score.verifier_result_digest !== verifierResultDigest ||
    score.scoring_revision !== plan.task.scoring.revision ||
    score.rubric_revision !== plan.task.scoring.rubric_revision
  ) {
    throw new RunError(
      'INVALID_EVIDENCE',
      'Score identity or verifier digest does not match the run'
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

    collection: {
      collector_revision: plan.task.collector.revision,
      collector_image_digest: plan.task.collector.image_digest,
      quiescence: knownEvidence(sha256(await readFile(trialLogPath))),
      collection: knownEvidence(sha256(await readFile(collectorPath + '/workspace-metadata.json'))),
      exact_manifest: knownEvidence(sha256(await readFile(artifactManifestPath))),
      hashes: knownEvidence(sha256(await readFile(collectorPath + '/workspace.patch')))
    },

    score,

    verifier: {
      verifier_revision: plan.task.verifier.revision,
      verifier_image_digest: plan.task.verifier.image_digest,

      network_enforcement_sidecar_digest:
        plan.task.verifier.network_enforcement_sidecar_digest,

      separate_environment: knownEvidence(sha256(await readFile(resultPath))),
      network_disabled: knownEvidence(sha256(await readFile(verifierResultPath))),
      credential_free: knownEvidence(sha256(await readFile(verifierResultPath))),

      result_digest: {
        status: 'known',
        value: verifierResultDigest
      }
    }
  }
}

function classifyException(
  source: string
): Exclude<
  CompletionRunRecord['classification'],
  'task_success' | 'task_failure' | 'cancellation'
> {
  if (
    /Api[A-Za-z]*Error|UnknownApiError|ModelNotFoundError|AuthenticationError|OutputTokenExceededError|ContextWindowExceededError/.test(
      source
    )
  ) {
    return 'provider_failure'
  }

  if (/Verifier|RewardFile|NetworkIsolation/.test(source)) {
    return 'verifier_failure'
  }

  if (/Docker|Container|Spawn|Host/.test(source)) {
    return 'infrastructure_failure'
  }

  if (/Agent|Codex|NonZeroAgentExitCodeError|NetworkConnectionError/.test(source)) {
    return 'agent_failure'
  }

  return 'runner_failure'
}

type TimeoutStage = Extract<
  CompletionRunRecord['termination'],
  { readonly kind: 'timeout' }
>['stage']

function timeoutStageFromDiagnostics(diagnostics: string): TimeoutStage | undefined {
  if (/Environment(?:Build|Start)Timeout|SetupTimeout/.test(diagnostics)) {
    return 'setup'
  }

  if (/AgentTimeout/.test(diagnostics)) {
    return 'agent'
  }

  if (/QuiescenceTimeout/.test(diagnostics)) {
    return 'quiescence'
  }

  if (/CollectionTimeout/.test(diagnostics)) {
    return 'collection'
  }

  if (/VerifierTimeout/.test(diagnostics)) {
    return 'verification'
  }

  if (/FinalizationTimeout/.test(diagnostics)) {
    return 'finalization'
  }
}

function timeoutClassification(
  stage: TimeoutStage,
  diagnostics: string
): Exclude<
  CompletionRunRecord['classification'],
  'task_success' | 'task_failure' | 'cancellation'
> {
  if (stage === 'verification') {
    return 'verifier_failure'
  }

  if (stage === 'agent' || /AgentSetupTimeout/.test(diagnostics)) {
    return 'agent_failure'
  }

  if (stage === 'setup') {
    return 'infrastructure_failure'
  }

  return 'runner_failure'
}

function timeoutLimitSeconds(
  plan: ResolvedRunPlan,
  stage: TimeoutStage
): number {
  if (stage === 'collection') {
    return plan.inputs.task_package.runtime_controls.collector_timeout_seconds
  }

  if (stage === 'verification') {
    return plan.inputs.task_package.runtime_controls.verifier_timeout_seconds
  }

  if (stage === 'agent') {
    return plan.inputs.task_package.runtime_controls.agent_timeout_seconds
  }

  return plan.budget.wall_clock_seconds
}

function timeoutElapsedSeconds(diagnostics: string, fallback: number): number {
  const reported = /timed out after\s+(\d+(?:\.\d+)?)\s+seconds/i.exec(diagnostics)
  const reportedSeconds = Number(reported?.[1])

  return Number.isFinite(reportedSeconds) && reportedSeconds > 0
    ? Math.ceil(reportedSeconds)
    : fallback
}

async function failureFromHarbor(
  outcome: HarborExecutionOutcome,
  rawRoot: string,
  plan: ResolvedRunPlan
): Promise<{
  readonly classification: Exclude<CompletionRunRecord['classification'], 'task_success' | 'task_failure'>;
  readonly reason: string;
  readonly termination: CompletionRunRecord['termination'];
}> {
  if (outcome.cancelled) {
    return {
      classification: 'cancellation',
      reason: 'Run cancelled by user signal',

      termination: {
        kind: 'cancelled',
        reason: 'User requested cancellation'
      }
    }
  }

  let diagnostics = ''

  try {
    const trial = await onlyTrial(rawRoot)
    const result = await parseJsonFile(resolve(trial, 'result.json'), 'Harbor trial result')

    if (isRecord(result) && isRecord(result.exception_info)) {
      diagnostics = JSON.stringify(result.exception_info)
    }
  } catch {
    diagnostics = await readFile(resolve(rawRoot, 'runner/stderr.log'), 'utf8').catch(() => '')
  }

  const timeoutStage = timeoutStageFromDiagnostics(diagnostics)

  if (outcome.timedOut && timeoutStage === undefined) {
    const limitSeconds = plan.budget.wall_clock_seconds

    return {
      classification: 'agent_failure',
      reason: 'Run exceeded its wall-clock deadline during agent execution',

      termination: {
        kind: 'timeout',
        stage: 'agent',
        limit_seconds: limitSeconds,
        elapsed_seconds: limitSeconds,
        observed_cause: 'Outer wall-clock deadline expired without later stage evidence'
      }
    }
  }

  if (timeoutStage !== undefined) {
    const limitSeconds = timeoutLimitSeconds(plan, timeoutStage)
    const elapsedSeconds = timeoutElapsedSeconds(diagnostics, limitSeconds)

    return {
      classification: timeoutClassification(timeoutStage, diagnostics),
      reason: `Harbor timed out during ${timeoutStage}`,

      termination: {
        kind: 'timeout',
        stage: timeoutStage,
        limit_seconds: limitSeconds,
        elapsed_seconds: elapsedSeconds,

        observed_cause: outcome.timedOut
          ? 'Outer wall-clock deadline expired with Harbor stage evidence'
          : 'Harbor recorded a stage timeout'
      }
    }
  }

  return {
    classification: classifyException(diagnostics),
    reason: 'Harbor did not produce a valid grade',

    termination: {
      kind: 'error',
      reason: 'Harbor execution failed'
    }
  }
}

async function harborReportedException(rawRoot: string): Promise<boolean> {
  try {
    const trial = await onlyTrial(rawRoot)
    const result = await parseJsonFile(resolve(trial, 'result.json'), 'Harbor trial result')

    return isRecord(result) && result.exception_info !== null
  } catch {
    return false
  }
}

async function scanRawForCredentials(
  rawRoot: string,
  authPath: string,
  authMaterial: Buffer,
  credentialLeaves: readonly Buffer[]
): ReturnType<typeof scanCredentialTree> {
  return scanCredentialTree({
    exactBytes: [authMaterial, ...credentialLeaves],
    exactTexts: [authPath, authMaterial.toString('utf8')],
    root: rawRoot
  })
}

async function rawManifest(rawRoot: string): Promise<readonly RawManifestEntry[]> {
  const entries: RawManifestEntry[] = []

  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true })

    children.sort((left, right) => compareText(left.name, right.name))

    for (const child of children) {
      const path = resolve(directory, child.name)
      const metadata = await lstat(path)
      const relativePath = relative(rawRoot, path).split('\\').join('/')

      if (metadata.isSymbolicLink()) {
        throw new RunError('INVALID_EVIDENCE', 'Raw evidence contains a symbolic link')
      }

      if (metadata.isDirectory()) {
        await visit(path)

        continue
      }

      if (!metadata.isFile()) {
        throw new RunError('INVALID_EVIDENCE', 'Raw evidence contains a special entry')
      }

      const contents = await readFile(path)

      entries.push({
        digest: sha256(contents),
        executable: (metadata.mode & 0o111) !== 0,
        path: relativePath,
        size: contents.byteLength
      })
    }
  }

  await visit(rawRoot)

  return entries
}

async function makeReadOnly(root: string): Promise<void> {
  async function visit(path: string): Promise<void> {
    const metadata = await lstat(path)

    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new RunError('INVALID_EVIDENCE', 'Cannot seal a symlink or special entry')
    }

    if (metadata.isDirectory()) {
      for (const entry of await readdir(path)) {
        await visit(resolve(path, entry))
      }

      await chmod(path, 0o500)
    } else {
      await chmod(path, (metadata.mode & 0o111) !== 0 ? 0o500 : 0o400)
    }
  }

  await visit(root)
}

function completionBase(
  plan: ResolvedRunPlan,
  initialDigest: string,
  completedAt: string,
  rawPath: string,
  manifestDigest: string,
  elapsedSeconds: number
): Pick<
  CompletionRunRecord,
  | 'completed_at'
  | 'document_type'
  | 'identity'
  | 'initial_manifest_digest'
  | 'raw_artifact_manifest_digest'
  | 'raw_artifact_path'
  | 'record_type'
  | 'retention'
  | 'schema_version'
  | 'timings'
  | 'usage'
> {
  return {
    document_type: 'run',
    schema_version: 1,
    record_type: 'completion',

    identity: {
      run_id: plan.run_id,
      attempt_id: plan.attempt_id,
      attempt: plan.attempt
    },

    completed_at: completedAt,
    initial_manifest_digest: initialDigest,

    timings: {
      total_seconds: elapsedSeconds,

      agent_seconds: {
        status: 'unknown',
        reason: 'Harbor timing is retained in raw evidence'
      },

      verifier_seconds: {
        status: 'unknown',
        reason: 'Harbor timing is retained in raw evidence'
      }
    },

    usage: {
      input_tokens: {
        status: 'unknown',
        reason: 'Subscription usage is not authoritative'
      },

      output_tokens: {
        status: 'unknown',
        reason: 'Subscription usage is not authoritative'
      },

      subscription_money: {
        status: 'not_applicable',
        reason: 'Subscription money is not fabricated'
      },

      upstream_api_price_estimate: {
        status: 'unknown',
        reason: 'No API price estimate exists'
      }
    },

    retention: plan.task.retention,
    raw_artifact_path: rawPath,
    raw_artifact_manifest_digest: manifestDigest
  }
}

type RunFailure = Awaited<ReturnType<typeof failureFromHarbor>>

function invalidCompletion(
  base: ReturnType<typeof completionBase>,
  plan: ResolvedRunPlan,
  failure: RunFailure
): CompletionRunRecord {
  return v.parse(CompletionRunRecordSchema, {
    ...base,
    classification: failure.classification,
    termination: failure.termination,

    collection: {
      collector_revision: plan.task.collector.revision,
      collector_image_digest: plan.task.collector.image_digest,
      quiescence: missingEvidence(),
      collection: missingEvidence(),
      exact_manifest: missingEvidence(),
      hashes: missingEvidence()
    },

    verifier: {
      verifier_revision: plan.task.verifier.revision,
      verifier_image_digest: plan.task.verifier.image_digest,

      network_enforcement_sidecar_digest:
        plan.task.verifier.network_enforcement_sidecar_digest,

      separate_environment: missingEvidence(),
      network_disabled: missingEvidence(),
      credential_free: missingEvidence(),

      result_digest: {
        status: 'unknown',
        reason: 'No valid verifier result exists'
      }
    },

    valid_grade: false,

    score_id: {
      status: 'not_applicable',
      reason: 'Execution did not produce a valid grade'
    }
  })
}

function validCompletion(
  base: ReturnType<typeof completionBase>,
  evidence: EvidenceOutcome,
  termination: Extract<
    CompletionRunRecord['termination'],
    { readonly kind: 'budget_exhausted' | 'success' }
  >
): CompletionRunRecord {
  return v.parse(CompletionRunRecordSchema, {
    ...base,
    classification: evidence.classification,
    termination,
    collection: evidence.collection,
    verifier: evidence.verifier,
    valid_grade: true,

    score_id: {
      status: 'known',
      value: evidence.score.score_id
    }
  })
}

async function writeRestrictedDiagnostic(
  rawRoot: string,
  name: string,
  value: string
): Promise<void> {
  const runnerRoot = resolve(rawRoot, 'runner')

  await mkdir(runnerRoot, {
    recursive: true,
    mode: 0o700
  })

  await writeFile(resolve(runnerRoot, name), value, {
    flag: 'wx',
    mode: 0o600
  })
}

async function restrictQuarantinedTree(root: string): Promise<void> {
  async function visit(path: string): Promise<void> {
    const metadata = await lstat(path)

    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      return
    }

    if (metadata.isDirectory()) {
      for (const entry of await readdir(path)) {
        await visit(resolve(path, entry))
      }

      await chmod(path, 0o500)

      return
    }

    await chmod(path, (metadata.mode & 0o111) !== 0 ? 0o500 : 0o400)
  }

  await visit(root)
}

async function quarantineInvalidRaw(
  runDirectory: string,
  currentRawRoot: string,
  reason: string,
  invalidEntries: readonly string[],
  cause?: unknown
): Promise<{ readonly path: string; readonly root: string }> {
  const quarantineRoot = resolve(runDirectory, 'quarantine')
  const invalidRoot = resolve(quarantineRoot, 'invalid-raw')
  const terminalRoot = resolve(quarantineRoot, 'terminal-raw')

  await mkdir(quarantineRoot, {
    recursive: true,
    mode: 0o700
  })

  await rename(currentRawRoot, invalidRoot)
  await restrictQuarantinedTree(invalidRoot)

  await writeRestrictedDiagnostic(
    terminalRoot,
    'finalization-error.json',
    `${JSON.stringify(
      {
        cause:
          cause instanceof Error
            ? (cause.stack ?? cause.message)
            : cause === undefined
              ? undefined
              : String(cause),

        invalid_entries: invalidEntries,
        reason
      },
      null,
      2
    )}\n`
  )

  return {
    path: 'quarantine/terminal-raw',
    root: terminalRoot
  }
}

function evidenceFailure(error: unknown): RunFailure {
  const verifierFailure = error instanceof RunError && /verifier|score|network/i.test(error.message)

  return {
    classification: verifierFailure ? 'verifier_failure' : 'runner_failure',
    reason: 'Trusted evidence validation failed',

    termination: {
      kind: 'error',
      reason: 'Trusted evidence validation failed'
    }
  }
}

async function executeSealedRunPlan(
  plan: ResolvedRunPlan,
  runtime: RunRuntime,
  credential: SelectedCredential
): Promise<RunExecutionResult> {
  const authPath = credential.path
  const authMaterial = credential.material
  const host = await runtime.inspectHost(plan)
  const startedAt = runtime.now()
  const runDirectory = resolve(plan.runs_directory, plan.run_id)

  await mkdir(plan.runs_directory, {
    recursive: true,
    mode: 0o700
  })

  const runsMetadata = await lstat(plan.runs_directory)

  if (
    runsMetadata.isSymbolicLink() ||
    !runsMetadata.isDirectory() ||
    (runsMetadata.mode & 0o777) !== 0o700
  ) {
    throw new RunError(
      'DESTINATION_EXISTS',
      'runs-dir must be a real mode-0700 directory'
    )
  }

  try {
    await mkdir(runDirectory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RunError('DESTINATION_EXISTS', 'Run directory already exists')
    }

    throw error
  }

  await chmod(runDirectory, 0o700)

  const inputsRoot = resolve(runDirectory, 'inputs')
  const stagingRoot = resolve(runDirectory, 'staging')
  const rawRoot = resolve(runDirectory, 'raw')

  await Promise.all([
    mkdir(inputsRoot, { mode: 0o700 }),
    mkdir(stagingRoot, { mode: 0o700 }),
    mkdir(rawRoot, { mode: 0o700 })
  ])

  const copied = await copyResolvedInputs(plan, inputsRoot)
  const harnessRoot = resolve(stagingRoot, 'harness')
  const taskPackageRoot = resolve(stagingRoot, 'task-package')

  await materializeHarnessBundle({
    bundle: plan.inputs.harness_bundle.path,
    destination: harnessRoot
  })

  await compileEffectiveConfig(resolve(harnessRoot, 'codex-home'))
  await materializePinnedTaskPackage(plan, copied.packagePath, taskPackageRoot)

  const configPath = await buildJobConfig(
    plan,
    runDirectory,
    taskPackageRoot,
    harnessRoot,
    rawRoot
  )

  const effectiveConfig = await readFile(
    resolve(harnessRoot, 'codex-home/config.toml')
  )

  const materializedHarness = await inspectRunTree(harnessRoot)
  const materializedPackage = await inspectRunTree(taskPackageRoot)

  await writeCopiedFile(
    resolve(rawRoot, 'runner/effective-codex-config.toml'),
    effectiveConfig,
    false
  )

  await copySnapshotEvidence(
    materializedHarness,
    resolve(rawRoot, 'runner/materialized-harness'),
    'Materialized harness'
  )

  await copySnapshotEvidence(
    materializedPackage,
    resolve(rawRoot, 'runner/materialized-task-package'),
    'Materialized task package'
  )

  await writeRestrictedDiagnostic(
    rawRoot,
    'materialization.json',
    `${JSON.stringify(
      {
        harness_tree_digest: materializedHarness.digest,
        task_package_tree_digest: materializedPackage.digest
      },
      null,
      2
    )}\n`
  )

  await Promise.all([makeReadOnly(inputsRoot), makeReadOnly(stagingRoot)])

  const initial = buildInitialRunRecord({
    attempt: plan.attempt,
    experiment: plan.experiment,
    runId: plan.run_id,
    stack: plan.stack,
    suite: plan.suite,
    task: plan.task
  }, host, startedAt.toISOString())

  const initialDigest = await atomicJson(resolve(runDirectory, 'initial.json'), initial)
  let harborOutcome: HarborExecutionOutcome
  let spawnFailure = false

  try {
    harborOutcome = await runtime.runHarbor({
      authDescriptor: credential.handle.fd,
      configPath,
      runDirectory,
      stderrPath: resolve(rawRoot, 'runner/stderr.log'),
      stdoutPath: resolve(rawRoot, 'runner/stdout.log'),
      wallClockSeconds: plan.budget.wall_clock_seconds
    })
  } catch (error) {
    spawnFailure = true

    await writeRestrictedDiagnostic(
      rawRoot,
      'spawn-error.txt',
      error instanceof Error ? `${error.stack ?? error.message}\n` : 'Unknown spawn failure\n'
    )

    harborOutcome = {
      cancelled: false,
      exitCode: null,
      signal: null,
      timedOut: false
    }
  }

  let evidence: EvidenceOutcome | undefined
  let failure: RunFailure | undefined

  const cleanHarborExit =
    harborOutcome.exitCode === 0 &&
    !harborOutcome.cancelled &&
    !harborOutcome.timedOut

  const reportedException = await harborReportedException(rawRoot)

  if (spawnFailure) {
    failure = {
      classification: 'infrastructure_failure',
      reason: 'Harbor process could not start',

      termination: {
        kind: 'error',
        reason: 'Harbor process could not start'
      }
    }
  } else if (!cleanHarborExit || reportedException) {
    failure = await failureFromHarbor(harborOutcome, rawRoot, plan)
  }

  let rawPath = 'raw'
  let effectiveRawRoot = rawRoot
  let rawInspection: Awaited<ReturnType<typeof scanRawForCredentials>>

  try {
    rawInspection = await scanRawForCredentials(
      rawRoot,
      authPath,
      authMaterial,
      credential.leafValues
    )
  } catch (error) {
    rawInspection = {
      credentialFound: false,
      findings: [],
      invalidEntries: []
    }

    failure = {
      classification: 'runner_failure',
      reason: 'Raw evidence inspection failed',

      termination: {
        kind: 'error',
        reason: 'Raw evidence inspection failed'
      }
    }

    const quarantined = await quarantineInvalidRaw(
      runDirectory,
      rawRoot,
      'Raw evidence inspection failed',
      [],
      error
    )

    rawPath = quarantined.path
    effectiveRawRoot = quarantined.root
  }

  if (rawPath === 'raw' && rawInspection.invalidEntries.length > 0) {
    const quarantined = await quarantineInvalidRaw(
      runDirectory,
      rawRoot,
      'Raw evidence contains a symlink or special entry',
      rawInspection.invalidEntries
    )

    rawPath = quarantined.path
    effectiveRawRoot = quarantined.root
    failure = {
      classification: 'runner_failure',
      reason: 'Raw evidence was quarantined after invalid entries were detected',

      termination: {
        kind: 'error',
        reason: 'Raw evidence contains a symlink or special entry'
      }
    }
  } else if (rawPath === 'raw' && rawInspection.credentialFound) {
    const quarantineRoot = resolve(runDirectory, 'quarantine')

    await mkdir(quarantineRoot, { mode: 0o700 })

    effectiveRawRoot = resolve(quarantineRoot, 'raw')

    await rename(rawRoot, effectiveRawRoot)

    rawPath = 'quarantine/raw'
    failure = {
      classification: 'runner_failure',
      reason: 'Raw evidence was quarantined after credential detection',

      termination: {
        kind: 'error',
        reason: 'Credential material detected in raw evidence'
      }
    }
  }

  if (rawPath === 'raw') {
    const mayKeepGrade = failure === undefined || (
      failure.termination.kind === 'timeout' &&
      failure.termination.stage === 'agent'
    )

    if (mayKeepGrade) {
      try {
        evidence = await validateEvidence(plan, rawRoot, copied.sourcePath)
      } catch (error) {
        await writeRestrictedDiagnostic(
          rawRoot,
          'evidence-error.txt',
          error instanceof Error ? `${error.stack ?? error.message}\n` : 'Unknown evidence failure\n'
        )

        if (failure === undefined) {
          failure = evidenceFailure(error)
        }
      }
    }
  }

  let finalInspection: Awaited<ReturnType<typeof scanRawForCredentials>>

  try {
    finalInspection = await scanRawForCredentials(
      effectiveRawRoot,
      authPath,
      authMaterial,
      credential.leafValues
    )
  } catch (error) {
    const quarantined = await quarantineInvalidRaw(
      runDirectory,
      effectiveRawRoot,
      'Final raw evidence inspection failed',
      [],
      error
    )

    rawPath = quarantined.path
    effectiveRawRoot = quarantined.root
    evidence = undefined
    failure = {
      classification: 'runner_failure',
      reason: 'Final raw evidence inspection failed',

      termination: {
        kind: 'error',
        reason: 'Final raw evidence inspection failed'
      }
    }

    finalInspection = {
      credentialFound: false,
      findings: [],
      invalidEntries: []
    }
  }

  if (rawPath === 'raw' && finalInspection.credentialFound) {
    const quarantineRoot = resolve(runDirectory, 'quarantine')

    await mkdir(quarantineRoot, { mode: 0o700 })

    effectiveRawRoot = resolve(quarantineRoot, 'raw')

    await rename(rawRoot, effectiveRawRoot)

    rawPath = 'quarantine/raw'
    evidence = undefined
    failure = {
      classification: 'runner_failure',
      reason: 'Raw evidence was quarantined after credential detection',

      termination: {
        kind: 'error',
        reason: 'Credential material detected in raw evidence'
      }
    }
  }

  let manifest: readonly RawManifestEntry[]

  try {
    manifest = await rawManifest(effectiveRawRoot)
  } catch (error) {
    const quarantined = await quarantineInvalidRaw(
      runDirectory,
      effectiveRawRoot,
      'Raw evidence finalization failed',
      finalInspection.invalidEntries,
      error
    )

    rawPath = quarantined.path
    effectiveRawRoot = quarantined.root
    evidence = undefined
    failure = {
      classification: 'runner_failure',
      reason: 'Raw evidence finalization failed',

      termination: {
        kind: 'error',
        reason: 'Raw evidence finalization failed'
      }
    }

    manifest = await rawManifest(effectiveRawRoot)
  }

  const manifestPath = resolve(runDirectory, 'raw-manifest.json')
  const manifestDigest = await atomicJson(manifestPath, manifest)

  await makeReadOnly(effectiveRawRoot)

  const completedAt = runtime.now()

  const base = completionBase(
    plan,
    initialDigest,
    completedAt.toISOString(),
    rawPath,
    manifestDigest,
    toSeconds(completedAt.getTime() - startedAt.getTime())
  )

  let completion: CompletionRunRecord

  if (evidence === undefined) {
    const terminalFailure = failure ?? {
      classification: 'infrastructure_failure' as const,
      reason: 'Run execution failed before Harbor returned an outcome',

      termination: {
        kind: 'error' as const,
        reason: 'Run execution failed before Harbor returned an outcome'
      }
    }

    completion = invalidCompletion(base, plan, terminalFailure)
  } else {
    const budgetExhausted = failure?.termination.kind === 'timeout' &&
      failure.termination.stage === 'agent'

    const qualityTermination = budgetExhausted
      ? {
          kind: 'budget_exhausted' as const,
          reason: 'Agent wall-clock budget exhausted after trustworthy collection'
        }
      : { kind: 'success' as const }

    completion = validCompletion(base, evidence, qualityTermination)
  }

  const completionPath = resolve(runDirectory, 'completion.json')

  await atomicJson(completionPath, completion)

  if (rawPath.startsWith('quarantine/')) {
    await chmod(resolve(runDirectory, 'quarantine'), 0o500)
  }

  await chmod(runDirectory, 0o500)

  if (evidence === undefined) {
    return {
      classification: completion.classification as Exclude<
        CompletionRunRecord['classification'],
        'task_success' | 'task_failure'
      >,

      completion_path: completionPath,
      run_directory: runDirectory,
      valid_grade: false
    }
  }

  return {
    classification: evidence.classification,
    completion_path: completionPath,
    run_directory: runDirectory,
    valid_grade: true
  }
}

export async function executeRunPlanWithRuntime(
  plan: ResolvedRunPlan,
  runtime: RunRuntime
): Promise<RunExecutionResult> {
  assertResolvedRunPlan(plan)

  const authPathValue = process.env.CODEX_AUTH_JSON_PATH

  if (authPathValue === undefined || authPathValue === '') {
    throw new RunError('AUTH_REQUIRED', 'CODEX_AUTH_JSON_PATH is required for execution')
  }

  const credential = await readCredential(authPathValue)

  try {
    await assertCredentialExternal(plan, credential)

    return await executeSealedRunPlan(plan, runtime, credential)
  } finally {
    await credential.handle.close()
  }
}

export async function executeRunPlan(
  plan: ResolvedRunPlan
): Promise<RunExecutionResult> {
  return executeRunPlanWithRuntime(plan, defaultRuntime)
}
