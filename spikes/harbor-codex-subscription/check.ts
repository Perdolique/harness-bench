import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_REVISION, IMAGE_NAMES, REPOSITORY_ROOT, SPIKE_ROOT } from './constants.ts'
import { assertExternalRunRoot, collectHostIdentity } from './host.ts'
import { buildAndLockImages } from './images.ts'
import { makeJobConfig, materializeTask } from './run-inputs.ts'
import { runHarborFakeControl } from './fake-harbor-control.ts'

interface ControlResult {
  readonly name: string;
  readonly passed: boolean;
}

interface VerifierReward {
  readonly integrity: number;
  readonly regressions: number;
  readonly scope: number;
  readonly task_contract: number;
}

interface DoctorReport {
  readonly checks: Readonly<Record<string, { readonly status: string }>>;
}

interface DockerSaveManifestEntry {
  readonly Layers: readonly string[];
}

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit']
  }).trim()
}

function runDocker(args: readonly string[]): string {
  return run('docker', args)
}

async function assertAgentImageLayers(): Promise<ControlResult> {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'harness-bench-agent-layers-')
  )

  const archivePath = join(temporaryRoot, 'agent.tar')
  const extractedPath = join(temporaryRoot, 'image')

  try {
    await mkdir(extractedPath)
    runDocker(['image', 'save', '--output', archivePath, IMAGE_NAMES.agent])
    execFileSync('tar', ['-xf', archivePath, '-C', extractedPath])

    const manifest = JSON.parse(
      await readFile(join(extractedPath, 'manifest.json'), 'utf8')
    ) as DockerSaveManifestEntry[]

    const layers = manifest.flatMap((entry) => entry.Layers)

    if (layers.length === 0) {
      throw new Error('Agent image save contained no layers')
    }

    const forbiddenPaths = [
      'app/.git',
      'known-good.patch',
      'tests/hidden.test.mjs',
      'trusted/base'
    ]

    for (const layer of layers) {
      const contents = execFileSync(
        'tar',
        ['-tf', join(extractedPath, layer)],
        { encoding: 'utf8' }
      )

      if (forbiddenPaths.some((path) => contents.includes(path))) {
        throw new Error(`Agent image layer exposes a forbidden path: ${layer}`)
      }
    }

    return {
      name: 'agent-image-layers',
      passed: true
    }
  } finally {
    await rm(temporaryRoot, {
      force: true,
      recursive: true
    })
  }
}

