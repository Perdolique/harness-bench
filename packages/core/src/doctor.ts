import { inspect } from 'node:util'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { TaskDocumentSchema, type TaskDocument, type ScoreDocument } from '@harness-bench/schemas'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import * as v from 'valibot'
import { inspectHarnessBundleForRun } from './harness.ts'
import { inspectRunTree, readStableRunFile, type RunTreeSnapshot } from './run.ts'
import { RunError } from './run-errors.ts'
import { inspectTaskSource, materializeTaskWorkspace } from './task.ts'
import { inspectHarborTaskPackage, type TaskPackageInspection } from './task-package.ts'
import { assertNonRootAgentIdentity, validateTaskEvidence } from './run-execution.ts'
import { scanCredentialBytes, scanCredentialTree } from './secret-scan.ts'
import { assertRubricDoctorControls, assertRubricEvidencePaths } from './task-rubric.ts'

import {
  DoctorDefinitionSchema,
  DoctorError,
  type DoctorCheck,
  type DoctorControl,
  type DoctorOptions,
  type DoctorReport,
  type DoctorStage
} from './doctor-contracts.ts'

import {
  copyDoctorSnapshot,
  doctorDigest,
  doctorInventory,
  readDoctorJson,
  sealDoctorTree,
  verifyDoctorInventory,
  writeDoctorJson,
  type DoctorInventoryEntry
} from './doctor-storage.ts'

import {
  DOCTOR_HARBOR,
  doctorAgentProbe,
  doctorForbiddenPaths,
  doctorRuntime,
  inspectDoctorImageLayers,
  readDoctorProbe,
  type DoctorRuntime
} from './doctor-runtime.ts'

interface ControlOutcome {
  readonly artifact_digest: string;
  readonly checks: Readonly<Record<string, boolean>>;
  readonly signature: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new DoctorError('INVALID_EVIDENCE', 'A required evidence object is missing')

  return value
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child)

  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'))
}

function assertDependencyPins(snapshot: RunTreeSnapshot): void {
  const manifestSource = snapshot.files.get('package.json')
  const lockSource = snapshot.files.get('pnpm-lock.yaml')

  if (manifestSource === undefined || lockSource === undefined) {
    throw new DoctorError('DEPENDENCY_PINS', 'Supported tasks require package.json and pnpm-lock.yaml')
  }

  const manifest = requireRecord(JSON.parse(manifestSource.toString('utf8')))

  const lock = requireRecord(parseYaml(lockSource.toString('utf8'), {
    uniqueKeys: true,
    maxAliasCount: 0
  }))

  if (typeof manifest.packageManager !== 'string' || !/^pnpm@\d+\.\d+\.\d+$/.test(manifest.packageManager)) {
    throw new DoctorError('DEPENDENCY_PINS', 'Task package manager must use an exact version')
  }

  const importers = requireRecord(lock.importers)
  const root = requireRecord(importers['.'])

  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const dependencies = manifest[group] === undefined ? {} : requireRecord(manifest[group])
    const locked = root[group] === undefined ? {} : requireRecord(root[group])

    if (Object.keys(dependencies).sort().join('\n') !== Object.keys(locked).sort().join('\n')) {
      throw new DoctorError('DEPENDENCY_PINS', 'Dependency inventory differs from the lockfile')
    }

    for (const [name, version] of Object.entries(dependencies)) {
      const entry = requireRecord(locked[name])

      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) || entry.specifier !== version || typeof entry.version !== 'string' || entry.version.split('(')[0] !== version) {
        throw new DoctorError('DEPENDENCY_PINS', 'Dependencies must be exactly pinned and agree with the lockfile')
      }
    }
  }
}

function semanticScore(score: ScoreDocument): unknown {
  const facets = Object.fromEntries(Object.entries(score.facets).map(([name, facet]) => {
    const value = facet.status === 'value' ? facet.value : null

    return [name, {
      status: facet.status,
      value
    }]
  }))

  const rewards = Object.entries(score.harbor_reward.numeric_values ?? {})

  rewards.sort(([left], [right]) => left.localeCompare(right, 'en'))

  const reward = Object.fromEntries(rewards)

  return {
    valid_grade: score.valid_grade,
    gates: score.gates,
    facets,
    composite: score.composite,
    scope_violations: score.scope_violations,
    reward
  }
}

async function findTrial(rawRoot: string): Promise<string> {
  const root = resolve(rawRoot, 'harbor/job')
  const children = await readdir(root, { withFileTypes: true })
  const trials = children.filter((entry) => entry.isDirectory() && entry.name !== '.sources')

  if (trials.length !== 1) throw new DoctorError('INVALID_EVIDENCE', 'Harbor must produce exactly one trial')

  return resolve(root, trials[0]!.name)
}

