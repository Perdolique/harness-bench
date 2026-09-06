import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { buildOrderReceiptTaskDocument } from '../benchmark/tasks/order-receipt/task-document.ts'
import { inspectTaskSource, materializeTaskWorkspace, type TaskTreeEntry } from '../packages/core/src/index.ts'
import { ScoreDocumentSchema } from '../packages/schemas/src/index.ts'
import * as v from '../packages/schemas/node_modules/valibot/dist/index.mjs'

const repositoryRoot = resolve(import.meta.dirname, '..')
const taskRoot = resolve(repositoryRoot, 'benchmark/tasks/order-receipt')
const fixtureRoot = resolve(repositoryRoot, 'fixtures/order-receipt')
const coreRoot = resolve(repositoryRoot, 'packages/core/src')
const negativeControlsPath = resolve(taskRoot, 'calibration/negative-controls.json')

const imageTags = {
  agent: 'harness-bench-order-receipt-agent:issue-6',
  collector: 'harness-bench-order-receipt-collector:issue-6',
  verifier: 'harness-bench-order-receipt-verifier:issue-6'
} as const

interface VerifierResult {
  readonly checks: Readonly<Record<string, { readonly passed: boolean }>>;
  readonly integrity: { readonly passed: boolean };
  readonly scopeViolations: readonly unknown[];
}

interface CalibrationOutcome {
  readonly checks: Readonly<Record<string, boolean>>;
  readonly composite: number;
  readonly name: string;
  readonly reward: Readonly<Record<string, number>>;
}

interface CalibrationOptions {
  readonly agent: 'nop' | 'oracle';
  readonly baseCommit: string;
  readonly name: string;
  readonly negativeControl?: string;
  readonly solutionName?: 'alternate' | 'reference';
  readonly sourceDigest: string;
  readonly temporaryRoot: string;
}

function parseNegativeControls(
  source: string
): Readonly<Record<string, readonly string[]>> {
  const candidate: unknown = JSON.parse(source)

  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('Negative-control manifest must be an object')
  }

  for (const [control, checks] of Object.entries(candidate)) {
    if (
      control === '' ||
      !Array.isArray(checks) ||
      checks.length === 0 ||
      checks.some((check) => typeof check !== 'string' || check === '')
    ) {
      throw new Error(`Negative-control manifest has invalid expectations for ${control}`)
    }
  }

  return candidate as Readonly<Record<string, readonly string[]>>
}