async function validateCodexConfig(root: string): Promise<ControlResult> {
  const temporaryHome = await mkdtemp(
    join(tmpdir(), 'harness-bench-codex-config-')
  )

  const configPath = join(temporaryHome, 'config.toml')

  try {
    await copyFile(join(SPIKE_ROOT, 'harness', 'config.toml'), configPath)

    const runDoctor = (args: readonly string[]) => {
      const result = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--env',
          'CODEX_HOME=/tmp/codex-home',
          '--volume',
          `${temporaryHome}:/tmp/codex-home`,
          IMAGE_NAMES.agent,
          'codex',
          ...args
        ],
        {
          cwd: REPOSITORY_ROOT,
          encoding: 'utf8'
        }
      )

      if (result.status === null) {
        throw new Error(`codex doctor was interrupted: ${result.signal}`)
      }

      return result
    }

    const parseDoctorReport = (source: string): DoctorReport => {
      try {
        return JSON.parse(source) as DoctorReport
      } catch (error) {
        throw new Error('codex doctor did not emit valid JSON', {
          cause: error
        })
      }
    }

    const doctor = runDoctor(['doctor', '--json'])
    const report = parseDoctorReport(doctor.stdout)

    if (report.checks['config.load']?.status !== 'ok') {
      throw new Error('codex doctor rejected the spike config')
    }

    const strictDoctor = runDoctor(['--strict-config', 'doctor', '--json'])
    const strictReport = parseDoctorReport(strictDoctor.stdout)

    if (strictReport.checks['config.load']?.status !== 'ok') {
      throw new Error('codex --strict-config rejected the spike config')
    }

    await writeFile(
      configPath,
      `unknown_issue_2_field = true\n${await readFile(configPath, 'utf8')}`
    )

    const negative = runDoctor([
      'exec',
      '--strict-config',
      '--skip-git-repo-check',
      '--json',
      'Provider-free config rejection control'
    ])

    const negativeOutput = `${negative.stdout}\n${negative.stderr}`

    if (
      negative.status === 0 ||
      !negativeOutput.includes(
        'unknown configuration field `unknown_issue_2_field`'
      ) ||
      negative.stdout.includes('thread.started')
    ) {
      throw new Error('strict config accepted an unknown field')
    }

    const expectedUnavailable = [
      'auth.credentials',
      'network.provider_reachability',
      'network.websocket_reachability'
    ]

    const failedChecks = Object.entries(strictReport.checks)
      .filter(([, check]) => check.status === 'fail')
      .map(([name]) => name)

    if (failedChecks.some((name) => !expectedUnavailable.includes(name))) {
      throw new Error(
        `Unexpected provider-free doctor failures: ${failedChecks.join(', ')}`
      )
    }

    await writeFile(
      join(root, 'codex-config-control.json'),
      JSON.stringify(
        {
          configLoad: report.checks['config.load']?.status,
          strictConfigLoad: strictReport.checks['config.load']?.status,
          doctorExitCode: doctor.status,
          strictDoctorExitCode: strictDoctor.status,
          failedChecks,
          unknownFieldExitCode: negative.status,

          unknownFieldCommand:
            'codex exec --strict-config --skip-git-repo-check --json (no network or auth)',

          unknownFieldRejected: true,
          providerCalls: 0
        },
        null,
        2
      ),
      {
        flag: 'wx',
        mode: 0o400
      }
    )

    return {
      name: 'codex-config',
      passed: true
    }
  } finally {
    await rm(temporaryHome, {
      force: true,
      recursive: true
    })
  }
}

async function validateHarborInputs(root: string): Promise<ControlResult> {
  const runPath = join(root, 'harbor-inputs')

  await mkdir(runPath)

  const datasetPath = await materializeTask(runPath)
  const taskPath = join(datasetPath, 'normalize-room-label')
  const jobConfigPath = join(runPath, 'job.json')

  await writeFile(
    jobConfigPath,
    `${JSON.stringify(
      makeJobConfig(
        runPath,
        datasetPath,
        '/tmp/issue-2-placeholder-auth.json',
        'provider-free-validation'
      ),
      null,
      2
    )}\n`
  )

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HARBOR_TELEMETRY: 'off'
  }

  delete environment.CODEX_ACCESS_TOKEN
  delete environment.CODEX_AUTH_JSON_PATH
  delete environment.CODEX_FORCE_AUTH_JSON
  delete environment.OPENAI_API_KEY

  const resolvedJob = execFileSync(
    join(REPOSITORY_ROOT, '.venv', 'bin', 'harbor'),
    ['run', '--config', jobConfigPath, '--print-config'],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: environment,
      maxBuffer: 16 * 1024 * 1024
    }
  )

  const job = JSON.parse(resolvedJob) as {
    agents: { model_name: string; n_concurrent: number }[];
    n_attempts?: number;
    n_concurrent_trials: number;
    retry?: { max_retries?: number };
  }

  if (
    job.agents.length !== 1 ||
    job.agents[0]?.model_name !== 'gpt-5.6-luna' ||
    job.agents[0]?.n_concurrent !== 1 ||
    (job.n_attempts !== undefined && job.n_attempts !== 1) ||
    job.n_concurrent_trials !== 1 ||
    (job.retry?.max_retries !== undefined && job.retry.max_retries !== 0)
  ) {
    throw new Error(
      `Harbor resolved an unexpected spike job configuration: ${JSON.stringify({
        agents: job.agents,
        n_attempts: job.n_attempts,
        n_concurrent_trials: job.n_concurrent_trials,
        retry: job.retry
      })}`
    )
  }

  const parseTask = [
    'import sys',
    'from harbor.models.task.task import Task',
    'task = Task(sys.argv[1])',
    'assert task.config.verifier.environment_mode.value == \'separate\'',
    'assert task.config.verifier.environment.network_mode.value == \'no-network\'',
    'assert task.config.environment.network_mode.value == \'public\''
  ].join('\n')

  execFileSync(
    join(REPOSITORY_ROOT, '.venv', 'bin', 'python'),
    ['-c', parseTask, taskPath],
    {
      cwd: REPOSITORY_ROOT,
      env: environment,
      stdio: 'inherit'
    }
  )

  return {
    name: 'harbor-input-contract',
    passed: true
  }
}