async function assertCleanup(runtime: DoctorRuntime, cases: readonly string[], raw: string, home: string): Promise<void> {
  const projects = new Set<string>()

  for (const caseRaw of cases) {
    try {
      const trial = await findTrial(caseRaw)
      const configPath = resolve(trial, 'config.json')
      const candidate = await readDoctorJson(configPath)
      const config = requireRecord(candidate)
      const name = config.trial_name

      // Pinned Harbor generates this name for the run-local single-step "task" package.
      if (typeof name !== 'string' || name !== basename(trial) || !/^task__[A-Za-z0-9]{7}$/.test(name)) {
        throw new DoctorError('CLEANUP_FAILED', 'Harbor cleanup ownership evidence is missing or invalid')
      }

      const project = name.toLowerCase()

      projects.add(`${project}__env`)
      projects.add(`${project}__verifier__trial`)
    } catch (cause) {
      throw new DoctorError('CLEANUP_FAILED', 'Harbor cleanup ownership evidence is missing or invalid', { cause })
    }
  }

  const resources: Record<string, Record<string, readonly string[]>> = {}

  for (const project of projects) {
    const owned: Record<string, readonly string[]> = {}

    for (const kind of ['container', 'volume', 'network']) {
      const args = kind === 'container' ? ['ps', '--all', '--quiet'] : [kind, 'ls', '--quiet']
      const filter = `label=com.docker.compose.project=${project}`

      args.push('--filter', filter)

      const listing = await runtime.command('docker', args, home)

      owned[kind] = listing.split('\n').filter(Boolean)
    }

    resources[project] = owned
  }

  const evidencePath = resolve(raw, 'cleanup.json')

  await writeDoctorJson(evidencePath, resources)

  const remaining = Object.values(resources).some((owned) => Object.values(owned).some((ids) => ids.length > 0))

  if (remaining) throw new DoctorError('CLEANUP_FAILED', 'Harbor left doctor-owned Docker resources')
}