function run(command: string, args: readonly string[], cwd = repositoryRoot): void {
  const result = spawnSync(command, args, {
    cwd,

    env: {
      ...process.env,
      HARBOR_TELEMETRY: 'off',
      UV_CACHE_DIR: '/tmp/harness-bench-issue-6-uv-cache'
    },

    stdio: 'inherit'
  })

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`)
  }
}

async function copySnapshot(
  source: string,
  destination: string,
  entries: readonly TaskTreeEntry[]
): Promise<void> {
  await mkdir(destination, { recursive: true })

  for (const entry of entries) {
    const destinationPath = resolve(destination, entry.path)

    await mkdir(dirname(destinationPath), { recursive: true })

    await writeFile(destinationPath, await readFile(resolve(source, entry.path)), {
      mode: entry.executable ? 0o755 : 0o644
    })
  }
}

async function prepareImageContexts(
  temporaryRoot: string,
  sourceEntries: readonly TaskTreeEntry[],
  materializedWorkspace: string
): Promise<Record<keyof typeof imageTags, string>> {
  const contexts = {
    agent: resolve(temporaryRoot, 'images/agent'),
    collector: resolve(temporaryRoot, 'images/collector'),
    verifier: resolve(temporaryRoot, 'images/verifier')
  }

  for (const context of Object.values(contexts)) {
    await mkdir(context, { recursive: true })
  }

  await cp(materializedWorkspace, resolve(contexts.agent, 'source'), {
    recursive: true,
    verbatimSymlinks: true
  })

  await cp(resolve(taskRoot, 'images/agent.Dockerfile'), resolve(contexts.agent, 'Dockerfile'))

  for (const kind of ['collector', 'verifier'] as const) {
    await copySnapshot(fixtureRoot, resolve(contexts[kind], 'trusted-source'), sourceEntries)
    await mkdir(resolve(contexts[kind], 'core'), { recursive: true })
    await cp(resolve(coreRoot, 'task.ts'), resolve(contexts[kind], 'core/task.ts'))

    await cp(
      resolve(coreRoot, 'task-artifacts.ts'),
      resolve(contexts[kind], 'core/task-artifacts.ts')
    )

    await cp(resolve(taskRoot, `images/${kind}.Dockerfile`), resolve(contexts[kind], 'Dockerfile'))
  }

  await cp(resolve(taskRoot, 'collector'), resolve(contexts.collector, 'collector'), {
    recursive: true
  })

  await cp(resolve(taskRoot, 'verifier'), resolve(contexts.verifier, 'verifier'), {
    recursive: true
  })

  return contexts
}

function buildImages(
  contexts: Record<keyof typeof imageTags, string>,
  baseCommit: string
): void {
  run('docker', [
    'build',
    '--platform=linux/arm64',
    '--provenance=false',
    '--build-arg',
    `TASK_BASE_COMMIT=${baseCommit}`,
    '--tag',
    imageTags.agent,
    contexts.agent
  ])

  for (const kind of ['collector', 'verifier'] as const) {
    run('docker', [
      'build',
      '--platform=linux/arm64',
      '--provenance=false',
      '--tag',
      imageTags[kind],
      contexts[kind]
    ])
  }
}

function inspectImage(tag: string): string {
  return execFileSync('docker', ['image', 'inspect', '--format={{.Id}}', tag], {
    encoding: 'utf8'
  }).trim()
}

function verifyAgentImage(baseCommit: string): void {
  run('docker', [
    'run',
    '--rm',
    '--network=none',
    imageTags.agent,
    'sh',
    '-lc',
    [
      `test "$(git rev-parse HEAD)" = "${baseCommit}"`,
      'test "$(git rev-list --count --all)" = "1"',
      'test -z "$(git remote)"',
      'test ! -d .git/hooks || test -z "$(find .git/hooks -type f -print -quit)"',
      'test ! -f .git/objects/info/alternates',
      'test -z "$(git fsck --unreachable --no-reflogs)"',
      'test ! -e /solution',
      'test ! -e /tests-hidden',
      'test ! -e /opt/verifier'
    ].join(' && ')
  ])

  const history = execFileSync('docker', ['history', '--no-trunc', '--format={{.CreatedBy}}', imageTags.agent], {
    encoding: 'utf8'
  })

  if (/solutions|tests-hidden|container-verifier/.test(history)) {
    throw new Error('Agent image history contains verifier or solution material')
  }
}

async function renderTemplate(path: string, replacements: Readonly<Record<string, string>>): Promise<string> {
  let source = await readFile(path, 'utf8')

  for (const [needle, value] of Object.entries(replacements)) {
    source = source.replaceAll(needle, value)
  }

  return source
}

async function prepareTask(
  options: CalibrationOptions
): Promise<{ readonly agent: 'nop' | 'oracle'; readonly path: string }> {
  const {
    agent,
    baseCommit,
    name,
    negativeControl,
    solutionName,
    sourceDigest,
    temporaryRoot
  } = options

  const path = resolve(temporaryRoot, 'tasks', name)

  await mkdir(resolve(path, 'environment'), { recursive: true })
  await mkdir(resolve(path, 'tests'), { recursive: true })
  await cp(resolve(taskRoot, 'instruction.md'), resolve(path, 'instruction.md'))

  await cp(
    resolve(taskRoot, 'verifier/docker-compose.yaml'),
    resolve(path, 'tests/docker-compose.yaml')
  )

  await writeFile(
    resolve(path, 'task.toml'),
    await renderTemplate(resolve(taskRoot, 'task.toml.template'), {
      __AGENT_IMAGE__: imageTags.agent,
      __TASK_BASE_COMMIT__: baseCommit,
      __TASK_SOURCE_DIGEST__: sourceDigest,
      __VERIFIER_IMAGE__: imageTags.verifier
    })
  )

  await writeFile(
    resolve(path, 'environment/docker-compose.yaml'),
    await renderTemplate(resolve(taskRoot, 'environment/docker-compose.yaml.template'), {
      __COLLECTOR_IMAGE__: imageTags.collector,
      __TASK_BASE_COMMIT__: baseCommit,
      __TASK_SOURCE_DIGEST__: sourceDigest
    })
  )

  if (agent === 'oracle') {
    const selectedSolution = solutionName ?? 'reference'

    await cp(resolve(taskRoot, 'solutions', selectedSolution), resolve(path, 'solution'), {
      recursive: true
    })

    if (negativeControl !== undefined) {
      await cp(
        resolve(taskRoot, 'calibration/mutate.mjs'),
        resolve(path, 'solution/mutate.mjs')
      )

      await writeFile(
        resolve(path, 'solution/solve.sh'),
        `#!/bin/sh\nset -eu\n\ncp -R /solution/files/. /app/\nnode /solution/mutate.mjs ${negativeControl}\nprintf 'CALIBRATION_ORACLE_OK\\n'\n`
      )
    }

    await chmod(resolve(path, 'solution/solve.sh'), 0o755)
  }

  return {
    agent,
    path
  }
}