async function writeCanaryDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true })

  const markers = [
    'auth-readable',
    'config-base-effort',
    'config-chatgpt-only',
    'config-empty-mcp',
    'config-file-store',
    'config-web-search-off',
    'docker-socket-absent',
    'host-home-absent',
    'sandbox-bypass',
    'skill-loaded'
  ]

  await Promise.all(
    markers.map((marker) => writeFile(join(path, marker), 'ok\n', 'utf8'))
  )
}

async function runVerifierControl(
  root: string,
  expectedTaskContract: number,
  modifyFixture: boolean,
  addOutOfScopeFile = false,
  exposeVerifierNetwork = false
): Promise<ControlResult> {
  const id = randomUUID()
  const volume = `harness-bench-workspace-${id}`
  const container = `harness-bench-main-${id}`
  const collectorContainer = `harness-bench-collector-${id}`
  const evidence = join(root, `evidence-${id}`)
  const verifierLogs = join(root, `verifier-${id}`)
  const canary = join(root, `canary-${id}`)
  const codexHome = join(root, `codex-home-${id}`)
  const codexSecrets = join(root, `codex-secrets-${id}`)

  await Promise.all([
    mkdir(evidence),
    mkdir(verifierLogs),
    mkdir(codexHome),
    mkdir(codexSecrets),
    writeCanaryDirectory(canary)
  ])

  runDocker(['volume', 'create', volume])

  const replacementSource = String.raw`export function normalizeRoomLabel(value) {
  return value.trim().toLowerCase().replace(/\s+/gu, "-");
}
`

  const replacement = [
    'import { readFileSync, writeFileSync } from \'node:fs\';',
    'const path = \'/app/src/normalize-room-label.mjs\';',
    'readFileSync(path, \'utf8\');',
    `writeFileSync(path, ${JSON.stringify(replacementSource)}, 'utf8');`,
    'setInterval(() => {}, 1000);'
  ].join('\n')

  const idle = 'setInterval(() => {}, 1000);'

  const outOfScope = [
    'import { writeFileSync } from \'node:fs\';',
    'writeFileSync(\'/app/out-of-scope.txt\', \'not allowed\\n\', \'utf8\');',
    'setInterval(() => {}, 1000);'
  ].join('\n')

  try {
    runDocker([
      'run',
      '--detach',
      '--name',
      container,
      '--volume',
      `${volume}:/app`,
      IMAGE_NAMES.agent,
      'node',
      '--input-type=module',
      '--eval',
      addOutOfScopeFile ? outOfScope : modifyFixture ? replacement : idle
    ])

    runDocker(['exec', container, 'npm', 'test'])
    runDocker(['stop', '--time', '5', container])

    runDocker([
      'run',
      '--detach',
      '--name',
      collectorContainer,
      '--network',
      'none',
      '--volume',
      `${volume}:/workspace:ro`,
      '--volume',
      `${evidence}:/evidence`,
      '--volume',
      `${canary}:/observed/harness-canary:ro`,
      '--volume',
      `${codexHome}:/observed/codex-home:ro`,
      '--volume',
      `${codexSecrets}:/observed/codex-secrets:ro`,
      IMAGE_NAMES.collector
    ])

    runDocker([
      'exec',
      collectorContainer,
      'node',
      '--experimental-strip-types',
      '/opt/spike/container-collector.ts'
    ])

    const verifierArgs = [
      'run',
      '--rm',
      '--network',
      exposeVerifierNetwork ? 'bridge' : 'none',
      '--volume',
      `${evidence}:/evidence:ro`,
      '--volume',
      `${verifierLogs}:/logs/verifier`,
      IMAGE_NAMES.verifier,
      '/tests/test.sh'
    ]

    const verifier = spawnSync('docker', verifierArgs, { encoding: 'utf8' })

    if (verifier.status !== (exposeVerifierNetwork ? 2 : 0)) {
      throw new Error(
        `Verifier control exited unexpectedly: ${verifier.status}`
      )
    }

    const rewardSource = await readFile(
      join(verifierLogs, 'reward.json'),
      'utf8'
    )

    const reward = JSON.parse(rewardSource) as VerifierReward

    if (
      reward.integrity !== (exposeVerifierNetwork ? 0 : 1) ||
      reward.regressions !== 1 ||
      reward.scope !== (addOutOfScopeFile ? 0 : 1) ||
      reward.task_contract !== expectedTaskContract
    ) {
      throw new Error(`Unexpected verifier reward: ${rewardSource}`)
    }

    return {
      name: exposeVerifierNetwork
        ? 'networked-verifier-rejected'
        : addOutOfScopeFile
          ? 'out-of-scope-verifier'
          : modifyFixture
            ? 'known-good-verifier'
            : 'pristine-base-verifier',

      passed: true
    }
  } finally {
    spawnSync('docker', ['rm', '--force', container], { encoding: 'utf8' })

    spawnSync('docker', ['rm', '--force', collectorContainer], {
      encoding: 'utf8'
    })

    spawnSync('docker', ['volume', 'rm', '--force', volume], {
      encoding: 'utf8'
    })
  }
}

