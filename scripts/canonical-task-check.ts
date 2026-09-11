import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { buildOrderReceiptTaskDocument } from '../benchmark/tasks/order-receipt/task-document.ts'

import {
  importTaskSource,
  inspectTaskSource,
  materializeTaskImport,
  type TaskImportDefinitionV1,
  type TaskTreeEntry
} from '../packages/core/src/index.ts'

import { makeDoctorHarness } from '../tests/fixtures/doctor.ts'
import type { DoctorControl, DoctorDefinition } from '../packages/core/src/doctor-contracts.ts'
import { doctorDigest, writeDoctorJson } from '../packages/core/src/doctor-storage.ts'
import { ScoreDocumentSchema } from '../packages/schemas/src/index.ts'
import * as v from '../packages/schemas/node_modules/valibot/dist/index.mjs'

const repositoryRoot = resolve(import.meta.dirname, '..')
const taskRoot = resolve(repositoryRoot, 'benchmark/tasks/order-receipt')
const fixtureRoot = resolve(repositoryRoot, 'fixtures/order-receipt')
const coreRoot = resolve(repositoryRoot, 'packages/core/src')
const negativeControlsPath = resolve(taskRoot, 'calibration/negative-controls.json')
const importedSourceMarker = 'imported-source-marker.txt'
const importedSourceMarkerContents = 'IMPORTED_SOURCE_BASE_SENTINEL\n'

const imageTags = {
  agent: 'harness-bench-order-receipt-agent:issue-6',
  collector: 'harness-bench-order-receipt-collector:issue-6',
  verifier: 'harness-bench-order-receipt-verifier:issue-6'
} as const

const harborCodexSystemCommands = ['curl', 'bash', 'node', 'npm', 'rg'] as const

interface TaskPackageOptions {
  readonly baseCommit: string;
  readonly sourceDigest: string;
  readonly temporaryRoot: string;
  readonly images: Record<keyof typeof imageTags, string>;
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
    const sourcePath = resolve(source, entry.path)
    const destinationPath = resolve(destination, entry.path)

    await mkdir(dirname(destinationPath), { recursive: true })

    const contents = await readFile(sourcePath)

    await writeFile(destinationPath, contents, {
      mode: entry.executable ? 0o755 : 0o644
    })
  }
}

async function assertFileAbsent(path: string, message: string): Promise<void> {
  try {
    await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return

    throw error
  }

  throw new Error(message)
}

async function assertImportedSourceMarker(root: string): Promise<void> {
  const contents = await readFile(resolve(root, importedSourceMarker), 'utf8')

  if (contents !== importedSourceMarkerContents) {
    throw new Error('Imported source marker is missing or changed')
  }
}

async function prepareImageContexts(
  temporaryRoot: string,
  source: string,
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
    await copySnapshot(source, resolve(contexts[kind], 'trusted-source'), sourceEntries)
    await mkdir(resolve(contexts[kind], 'core'), { recursive: true })
    await cp(resolve(coreRoot, 'task.ts'), resolve(contexts[kind], 'core/task.ts'))
    await cp(resolve(coreRoot, 'secret-scan.ts'), resolve(contexts[kind], 'core/secret-scan.ts'))

    await cp(
      resolve(coreRoot, 'task-artifacts.ts'),
      resolve(contexts[kind], 'core/task-artifacts.ts')
    )

    await cp(resolve(taskRoot, `images/${kind}.Dockerfile`), resolve(contexts[kind], 'Dockerfile'))
  }

  await assertImportedSourceMarker(resolve(contexts.agent, 'source'))
  await assertImportedSourceMarker(resolve(contexts.collector, 'trusted-source'))
  await assertImportedSourceMarker(resolve(contexts.verifier, 'trusted-source'))

  await cp(resolve(taskRoot, 'collector'), resolve(contexts.collector, 'collector'), {
    recursive: true
  })

  await cp(resolve(taskRoot, 'verifier'), resolve(contexts.verifier, 'verifier'), {
    recursive: true
  })

  return contexts
}