async function findFiles(path: string, filename: string): Promise<string[]> {
  const result: string[] = []

  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = resolve(path, entry.name)

    if (entry.isDirectory()) {
      result.push(...await findFiles(entryPath, filename))
    } else if (entry.name === filename) {
      result.push(entryPath)
    }
  }

  return result
}

async function readOutcome(jobsPath: string, name: string): Promise<CalibrationOutcome> {
  const [scorePaths, resultPaths] = await Promise.all([
    findFiles(jobsPath, 'score.json'),
    findFiles(jobsPath, 'verifier-result.json')
  ])

  if (scorePaths.length !== 1 || resultPaths.length !== 1) {
    throw new Error(
      `${name} produced ${scorePaths.length} scores and ${resultPaths.length} verifier results`
    )
  }

  const score = v.parse(
    ScoreDocumentSchema,
    JSON.parse(await readFile(scorePaths[0]!, 'utf8'))
  )

  const verifierResult = JSON.parse(
    await readFile(resultPaths[0]!, 'utf8')
  ) as VerifierResult

  if (!score.valid_grade || !verifierResult.integrity.passed) {
    throw new Error(`${name} did not produce a valid grade with verifier integrity`)
  }

  if (score.composite.status !== 'value') {
    throw new Error(`${name} did not produce a numeric composite`)
  }

  const reward = score.harbor_reward.numeric_values

  return {
    checks: Object.fromEntries(
      Object.entries(verifierResult.checks).map(([id, check]) => [id, check.passed])
    ),

    composite: score.composite.value,
    name,
    reward
  }
}

async function runCalibration(options: CalibrationOptions): Promise<CalibrationOutcome> {
  const { agent, name, temporaryRoot } = options
  const task = await prepareTask(options)
  const jobsPath = resolve(temporaryRoot, 'jobs', name)

  console.log(`\n=== ${name} (${agent}) ===`)

  run(
    resolve(repositoryRoot, '.venv/bin/harbor'),
    [
      'run',
      '--path',
      task.path,
      '--agent',
      task.agent,
      '--jobs-dir',
      jobsPath,
      '--n-attempts',
      '1',
      '--n-concurrent',
      '1',
      '--n-concurrent-agents',
      '1',
      '--max-retries',
      '0',
      '--yes',
      '--quiet'
    ]
  )

  if (agent === 'oracle') {
    const oracleOutputs = await findFiles(jobsPath, 'oracle.txt')

    if (
      oracleOutputs.length !== 1 ||
      (await readFile(oracleOutputs[0]!, 'utf8')).trim() !== 'CALIBRATION_ORACLE_OK'
    ) {
      throw new Error(`${name} oracle did not complete its deterministic solve script`)
    }
  }

  return readOutcome(jobsPath, name)
}

function assertSolution(outcome: CalibrationOutcome): void {
  if (
    outcome.composite !== 1 ||
    Object.values(outcome.reward).some((value) => value !== 1) ||
    Object.values(outcome.checks).some((passed) => !passed)
  ) {
    throw new Error(`${outcome.name} did not pass every calibrated check`)
  }
}

