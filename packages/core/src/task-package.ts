import { createHash } from 'node:crypto'
import type { TaskDocument } from '@harness-bench/schemas'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import { RunError } from './run-errors.ts'
import type { RunTreeSnapshot } from './run.ts'

export interface TaskPackageBudget {
  readonly wall_clock_seconds: number;
  readonly cpu_count: number;
  readonly memory_megabytes: number;
}

function sha256(contents: Uint8Array): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export interface PackageImageReferences {
  readonly agent: string;
  readonly collector: string;
  readonly verifier: string;
}

export interface PackageRuntimeControls {
  readonly agent_timeout_seconds: number;
  readonly collector_timeout_seconds: number;
  readonly verifier_timeout_seconds: number;
}

export interface TaskPackageInspection {
  readonly imageReferences: PackageImageReferences;
  readonly runtimeControls: PackageRuntimeControls;
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

export function inspectHarborTaskPackage(
  snapshot: RunTreeSnapshot,
  task: TaskDocument,
  budget?: TaskPackageBudget
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
  const cpu = requiredPositiveInteger(environment, 'cpus')
  const memory = requiredPositiveInteger(environment, 'memory_mb')

  if (requiredPositiveInteger(verifierEnvironment, 'cpus') !== cpu || requiredPositiveInteger(verifierEnvironment, 'memory_mb') !== memory) {
    throw new RunError('INVALID_TASK_PACKAGE', 'Agent and verifier resource controls must match')
  }

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
    (budget !== undefined && agentTimeout !== budget.wall_clock_seconds) ||
    agent.network_mode !== 'public' ||
    (budget !== undefined && environment.cpus !== budget.cpu_count) ||
    (budget !== undefined && environment.memory_mb !== budget.memory_megabytes) ||
    environment.network_mode !== 'public' ||
    verifier.environment_mode !== 'separate' ||
    verifier.network_mode !== 'no-network' ||
    (budget !== undefined && verifierEnvironment.cpus !== budget.cpu_count) ||
    (budget !== undefined && verifierEnvironment.memory_mb !== budget.memory_megabytes) ||
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