async function main(): Promise<void> {
  const configuredRunRoot = process.env.BENCH_RUN_ROOT

  if (!configuredRunRoot) {
    throw new Error('BENCH_RUN_ROOT is required')
  }

  const reportRoot = assertExternalRunRoot(configuredRunRoot)

  await mkdir(reportRoot, {
    mode: 0o700,
    recursive: true
  })

  await chmod(reportRoot, 0o700)

  const imageLockPath = join(reportRoot, 'image-lock.json')
  const host = collectHostIdentity()
  const images = await buildAndLockImages(imageLockPath)
  const workingRoot = await mkdtemp(join(tmpdir(), 'harness-bench-controls-'))

  try {
    const controls: ControlResult[] = []

    controls.push(await validateCodexConfig(reportRoot))
    controls.push(await validateHarborInputs(workingRoot))
    controls.push(await runHarborFakeControl(reportRoot))
    controls.push(await assertAgentImageLayers())
    controls.push(await runVerifierControl(workingRoot, 0, false))
    controls.push(await runVerifierControl(workingRoot, 1, true))
    controls.push(await runVerifierControl(workingRoot, 0, false, true))
    controls.push(await runVerifierControl(workingRoot, 1, true, false, true))

    runDocker([
      'run',
      '--rm',
      IMAGE_NAMES.agent,
      'sh',
      '-c',
      'test ! -e /tests/hidden.test.mjs && test ! -e /trusted/base && test ! -e /app/.git && test ! -S /var/run/docker.sock'
    ])

    controls.push({
      name: 'hidden-tests-absent',
      passed: true
    })

    const report = {
      controls,
      host,
      images,
      providerCalls: 0,
      protocolRevision: PROTOCOL_REVISION,
      schemaVersion: 'spike-1'
    }

    const reportPath = join(reportRoot, 'provider-free-preflight.json')
    const reportSource = `${JSON.stringify(report, null, 2)}\n`

    try {
      const existing = await readFile(reportPath, 'utf8')

      if (existing !== reportSource) {
        throw new Error(
          'Provider-free preflight record changed after creation'
        )
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code

      if (code !== 'ENOENT') {
        throw error
      }

      await writeFile(reportPath, reportSource, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o400
      })
    }

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    await rm(workingRoot, {
      force: true,
      recursive: true
    })
  }
}

await main()