function assertPristine(outcome: CalibrationOutcome): void {
  const expectedChecks = {
    analytics: false,
    availability: false,
    'candidate-tests': false,
    'direct-behavior': false,
    keyboard: false,
    localization: false,
    regression: true,
    scope: true,
    'selected-context': false
  }

  const expectedReward = {
    direct_behavior: 0,
    repository_contracts: 0,
    regression: 1,
    scope_integrity: 1
  }

  if (
    JSON.stringify(outcome.checks) !== JSON.stringify(expectedChecks) ||
    JSON.stringify(outcome.reward) !== JSON.stringify(expectedReward) ||
    outcome.composite !== 0
  ) {
    throw new Error('Pristine base did not produce the exact calibrated failure matrix')
  }
}

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp('/tmp/harness-bench-issue-6-')
  const source = await inspectTaskSource(fixtureRoot)

  const negativeControls = parseNegativeControls(
    await readFile(negativeControlsPath, 'utf8')
  )

  const materialized = await materializeTaskWorkspace({
    destination: resolve(temporaryRoot, 'materialized-workspace'),
    expectedSourceDigest: source.digest,
    source: fixtureRoot
  })

  const contexts = await prepareImageContexts(
    temporaryRoot,
    source.entries,
    materialized.workspace
  )

  buildImages(contexts, materialized.baseCommit)
  verifyAgentImage(materialized.baseCommit)

  const imageDigests = {
    agent: inspectImage(imageTags.agent),
    collector: inspectImage(imageTags.collector),
    verifier: inspectImage(imageTags.verifier)
  }

  const taskDocument = await buildOrderReceiptTaskDocument({
    baseCommit: materialized.baseCommit,
    collectorImageDigest: imageDigests.collector,
    environmentImageDigest: imageDigests.agent,
    sourceDigest: source.digest,
    verifierImageDigest: imageDigests.verifier
  })

  await writeFile(
    resolve(temporaryRoot, 'task-document.json'),
    `${JSON.stringify(taskDocument, null, 2)}\n`
  )

  const pristine = await runCalibration({
    agent: 'nop',
    baseCommit: materialized.baseCommit,
    name: 'pristine',
    sourceDigest: source.digest,
    temporaryRoot
  })

  assertPristine(pristine)

  const reference = await runCalibration({
    agent: 'oracle',
    baseCommit: materialized.baseCommit,
    name: 'reference',
    solutionName: 'reference',
    sourceDigest: source.digest,
    temporaryRoot
  })

  const alternate = await runCalibration({
    agent: 'oracle',
    baseCommit: materialized.baseCommit,
    name: 'alternate',
    solutionName: 'alternate',
    sourceDigest: source.digest,
    temporaryRoot
  })

  assertSolution(reference)
  assertSolution(alternate)

  const negatives: CalibrationOutcome[] = []

  for (const [control, expectedChecks] of Object.entries(negativeControls)) {
    const outcome = await runCalibration({
      agent: 'oracle',
      baseCommit: materialized.baseCommit,
      name: control,
      negativeControl: control,
      solutionName: 'reference',
      sourceDigest: source.digest,
      temporaryRoot
    })

    for (const expectedCheck of expectedChecks) {
      if (outcome.checks[expectedCheck] !== false) {
        throw new Error(`${control} was not caught by ${expectedCheck}`)
      }
    }

    negatives.push(outcome)
  }

  const repeated = await runCalibration({
    agent: 'oracle',
    baseCommit: materialized.baseCommit,
    name: 'reference-repeat',
    solutionName: 'reference',
    sourceDigest: source.digest,
    temporaryRoot
  })

  if (
    JSON.stringify(reference.checks) !== JSON.stringify(repeated.checks) ||
    JSON.stringify(reference.reward) !== JSON.stringify(repeated.reward) ||
    reference.composite !== repeated.composite
  ) {
    throw new Error('Identical reference artifacts did not reproduce checks and scores')
  }

  const summary = {
    automaticRetries: 0,
    baseCommit: materialized.baseCommit,
    harborTelemetry: 'off',
    imageDigests,
    negativeControls: Object.fromEntries(negatives.map(({ checks, name }) => [name, checks])),
    providerCalls: 0,
    sourceDigest: source.digest,
    taskDocument: resolve(temporaryRoot, 'task-document.json'),

    outcomes: {
      alternate: alternate.reward,
      pristine: pristine.reward,
      reference: reference.reward,
      repeat: repeated.reward
    }
  }

  console.log(`\n${JSON.stringify(summary, null, 2)}`)
}

await main()