async function prepareImportedSource(temporaryRoot: string) {
  const repository = resolve(temporaryRoot, 'source-repository')
  const fixture = await inspectTaskSource(fixtureRoot)

  await copySnapshot(fixtureRoot, repository, fixture.entries)

  await assertFileAbsent(
    resolve(fixtureRoot, importedSourceMarker),
    'Canonical fixture unexpectedly contains the import-only marker'
  )

  await writeFile(
    resolve(repository, importedSourceMarker),
    importedSourceMarkerContents
  )

  run('git', ['init', '--quiet', '--initial-branch=main'], repository)
  run('git', ['add', '--all'], repository)

  run('git', [
    '-c', 'user.name=Harness Bench',
    '-c', 'user.email=benchmark@example.invalid',
    'commit', '--quiet', '--no-gpg-sign', '-m', 'chore: task base'
  ], repository)

  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8'
  }).trim()

  await writeFile(resolve(repository, 'future-solution.txt'), 'FUTURE_SOLUTION_SENTINEL\n')
  run('git', ['add', '--all'], repository)

  run('git', [
    '-c', 'user.name=Harness Bench',
    '-c', 'user.email=benchmark@example.invalid',
    'commit', '--quiet', '--no-gpg-sign', '-m', 'test: future solution'
  ], repository)

  run('git', ['remote', 'add', 'origin', 'https://example.invalid/private.git'], repository)
  await writeFile(resolve(repository, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 99\n')
  await chmod(resolve(repository, '.git/hooks/pre-commit'), 0o755)

  const alternateObjects = resolve(temporaryRoot, 'unused-alternate-objects')

  await mkdir(alternateObjects)
  await writeFile(resolve(repository, '.git/objects/info/alternates'), `${alternateObjects}\n`)

  const definition: TaskImportDefinitionV1 = {
    document_type: 'task_import_definition',
    schema_version: 1,
    task_id: 'order-receipt',
    task_revision: 'issue-14-import-v1',
    repository_path: repository,
    base_commit: baseCommit,

    provenance: {
      repository_id: 'canonical-order-receipt-fixture',
      merged_pull_request: { status: 'not_applicable' }
    },

    online_reachability: {
      status: 'ineligible',
      reason: 'Synthetic calibration source is smoke-only.'
    },

    retention: { classification: 'public' }
  }

  const definitionPath = resolve(temporaryRoot, 'task-import-definition.json')

  await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`)

  const imported = await importTaskSource({
    definition: definitionPath,
    store: resolve(temporaryRoot, 'task-import-store')
  })

  const source = resolve(imported.importPath, 'source')

  const materialized = await materializeTaskImport({
    destination: resolve(temporaryRoot, 'materialized-workspace'),
    importPath: imported.importPath
  })

  await assertImportedSourceMarker(source)
  await assertImportedSourceMarker(materialized.workspace)

  await assertFileAbsent(
    resolve(source, 'future-solution.txt'),
    'Future solution entered the imported task source'
  )

  return {
    imported,
    materialized,
    source
  }
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

function assertNativeCodexSystemCommands(image: string): void {
  const checks = harborCodexSystemCommands
    .map((command) => `command -v ${command} >/dev/null 2>&1`)
    .join(' && ')

  run('docker', [
    'run',
    '--rm',
    '--network=none',
    '--entrypoint',
    '/bin/bash',
    image,
    '-lc',
    `set -eu; ${checks}`
  ])

  console.log(`Native Codex system commands: ${harborCodexSystemCommands.join(', ')}.`)
}

async function renderTemplate(path: string, replacements: Readonly<Record<string, string>>): Promise<string> {
  let source = await readFile(path, 'utf8')

  for (const [needle, value] of Object.entries(replacements)) {
    source = source.replaceAll(needle, value)
  }

  return source
}

async function prepareTask(
  options: TaskPackageOptions
): Promise<string> {
  const {
    baseCommit,
    sourceDigest,
    temporaryRoot,
    images
  } = options

  const path = resolve(temporaryRoot, 'task')

  await mkdir(resolve(path, 'environment'), { recursive: true })
  await mkdir(resolve(path, 'tests'), { recursive: true })
  await cp(resolve(taskRoot, 'instruction.md'), resolve(path, 'instruction.md'))

  await cp(
    resolve(taskRoot, 'verifier/docker-compose.yaml'),
    resolve(path, 'tests/docker-compose.yaml')
  )

  const taskConfiguration = await renderTemplate(resolve(taskRoot, 'task.toml.template'), {
    __AGENT_IMAGE__: images.agent,
    __TASK_BASE_COMMIT__: baseCommit,
    __TASK_SOURCE_DIGEST__: sourceDigest,
    __VERIFIER_IMAGE__: images.verifier
  })

  await writeFile(resolve(path, 'task.toml'), taskConfiguration)

  const environmentConfiguration = await renderTemplate(
    resolve(taskRoot, 'environment/docker-compose.yaml.template'),
    {
      __COLLECTOR_IMAGE__: images.collector,
      __TASK_BASE_COMMIT__: baseCommit,
      __TASK_SOURCE_DIGEST__: sourceDigest
    }
  )

  await writeFile(
    resolve(path, 'environment/docker-compose.yaml'),
    environmentConfiguration
  )

  return path
}

async function prepareCanonicalSolution(
  temporaryRoot: string,
  name: string,
  solutionName: 'alternate' | 'reference',
  negativeControl?: string
): Promise<string> {
  const path = resolve(temporaryRoot, 'solutions', name)

  await cp(resolve(taskRoot, 'solutions', solutionName), path, { recursive: true })

  if (negativeControl !== undefined) {
    await cp(resolve(taskRoot, 'calibration/mutate.mjs'), resolve(path, 'mutate.mjs'))

    await writeFile(
      resolve(path, 'solve.sh'),
      `#!/bin/sh\nset -eu\n\ncp -R /solution/files/. /app/\nnode /solution/mutate.mjs ${negativeControl}\nprintf 'CALIBRATION_ORACLE_OK\\n'\n`
    )
  }

  await chmod(resolve(path, 'solve.sh'), 0o755)

  return path
}