export async function runDoctor(options: DoctorOptions, suppliedRuntime: DoctorRuntime = doctorRuntime): Promise<DoctorReport> {
  const purpose = options.purpose ?? 'quality'
  const output = options.outputDirectory

  if (!isAbsolute(output) || !['quality', 'smoke'].includes(purpose)) {
    throw new DoctorError('USAGE_ERROR', 'Doctor requires an absolute new output directory and smoke or quality purpose')
  }

  const definitionPath = resolve(options.definition)
  const definitionBytes = await readStableRunFile(definitionPath)
  const candidate: unknown = JSON.parse(definitionBytes.toString('utf8'))
  const parsed = v.safeParse(DoctorDefinitionSchema, candidate)

  if (!parsed.success) throw new DoctorError('INVALID_DEFINITION', 'Doctor definition does not satisfy version 1')

  const definition = parsed.output
  const forbidden = doctorForbiddenPaths(definition.forbidden_agent_paths)
  const base = dirname(definitionPath)
  const roots = [definition.task_source, definition.task_package, definition.harness_bundle, ...definition.controls.flatMap((control) => control.solution === undefined ? [] : [control.solution])]
  const physicalOutput = resolve(await realpath(dirname(output)), basename(output))

  for (const path of roots) {
    const inputPath = resolve(base, path)
    const full = await realpath(inputPath).catch(() => inputPath)

    if (isInside(full, physicalOutput) || isInside(physicalOutput, full)) throw new DoctorError('OUTPUT_OVERLAP', 'Doctor output must be separate from every input')
  }

  const parent = await lstat(dirname(output))

  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new DoctorError('OUTPUT_INVALID', 'Doctor output parent must be a real directory')

  await mkdir(output, { mode: 0o700 })

  const raw = resolve(output, 'raw')

  await mkdir(raw, { mode: 0o700 })
  await mkdir(resolve(raw, 'inputs'), { mode: 0o700 })
  await mkdir(resolve(raw, 'diagnostics'), { mode: 0o700 })

  const hostHome = resolve(raw, 'host-home')

  await mkdir(hostHome, { mode: 0o700 })

  const cancellation = new AbortController()
  const cancel = (): void => cancellation.abort()

  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)

  const runtime: DoctorRuntime = {
    ...suppliedRuntime,

    command: async (executable, args, home) => {
      if (cancellation.signal.aborted) throw new DoctorError('CANCELLED', 'Doctor was cancelled during local inspection')

      return suppliedRuntime.command(executable, args, home, cancellation.signal)
    }
  }

  try {
  const started = runtime.now().toISOString()
  const checks: DoctorCheck[] = []
  const digests: Record<string, string> = { definition: doctorDigest(definitionBytes) }
  let interrupted = false
  let task: TaskDocument | undefined
  let source: RunTreeSnapshot | undefined
  let taskPackage: RunTreeSnapshot | undefined
  let packageInspection: TaskPackageInspection | undefined
  const solutions = new Map<string, RunTreeSnapshot>()
  const observations = new Map<string, ControlOutcome>()
  const evidenceSnapshots = new Map<string, readonly DoctorInventoryEntry[]>()
  const launchedCases: string[] = []

  const toolingRoots = {
    core: import.meta.dirname,
    reporting: resolve(import.meta.dirname, '../../reporting/src'),
    cli: resolve(import.meta.dirname, '../../../apps/benchctl/src')
  }

  let stage: DoctorStage = 'input'

  const add = (code: string, status: DoctorCheck['status'], message: string, action: string, evidence: readonly string[] = [], failureCode: string | null = null): void => {
    checks.push({
      code,
      status,
      message,
      action,
      evidence,
      stage,
      failure_code: failureCode
    })
  }

  async function check(code: string, action: string, work: () => Promise<void>): Promise<boolean> {
    try {
      if (cancellation.signal.aborted && stage !== 'finalization') throw new DoctorError('CANCELLED', 'Doctor was cancelled')

      await work()

      if (cancellation.signal.aborted && stage !== 'finalization') throw new DoctorError('CANCELLED', 'Doctor was cancelled')

      add(code, 'passed', 'Check passed.', '', [])

      return true
    } catch (error) {
      const path = `diagnostics/${checks.length}-${code}.txt`

      await writeFile(resolve(raw, path), inspect(error, { depth: 10 }), {
        flag: 'wx',
        mode: 0o600
      })

      const message = error instanceof DoctorError ? error.message : 'Check failed; inspect restricted evidence.'
      const failureCode = error instanceof DoctorError || error instanceof RunError ? error.code : 'CHECK_FAILED'

      add(code, 'failed', message, action, [`raw/${path}`], failureCode)

      if (error instanceof DoctorError && ['HOST_COMMAND_FAILED', 'CANCELLED', 'TIMEOUT', 'EXECUTION_FAILED', 'CLEANUP_FAILED', 'PRISTINE_INTEGRITY', 'ORACLE_INCOMPLETE'].includes(error.code)) interrupted = true

      return false
    }
  }

  await writeFile(resolve(raw, 'inputs/definition.json'), definitionBytes, {
    flag: 'wx',
    mode: 0o600
  })

  await check('TOOLING_IDENTITY', 'Restore stable doctor tooling before calibration.', async () => {
    for (const [name, path] of Object.entries(toolingRoots)) {
      const snapshot = await inspectRunTree(path)

      digests[`tooling:${name}`] = snapshot.digest

      await copyDoctorSnapshot(snapshot, resolve(raw, 'inputs/tooling', name))
    }
  })

  await check('TASK_DOCUMENT', 'Fix the task document against the existing schema v1.', async () => {
    const bytes = await readStableRunFile(resolve(base, definition.task_document))
    const value: unknown = JSON.parse(bytes.toString('utf8'))

    task = v.parse(TaskDocumentSchema, value)
    digests.task_document = doctorDigest(bytes)

    await writeFile(resolve(raw, 'inputs/task.json'), bytes, {
      flag: 'wx',
      mode: 0o600
    })
  })

  await check('HARNESS_INTEGRITY', 'Recapture or select a valid immutable harness bundle.', async () => {
    const bundle = await inspectHarnessBundleForRun(resolve(base, definition.harness_bundle))

    digests.harness = bundle.manifest.digest
  })

  await check('TASK_SOURCE', 'Restore the frozen source and its declared one-commit identity.', async () => {
    if (task === undefined) throw new DoctorError('TASK_REQUIRED', 'A valid task document is required')

    const root = resolve(base, definition.task_source)
    const snapshot = await inspectTaskSource(root)
    const files = new Map<string, Buffer>()

    for (const entry of snapshot.entries) files.set(entry.path, await readStableRunFile(resolve(root, entry.path)))

    source = {
      digest: snapshot.digest,
      entries: snapshot.entries,
      files
    }

    if (snapshot.digest !== task.source_digest) throw new DoctorError('SOURCE_MISMATCH', 'Source differs from TaskDocument')

    assertDependencyPins(source)

    try {
      assertRubricEvidencePaths(task, new Set(source.files.keys()))
    } catch (cause) {
      throw new DoctorError(
        'RUBRIC_EVIDENCE',
        'Rubric evidence is absent from the pristine source',
        { cause }
      )
    }

    const copied = resolve(raw, 'inputs/source')

    await copyDoctorSnapshot(source, copied)

    const temporary = await mkdtemp('/tmp/harness-bench-doctor-base-')

    try {
      const workspace = await materializeTaskWorkspace({
        source: copied,
        destination: resolve(temporary, 'workspace'),
        expectedSourceDigest: task.source_digest
      })

      if (workspace.baseCommit !== task.base_commit) throw new DoctorError('BASE_MISMATCH', 'Base commit differs from TaskDocument')
    } finally {
      await rm(temporary, {
        recursive: true,
        force: true
      })
    }

    digests.task_source = snapshot.digest
  })

  await check('TASK_PACKAGE', 'Prepare the supported Harbor package with exact immutable image references.', async () => {
    if (task === undefined) throw new DoctorError('TASK_REQUIRED', 'A valid task document is required')

    taskPackage = await inspectRunTree(resolve(base, definition.task_package))

    if (taskPackage.entries.some((entry) => entry.path.startsWith('solution/'))) throw new DoctorError('HIDDEN_PACKAGE_MATERIAL', 'Reference solutions must be separate from the base task package')

    packageInspection = inspectHarborTaskPackage(taskPackage, task)

    const expected = [task.environment.digest, task.collector.image_digest, task.verifier.image_digest]
    const actual = [packageInspection.imageReferences.agent, packageInspection.imageReferences.collector, packageInspection.imageReferences.verifier]

    if (actual.some((image, index) => image !== expected[index])) throw new DoctorError('IMAGE_PIN_MISMATCH', 'Task package must use its exact declared local image IDs')

    digests.task_package = taskPackage.digest

    await copyDoctorSnapshot(taskPackage, resolve(raw, 'inputs/package'))
  })

  await check('CONTROL_INPUTS', 'Provide complete deterministic control solutions and expectations.', async () => {
    const reference = definition.controls.find((control) => control.kind === 'reference')!
    const checkIds = Object.keys(reference.expected_checks).sort()

    if (task === undefined) throw new DoctorError('TASK_REQUIRED', 'A valid task document is required')

    try {
      assertRubricDoctorControls(task, definition.controls)
    } catch (cause) {
      throw new DoctorError(
        'CONTROL_EXPECTATIONS',
        'Doctor controls do not satisfy the task rubric contract',
        { cause }
      )
    }

    for (const control of definition.controls) {
      const ids = Object.keys(control.expected_checks).sort()

      if (ids.some((id) => !checkIds.includes(id))) throw new DoctorError('CONTROL_EXPECTATIONS', 'Control references an unknown check')

      if (['pristine', 'alternate'].includes(control.kind) && JSON.stringify(ids) !== JSON.stringify(checkIds)) throw new DoctorError('CONTROL_EXPECTATIONS', 'Positive and pristine controls must declare the complete check inventory')

      if (control.solution !== undefined) {
        const snapshot = await inspectRunTree(resolve(base, control.solution))

        if (!snapshot.files.has('solve.sh')) throw new DoctorError('CONTROL_SOLUTION', 'Oracle solution requires solve.sh')

        solutions.set(control.id, snapshot)

        digests[`solution:${control.id}`] = snapshot.digest

        await copyDoctorSnapshot(snapshot, resolve(raw, 'inputs/solutions', control.id))
      }
    }
  })

  if (task === undefined || task.online_reachability.status === 'unknown') {
    add('ONLINE_REACHABILITY', 'failed', 'The task has no usable recorded reachability assessment.', 'Record the task reachability assessment before calibration.')
  } else if (task.online_reachability.status === 'ineligible') {
    add('ONLINE_REACHABILITY', purpose === 'smoke' ? 'warning' : 'failed', 'Publicly reachable material permits smoke/plumbing use only.', 'Use --purpose smoke; do not make secrecy-dependent quality claims.')
  } else {
    add('ONLINE_REACHABILITY', 'passed', 'The task records eligibility; doctor does not prove global online non-discoverability.', '')
  }

  await check('CREDENTIAL_INPUTS', 'Remove exposed credentials and follow the security procedure.', async () => {
    const scan = await scanCredentialTree({ root: raw })

    if (scan.credentialFound || scan.invalidEntries.length > 0) throw new DoctorError('RESTRICTED_INPUTS', 'Inputs require security review before runtime')
  })

  // Input-derived labels can contain credential patterns even when their digest values are safe.
  // Original identifiers remain in the raw definition; omit them from the safe derived record.
  const digestEntries = Object.entries(digests)

  const safeEntries = digestEntries.filter(([name]) => {
    const bytes = Buffer.from(name)
    const findings = scanCredentialBytes(bytes, { path: '[redacted-path]' })

    return findings.length === 0
  })

  const safeInputDigests = Object.fromEntries(safeEntries)
  const initialInputs = { input_digests: safeInputDigests }

  await writeDoctorJson(resolve(output, 'initial.json'), initialInputs)

  let ready = !checks.some((item) => item.status === 'failed') && task !== undefined && source !== undefined && taskPackage !== undefined && packageInspection !== undefined

  stage = 'setup'

  if (ready) {
    ready = await check('HOST_AND_IMAGES', 'Use the pinned Harbor and supported Docker Desktop host with prepared images.', async () => {
      const os = await runtime.command('uname', ['-s'], hostHome)
      const arch = await runtime.command('uname', ['-m'], hostHome)
      const harbor = await runtime.command(DOCTOR_HARBOR, ['--version'], hostHome)
      const docker = requireRecord(JSON.parse(await runtime.command('docker', ['version', '--format={{json .Server}}'], hostHome)))
      const kernel = await runtime.command('docker', ['info', '--format={{.KernelVersion}}'], hostHome)
      const desktop = await runtime.command('docker', ['desktop', 'version'], hostHome)

      if (os !== 'Darwin' || arch !== 'arm64' || harbor !== '0.22.0' || docker.Os !== 'linux' || docker.Arch !== 'arm64' || !kernel.toLowerCase().includes('linuxkit')) {
        throw new DoctorError('HOST_COMMAND_FAILED', 'Doctor requires the supported macOS Apple Silicon Docker Desktop target and Harbor 0.22.0')
      }

      const images = packageInspection!.imageReferences
      const agentUser = packageInspection!.runtimeControls.agent_user

      const expectedImages = [
        [images.agent, agentUser],
        [images.collector, undefined],
        [images.verifier, undefined]
      ] as const

      let agentImageUser: string | undefined

      for (const [image, expectedUser] of expectedImages) {
        const value = requireRecord(JSON.parse(await runtime.command('docker', ['image', 'inspect', '--format={{json .}}', image], hostHome)))
        const config = requireRecord(value.Config)

        if (expectedUser !== undefined && typeof config.User === 'string') {
          agentImageUser = config.User
        }

        if (
          value.Id !== image ||
          value.Os !== 'linux' ||
          value.Architecture !== 'arm64' ||
          (expectedUser !== undefined && config.User !== expectedUser)
        ) {
          throw new DoctorError('IMAGE_PIN_MISMATCH', 'Local image identity does not match the frozen task')
        }
      }

      const agentUserId = await runtime.command(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--entrypoint',
          'id',
          '--user',
          agentUser,
          images.agent,
          '-u'
        ],
        hostHome
      )

      assertNonRootAgentIdentity(
        agentImageUser,
        agentUser,
        agentUserId
      )

      await writeDoctorJson(resolve(raw, 'host.json'), {
        agent_user_id: agentUserId,
        os,
        arch,
        harbor,
        docker,
        kernel,
        desktop,
        images
      })
    })
  }

  if (ready) ready = await check('AGENT_IMAGE_LAYERS', 'Rebuild the agent image without forbidden material in any layer.', async () => {
    const layers = await inspectDoctorImageLayers(task!.environment.digest, forbidden, runtime, hostHome)

    await writeDoctorJson(resolve(raw, 'agent-image-layers.json'), {
      image: task!.environment.digest,
      layers,
      forbidden_paths: forbidden
    })
  })

  if (ready) {
    const pristine = definition.controls.find((control) => control.kind === 'pristine')!
    const reference = definition.controls.find((control) => control.kind === 'reference')!
    const others = definition.controls.filter((control) => control !== pristine && control !== reference)

    const repeated: DoctorControl = {
      id: 'reference-repeat',
      kind: 'reference',
      solution: reference.solution!,
      expected_checks: reference.expected_checks
    }

    const ordered = [pristine, reference, ...others, repeated]

    for (const control of ordered) {
      if (interrupted) {
        add(`CONTROL_${control.id}`, 'not_run', 'A previous runtime failure stopped calibration.', 'Resolve the runtime failure and run a new doctor check.')

        continue
      }

      const ok = await check(`CONTROL_${control.id}`, 'Inspect this control, its verifier checks and collection evidence.', async () => {
        const caseRoot = resolve(raw, 'cases', control.id)
        const packagePath = resolve(caseRoot, 'task')
        const caseRaw = resolve(caseRoot, 'raw')

        await copyDoctorSnapshot(taskPackage!, packagePath)

        await mkdir(resolve(caseRaw, 'runner'), {
          recursive: true,
          mode: 0o700
        })

        if (control.kind !== 'pristine') {
          const selected = control.id === 'reference-repeat' ? reference.id : control.id
          const solutionPath = resolve(packagePath, 'solution')

          await copyDoctorSnapshot(solutions.get(selected)!, solutionPath)

          const uploaded = await doctorInventory(solutionPath)

          for (const entry of uploaded) {
            await chmod(resolve(solutionPath, entry.path), entry.kind === 'directory' || entry.executable ? 0o755 : 0o644)
          }

          await chmod(solutionPath, 0o755)
        }

        const tomlSource = taskPackage!.files.get('task.toml')!.toString('utf8')
        const config = parseToml(tomlSource)

        if (control.kind === 'pristine') {
          const verifier = requireRecord(config.verifier)
          const existing = verifier.collect as unknown[]

          verifier.collect = [{
            command: doctorAgentProbe(task!.base_commit, forbidden),
            service: 'main',
            user: 'root',
            timeout_sec: 60
          }, ...existing]
        }

        await writeFile(resolve(packagePath, 'task.toml'), stringifyToml(config), { mode: 0o600 })

        const job = {
          job_name: 'job',
          jobs_dir: 'raw/harbor',
          n_attempts: 1,
          n_concurrent_trials: 1,
          quiet: true,
          retry: { max_retries: 0 },

          environment: {
            type: 'docker',
            delete: true,
            cpu_enforcement_policy: 'limit',
            memory_enforcement_policy: 'limit'
          },

          verifier: { env: { HARBOR_RUN_ID: control.id } },

          agents: [{
            name: control.kind === 'pristine' ? 'nop' : 'oracle',
            n_concurrent: 1
          }],

          tasks: [{ path: 'task' }]
        }

        const configPath = resolve(caseRaw, 'runner/job-config.json')

        await writeDoctorJson(configPath, job)

        const budget = packageInspection!.runtimeControls

        stage = 'harbor'

        if (cancellation.signal.aborted) throw new DoctorError('CANCELLED', 'Doctor was cancelled before Harbor execution')

        launchedCases.push(caseRaw)

        const outcome = await runtime.runHarbor({
          configPath,
          runDirectory: caseRoot,
          stdoutPath: resolve(caseRaw, 'runner/stdout.log'),
          stderrPath: resolve(caseRaw, 'runner/stderr.log'),
          signal: cancellation.signal,
          wallClockSeconds: budget.agent_timeout_seconds + budget.verifier_timeout_seconds + budget.collector_timeout_seconds + 300
        })

        await writeDoctorJson(resolve(caseRoot, 'process-outcome.json'), {
          stage: 'harbor',
          wall_clock_limit_seconds: budget.agent_timeout_seconds + budget.verifier_timeout_seconds + budget.collector_timeout_seconds + 300,
          cancelled: outcome.cancelled,
          timed_out: outcome.timedOut,
          exit_code: outcome.exitCode,
          signal: outcome.signal
        })

        if (outcome.cancelled) throw new DoctorError('CANCELLED', 'Doctor was cancelled during Harbor execution')

        if (outcome.timedOut) throw new DoctorError('TIMEOUT', 'Doctor exceeded its bounded Harbor deadline')

        if (outcome.exitCode !== 0) throw new DoctorError('EXECUTION_FAILED', 'Harbor could not complete the control')

        stage = 'collection'

        const rawSnapshot = await doctorInventory(caseRaw)

        evidenceSnapshots.set(caseRaw, rawSnapshot)

        const scan = await scanCredentialTree({ root: caseRaw })

        if (scan.credentialFound || scan.invalidEntries.length > 0) throw new DoctorError('RESTRICTED_EVIDENCE', 'Control evidence requires security review')

        const trial = await findTrial(caseRaw)
        const trialResult = requireRecord(await readDoctorJson(resolve(trial, 'result.json')))

        if (trialResult.exception_info !== null) throw new DoctorError('EXECUTION_FAILED', 'Harbor recorded an execution exception')

        if (control.kind !== 'pristine') {
          const marker = await readFile(resolve(trial, 'agent/oracle.txt'), 'utf8')

          if (marker.trim() !== 'CALIBRATION_ORACLE_OK') throw new DoctorError('ORACLE_INCOMPLETE', 'The deterministic oracle did not complete')
        }

        stage = 'verification'

        const evidence = await validateTaskEvidence({
          task: task!,
          run_id: control.id
        }, caseRaw, resolve(raw, 'inputs/source'))

        const verifier = requireRecord(await readDoctorJson(resolve(trial, 'verifier/verifier-result.json')))
        const verifierChecks = requireRecord(verifier.checks)
        const passed: Record<string, boolean> = {}
        const checkIds = Object.keys(verifierChecks).sort()

        for (const id of checkIds) {
          const entry = requireRecord(verifierChecks[id])

          if (typeof entry.passed !== 'boolean') throw new DoctorError('INVALID_EVIDENCE', 'Verifier check has no boolean outcome')

          passed[id] = entry.passed
        }

        const expectedIds = Object.keys(reference.expected_checks).sort()

        if (JSON.stringify(Object.keys(passed).sort()) !== JSON.stringify(expectedIds)) throw new DoctorError('CHECK_INVENTORY', 'Verifier check inventory is incomplete or unexpected')

        const artifactInventory = await doctorInventory(resolve(trial, 'artifacts/trusted-collector'))

        const semantic = {
          checks: passed,
          score: semanticScore(evidence.score)
        }

        const result = {
          artifact_digest: doctorDigest(JSON.stringify(artifactInventory)),
          checks: passed,
          signature: doctorDigest(JSON.stringify(semantic))
        }

        await verifyDoctorInventory(caseRaw, rawSnapshot)
        observations.set(control.id, result)
        await writeDoctorJson(resolve(caseRoot, 'outcome.json'), result)

        for (const [id, expected] of Object.entries(control.expected_checks)) {
          if (passed[id] !== expected) throw new DoctorError('CONTROL_MISMATCH', 'Verifier did not produce the expected control outcome')
        }

        if (control.kind === 'pristine') {
          const patch = await readFile(resolve(trial, 'artifacts/trusted-collector/workspace.patch'))

          if (patch.length !== 0 || evidence.score.gates.direct_behavior_pass || !evidence.score.gates.regression_pass || !await readDoctorProbe(trial)) {
            throw new DoctorError('PRISTINE_INTEGRITY', 'Pristine behavior, regressions or agent visibility failed')
          }
        } else {
          if (['reference', 'alternate'].includes(control.kind) && evidence.classification !== 'task_success') throw new DoctorError('REFERENCE_FAILED', 'A positive control did not pass')
        }

      })

      // A compromised collection/verifier boundary prevents trusting later runtime checks.
      if (!ok && !observations.has(control.id)) interrupted = true
    }

    if (observations.has(reference.id) && observations.has('reference-repeat')) {
      await check('DETERMINISM', 'Repair nondeterministic artifacts or verifier outcomes.', async () => {
        const first = observations.get(reference.id)!
        const second = observations.get('reference-repeat')!

        if (first.artifact_digest !== second.artifact_digest || first.signature !== second.signature) throw new DoctorError('NONDETERMINISM', 'Repeated reference artifacts or semantic scores differ')
      })
    } else add('DETERMINISM', 'not_run', 'Both trustworthy reference results are required.', 'Resolve the earlier control failure.')

    stage = 'finalization'

    await check('HARBOR_CLEANUP', 'Inspect Harbor diagnostics and remove only confirmed abandoned doctor resources.', async () => assertCleanup(suppliedRuntime, launchedCases, raw, hostHome))
  } else {
    add('RUNTIME_CONTROLS', 'not_run', 'Required input or host checks did not pass.', 'Resolve the failed checks and run doctor again.')
  }

  stage = 'finalization'

  await check('EVIDENCE_STABILITY', 'Discard the grade and investigate changes to retained raw evidence.', async () => {
    for (const [path, snapshot] of evidenceSnapshots) await verifyDoctorInventory(path, snapshot)
  })

  await check('INPUT_STABILITY', 'Restore stable inputs and create a new doctor record.', async () => {
    const bytes = await readStableRunFile(definitionPath)

    if (doctorDigest(bytes) !== digests.definition) throw new DoctorError('INPUT_CHANGED', 'Definition changed during doctor')

    for (const [name, path] of Object.entries(toolingRoots)) {
      if (digests[`tooling:${name}`] === undefined) continue

      const current = await inspectRunTree(path)

      if (current.digest !== digests[`tooling:${name}`]) throw new DoctorError('INPUT_CHANGED', 'Doctor tooling changed during execution')
    }

    if (digests.task_document !== undefined) {
      const current = await readStableRunFile(resolve(base, definition.task_document))

      if (doctorDigest(current) !== digests.task_document) throw new DoctorError('INPUT_CHANGED', 'Task document changed during doctor')
    }

    if (digests.task_source !== undefined) {
      const current = await inspectTaskSource(resolve(base, definition.task_source))

      if (current.digest !== digests.task_source) throw new DoctorError('INPUT_CHANGED', 'Task source changed during doctor')
    }

    if (digests.task_package !== undefined) {
      const current = await inspectRunTree(resolve(base, definition.task_package))

      if (current.digest !== digests.task_package) throw new DoctorError('INPUT_CHANGED', 'Task package changed during doctor')
    }

    if (digests.harness !== undefined) {
      const current = await inspectHarnessBundleForRun(resolve(base, definition.harness_bundle))

      if (current.manifest.digest !== digests.harness) throw new DoctorError('INPUT_CHANGED', 'Harness changed during doctor')
    }

    for (const control of definition.controls) {
      if (control.solution === undefined || digests[`solution:${control.id}`] === undefined) continue

      const current = await inspectRunTree(resolve(base, control.solution))

      if (current.digest !== digests[`solution:${control.id}`]) throw new DoctorError('INPUT_CHANGED', 'Control solution changed during doctor')
    }
  })

  const scan = await scanCredentialTree({ root: raw })
  let unsafeInventory = false

  try { await doctorInventory(raw) } catch { unsafeInventory = true }

  if (scan.credentialFound || scan.invalidEntries.length > 0 || unsafeInventory) {
    await mkdir(resolve(output, 'quarantine'), { mode: 0o700 })
    await rename(raw, resolve(output, 'quarantine/raw'))

    for (let index = 0; index < checks.length; index++) {
      const current = checks[index]!

      checks[index] = {
        ...current,
        evidence: current.evidence.map((path) => path.startsWith('raw/') ? `quarantine/${path}` : path)
      }
    }

    await mkdir(raw, { mode: 0o700 })

    await writeDoctorJson(resolve(raw, 'restriction.json'), {
      publication: 'blocked',
      owner_action: 'required',
      credential_categories: scan.findings.map((finding) => finding.category),
      invalid_entries: scan.invalidEntries.length,
      unsafe_inventory: unsafeInventory
    })

    add('EVIDENCE_RESTRICTED', 'failed', 'Raw evidence is quarantined; retention and publication are blocked.', 'Follow the credential incident procedure before further use.')

    interrupted = true
  }

  const manifest = await doctorInventory(raw)
  const manifestDigest = await writeDoctorJson(resolve(output, 'evidence-manifest.json'), manifest)

  await verifyDoctorInventory(raw, manifest)

  if (cancellation.signal.aborted) {
    add('CANCELLATION', 'failed', 'Doctor was cancelled; this record cannot authorize use.', 'Run a new doctor check when ready.', [], 'CANCELLED')

    interrupted = true
  }

  const failed = checks.some((item) => item.status === 'failed' || item.status === 'not_run')
  const exitCode = interrupted ? 2 : failed ? 1 : 0

  const report: DoctorReport = {
    document_type: 'doctor_report',
    schema_version: 1,
    doctor_revision: 'doctor-v1',
    purpose,
    allowed_use: exitCode === 0 ? purpose : 'none',
    exit_code: exitCode,
    started_at: started,
    completed_at: runtime.now().toISOString(),
    input_digests: safeInputDigests,
    checks,
    evidence_manifest_digest: manifestDigest,
    limitations: ['Harness content integrity is checked; effective Codex configuration is validated by the separate harness workflow.', 'Recorded online eligibility is not proof of global non-discoverability.', 'Runtime evidence applies only to the inspected macOS Apple Silicon / Docker Desktop target.', 'No Codex invocation, provider authentication, auth refresh or provider identity is tested.']
  }

  await writeDoctorJson(resolve(output, 'report.json'), report)

  // Quarantined bytes stay restricted and untouched; only the safe record is sealed.
  await sealDoctorTree(raw)

  for (const name of ['initial.json', 'evidence-manifest.json', 'report.json']) {
    await chmod(resolve(output, name), 0o400)
  }

  await chmod(output, 0o500)

  return report
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
  }
}