/** Canonical numeric calibration is stricter than the task-independent doctor check matrix. */
export function assertCanonicalScore(control: string, candidate: unknown) {
  const score = v.parse(ScoreDocumentSchema, candidate)
  const pristine = control === 'pristine'

  const expected = {
    direct_behavior: pristine ? 0 : 1,
    repository_contracts: pristine ? 0 : 1,
    regression: 1,
    scope_integrity: 1
  }

  const reward = score.harbor_reward.numeric_values

  for (const [id, value] of Object.entries(expected)) {
    const facet = score.facets[id as keyof typeof expected]

    if (facet.status !== 'value' || facet.value !== value || reward?.[id] !== value) {
      throw new Error(`${control} did not produce the exact calibrated facets and rewards`)
    }
  }

  const composite = pristine ? 0 : 1

  if (score.run_id !== control || Object.keys(reward ?? {}).length !== 4 || score.composite.status !== 'value' || score.composite.value !== composite) {
    throw new Error(`${control} did not produce the exact calibrated score`)
  }

  return score
}

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp('/tmp/harness-bench-issue-14-')
  const prepared = await prepareImportedSource(temporaryRoot)

  const source = {
    digest: prepared.imported.manifest.source_digest,
    entries: prepared.imported.manifest.inventory
  }

  const negativeControlSource = await readFile(negativeControlsPath, 'utf8')
  const negativeControls = parseNegativeControls(negativeControlSource)
  const materialized = prepared.materialized

  const contexts = await prepareImageContexts(
    temporaryRoot,
    prepared.source,
    source.entries,
    materialized.workspace
  )

  buildImages(contexts, materialized.baseCommit)

  const imageDigests = {
    agent: inspectImage(imageTags.agent),
    collector: inspectImage(imageTags.collector),
    verifier: inspectImage(imageTags.verifier)
  }

  assertNativeCodexSystemCommands(imageDigests.agent)

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

  const common = {
    baseCommit: materialized.baseCommit,
    sourceDigest: source.digest,
    temporaryRoot,
    images: imageDigests
  }

  const taskPackage = await prepareTask(common)
  const reference = await prepareCanonicalSolution(temporaryRoot, 'reference', 'reference')
  const alternate = await prepareCanonicalSolution(temporaryRoot, 'alternate', 'alternate')

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

  const positiveChecks = Object.fromEntries(Object.keys(expectedChecks).map((id) => [id, true]))

  const controls: DoctorControl[] = [
    {
      id: 'pristine',
      kind: 'pristine',
      expected_checks: expectedChecks
    },
    {
      id: 'reference',
      kind: 'reference',
      solution: reference,
      expected_checks: positiveChecks
    },
    {
      id: 'alternate',
      kind: 'alternate',
      solution: alternate,
      expected_checks: positiveChecks
    }
  ]

  for (const [name, expected] of Object.entries(negativeControls)) {
    const solution = await prepareCanonicalSolution(temporaryRoot, name, 'reference', name)

    const kind = name === 'candidate-tests-deleted' ? 'test_deletion'
      : name === 'regression-disabled' ? 'test_disablement'
      : name === 'dependency-churn' ? 'forbidden_edit' : 'negative'

    controls.push({
      id: name,
      kind,
      solution,
      expected_checks: Object.fromEntries(expected.map((id) => [id, false]))
    })
  }

  const harness = await makeDoctorHarness(resolve(temporaryRoot, 'harness'))

  const definition: DoctorDefinition = {
    document_type: 'doctor_definition',
    schema_version: 1,
    revision: 'order-receipt-doctor-v1',
    task_document: resolve(temporaryRoot, 'task-document.json'),
    task_source: prepared.source,
    task_package: taskPackage,
    harness_bundle: harness,
    forbidden_agent_paths: ['/solution', '/tests-hidden', '/opt/verifier', '/trusted'],
    controls
  }

  await assertImportedSourceMarker(definition.task_source)

  const definitionPath = resolve(temporaryRoot, 'doctor-definition.json')

  await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`)
  console.log(`Doctor definition: ${definitionPath}`)
  run(process.execPath, [resolve(repositoryRoot, 'apps/benchctl/src/cli.ts'), 'doctor', definitionPath, '--output-dir', resolve(temporaryRoot, 'doctor'), '--purpose', 'smoke'])

  const calibrated = []

  for (const control of ['pristine', 'reference', 'alternate', 'reference-repeat']) {
    const jobs = resolve(temporaryRoot, 'doctor/raw/cases', control, 'raw/harbor/job')
    const entries = await readdir(jobs, { withFileTypes: true })
    const trials = entries.filter((entry) => entry.isDirectory() && entry.name !== '.sources')

    if (trials.length !== 1) throw new Error(`${control} requires exactly one retained score`)

    const scorePath = resolve(jobs, trials[0]!.name, 'verifier/score.json')
    const scoreBytes = await readFile(scorePath)
    const candidate: unknown = JSON.parse(scoreBytes.toString('utf8'))
    const score = assertCanonicalScore(control, candidate)

    calibrated.push({
      control,
      score_path: scorePath,
      score_digest: doctorDigest(scoreBytes),
      reward: score.harbor_reward.numeric_values,
      composite: score.composite
    })
  }

  await writeDoctorJson(resolve(temporaryRoot, 'canonical-score-checks.json'), calibrated)
  console.log('Canonical numeric calibration: pristine 0/0/1/1, positives 1/1/1/1; composites 0 and 1.')
  console.log(`Doctor evidence: ${resolve(temporaryRoot, 'doctor')}`)
}

if (import.meta.main) await main()
