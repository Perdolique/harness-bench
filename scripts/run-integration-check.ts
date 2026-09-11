import { executeExperiment } from '../packages/core/src/experiment-execution.ts'
import { planExperiment } from '../packages/core/src/experiment-plan.ts'
import { readExperimentHistory, saveExperimentPlan } from '../packages/core/src/experiment-storage.ts'
import { readExperimentComparisonSource, readExperimentState } from '../packages/results/src/experiment.ts'
import { readRegradedExperimentComparisonSource } from '../packages/results/src/migration-read.ts'
import { regradeExperiment } from '../packages/results/src/regrade.ts'
import { analyzeExperimentComparison } from '../packages/statistics/src/comparison.ts'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { captureHarnessBundle } from '../packages/core/src/harness.ts'

import {
  assertPinnedTaskImages,
  executeRunPlanWithRuntime,
  runHarborProcess,
  type RunRuntime
} from '../packages/core/src/run-execution.ts'

import { inspectRunTreeInventory, resolveRunPlan } from '../packages/core/src/run.ts'
import { inspectTaskSource, materializeTaskWorkspace } from '../packages/core/src/task.ts'
import { normalizeRun } from '../packages/results/src/normalize.ts'
import type { TaskDocument } from '../packages/schemas/src/index.ts'

const repositoryRoot = resolve(import.meta.dirname, '..')
const fixtureRoot = resolve(repositoryRoot, 'tests/fixtures/run-integration')
const coreRoot = resolve(repositoryRoot, 'packages/core/src')
const harborBinary = resolve(repositoryRoot, '.venv/bin/harbor')

const baseImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:941cc91e5022880ac1d14ae90b476b624deb6399dbbc28d612d5d5bd7928fcbd'

const imageTags = {
  agent: 'harness-bench-run-integration-agent:issue-7',
  collector: 'harness-bench-run-integration-collector:issue-7',
  verifier: 'harness-bench-run-integration-verifier:issue-7',
  verifierV2: 'harness-bench-run-integration-verifier:issue-13'
} as const

function sha256(contents: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

function command(commandName: string, args: readonly string[], cwd = repositoryRoot): string {
  return execFileSync(commandName, [...args], {
    cwd,
    encoding: 'utf8',

    env: {
      ...process.env,
      HARBOR_TELEMETRY: 'off',
      NO_COLOR: '1'
    },

    maxBuffer: 32 * 1024 * 1024
  }).trim()
}

function localImageId(reference: string): string {
  const identity = JSON.parse(
    command('docker', ['image', 'inspect', '--format={{json .}}', reference])
  ) as { Architecture?: unknown; Id?: unknown; Os?: unknown }

  if (
    identity.Os !== 'linux' ||
    identity.Architecture !== 'arm64' ||
    typeof identity.Id !== 'string'
  ) {
    throw new Error(`Integration image is not a pinned linux/arm64 image: ${reference}`)
  }

  return identity.Id
}

function assertNoRunDockerResources(temporaryRoot: string): void {
  const marker = temporaryRoot.slice(temporaryRoot.lastIndexOf('/') + 1)

  const resources = [
    ['container', command('docker', ['ps', '--all', '--quiet'])],
    ['volume', command('docker', ['volume', 'ls', '--quiet'])]
  ] as const

  for (const [kind, output] of resources) {
    for (const id of output.split('\n').filter(Boolean)) {
      const labelsFormat = kind === 'container'
        ? '--format={{json .Config.Labels}}'
        : '--format={{json .Labels}}'

      const labels = command(
        'docker',
        [kind, 'inspect', labelsFormat, id]
      )

      if (labels.includes(marker)) {
        throw new Error(`Harbor left an issue 7 integration ${kind}: ${id}`)
      }
    }
  }
}

async function writeJson(path: string, document: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`)
}

async function startProviderCanary(): Promise<{
  readonly close: () => Promise<void>;
  readonly observedAttempts: () => number;
  readonly url: string;
}> {
  let observedAttempts = 0

  const server = createServer((_request, response) => {
    observedAttempts += 1

    response.writeHead(503, { 'content-type': 'application/json' })
    response.end('{"error":"provider access is forbidden in this integration"}\n')
  })

  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('error', rejectListening)
    server.listen(0, '0.0.0.0', resolveListening)
  })

  const address = server.address() as AddressInfo

  return {
    close: () => new Promise<void>((resolveClosed, rejectClosed) => {
      server.close((error) => {
        if (error === undefined) resolveClosed()
        else rejectClosed(error)
      })
    }),

    observedAttempts: () => observedAttempts,
    url: `http://host.docker.internal:${address.port}`
  }
}

async function prepareImages(
  temporaryRoot: string,
  baseCommit: string,
  workspace: string
): Promise<void> {
  const contexts = {
    agent: resolve(temporaryRoot, 'images/agent'),
    collector: resolve(temporaryRoot, 'images/collector'),
    verifier: resolve(temporaryRoot, 'images/verifier')
  }

  for (const path of Object.values(contexts)) {
    await mkdir(path, { recursive: true })
  }

  await cp(workspace, resolve(contexts.agent, 'source'), { recursive: true })

  await cp(
    resolve(fixtureRoot, 'fake-codex.sh'),
    resolve(contexts.agent, 'fake-codex.sh')
  )

  await cp(resolve(fixtureRoot, 'fake-tee.sh'), resolve(contexts.agent, 'fake-tee.sh'))

  await writeFile(
    resolve(contexts.agent, 'Dockerfile'),
    `FROM ${baseImage}\nARG TASK_BASE_COMMIT\nCOPY source/ /app/\nCOPY fake-codex.sh /usr/local/bin/codex\nCOPY fake-tee.sh /usr/local/bin/tee\nRUN chmod 0555 /usr/local/bin/codex /usr/local/bin/tee && test "$(git -C /app rev-parse HEAD)" = "${baseCommit}" && chown -R pwuser:pwuser /app\nUSER pwuser\nWORKDIR /app\n`
  )

  for (const kind of ['collector', 'verifier'] as const) {
    await cp(resolve(fixtureRoot, 'source'), resolve(contexts[kind], 'trusted-source'), {
      recursive: true
    })

    await mkdir(resolve(contexts[kind], 'core'))
    await cp(resolve(coreRoot, 'task.ts'), resolve(contexts[kind], 'core/task.ts'))

    await cp(
      resolve(coreRoot, 'task-artifacts.ts'),
      resolve(contexts[kind], 'core/task-artifacts.ts')
    )
  }

  await cp(
    resolve(fixtureRoot, 'collector.ts'),
    resolve(contexts.collector, 'collector.ts')
  )

  await writeFile(
    resolve(contexts.collector, 'Dockerfile'),
    `FROM ${baseImage}\nCOPY trusted-source/ /trusted/source/\nCOPY core/ /opt/core/\nCOPY collector.ts /opt/collector/collector.ts\nRUN chmod -R 0555 /opt/core /opt/collector && chmod -R a-w /trusted/source\nCMD ["tail", "-f", "/dev/null"]\n`
  )

  await cp(
    resolve(fixtureRoot, 'verifier/verify.mjs'),
    resolve(contexts.verifier, 'verify.mjs')
  )

  await cp(
    resolve(fixtureRoot, 'verifier/test.sh'),
    resolve(contexts.verifier, 'test.sh')
  )

  await writeFile(
    resolve(contexts.verifier, 'Dockerfile'),
    `FROM ${baseImage}\nCOPY trusted-source/ /trusted/source/\nCOPY core/ /opt/core/\nCOPY verify.mjs /opt/verifier/verify.mjs\nCOPY test.sh /tests/test.sh\nRUN chmod -R 0555 /opt/core /opt/verifier /tests/test.sh && chmod -R a-w /trusted/source\nWORKDIR /trusted/source\n`
  )

  for (const kind of ['agent', 'collector', 'verifier'] as const) {
    command('docker', [
      'build',
      '--platform=linux/arm64',
      '--provenance=false',
      '--build-arg',
      `TASK_BASE_COMMIT=${baseCommit}`,
      '--tag',
      imageTags[kind],
      contexts[kind]
    ])
  }
}

async function prepareRegradeVerifierImage(temporaryRoot: string): Promise<void> {
  const context = resolve(temporaryRoot, 'images/verifier-v2')

  await mkdir(resolve(context, 'core'), { recursive: true })

  await cp(resolve(fixtureRoot, 'source'), resolve(context, 'trusted-source'), {
    recursive: true
  })

  await cp(resolve(coreRoot, 'task.ts'), resolve(context, 'core/task.ts'))

  await cp(
    resolve(coreRoot, 'task-artifacts.ts'),
    resolve(context, 'core/task-artifacts.ts')
  )

  await cp(
    resolve(fixtureRoot, 'verifier/verify-v2.mjs'),
    resolve(context, 'verify.mjs')
  )

  await cp(resolve(fixtureRoot, 'verifier/test.sh'), resolve(context, 'test.sh'))

  await writeFile(
    resolve(context, 'Dockerfile'),
    `FROM ${baseImage}\nCOPY trusted-source/ /trusted/source/\nCOPY core/ /opt/core/\nCOPY verify.mjs /opt/verifier/verify.mjs\nCOPY test.sh /tests/test.sh\nRUN chmod -R 0555 /opt/core /opt/verifier /tests/test.sh && chmod -R a-w /trusted/source\nWORKDIR /trusted/source\n`
  )

  command('docker', [
    'build',
    '--platform=linux/arm64',
    '--provenance=false',
    '--tag',
    imageTags.verifierV2,
    context
  ])
}

interface RegradeIntegrationOptions {
  readonly documentsRoot: string;
  readonly matrix: Awaited<ReturnType<typeof planExperiment>>;
  readonly matrixPath: string;
  readonly task: TaskDocument;
  readonly taskPackage: string;
  readonly temporaryRoot: string;
}

interface RegradeIntegrationConfig {
  readonly source_trial?: {
    readonly action?: unknown;
    readonly trial_id?: unknown;
  };
}

interface RegradeIntegrationLock {
  readonly source_trial?: { readonly task?: { readonly digest?: unknown } };
  readonly task?: { readonly digest?: unknown };
  readonly verifier?: { readonly env?: { readonly HARBOR_RUN_ID?: unknown } };
}

interface RegradeIntegrationResult {
  readonly agent_execution?: unknown;
  readonly agent_setup?: unknown;
  readonly environment_setup?: unknown;
  readonly verifier_environment_mode?: unknown;
}

async function runRegradeIntegration(
  options: RegradeIntegrationOptions
): Promise<void> {
  const originalSource = await readExperimentComparisonSource(options.matrix)
  const originalAnalysis = analyzeExperimentComparison(originalSource)

  const originalComposite = originalAnalysis.pairs[0]?.metrics.find(
    ({ metric }) => metric === 'composite'
  )

  if (
    originalComposite?.leftDistribution.mean !== 1 ||
    originalComposite.rightDistribution.mean !== 1
  ) {
    throw new Error('Original integration scoring did not retain composite 1')
  }

  const sourceSnapshots = new Map<string, string>()

  for (const assignment of options.matrix.assignments) {
    const snapshot = await inspectRunTreeInventory(
      resolve(options.matrix.runs_directory, assignment.run_id)
    )

    sourceSnapshots.set(assignment.run_id, snapshot.digest)
  }

  await prepareRegradeVerifierImage(options.temporaryRoot)

  const targetTask = structuredClone(options.task)

  targetTask.verifier.revision = '2'
  targetTask.verifier.image_digest = localImageId(imageTags.verifierV2)
  targetTask.scoring.revision = '2'
  targetTask.scoring.rubric_revision = '2'

  const targetDocumentPath = resolve(options.documentsRoot, 'task-v2.json')
  const targetPackagePath = resolve(options.temporaryRoot, 'task-success-v2')

  await writeJson(targetDocumentPath, targetTask)
  await cp(options.taskPackage, targetPackagePath, { recursive: true })

  const targetTaskTomlPath = resolve(targetPackagePath, 'task.toml')
  const targetTaskToml = await readFile(targetTaskTomlPath, 'utf8')

  await writeFile(
    targetTaskTomlPath,
    targetTaskToml.replace(imageTags.verifier, imageTags.verifierV2)
  )

  const migrationDefinitionPath = resolve(
    options.temporaryRoot,
    'scoring-migration-v2.json'
  )

  await writeJson(migrationDefinitionPath, {
    document_type: 'scoring_migration_definition',
    schema_version: 1,
    migration_id: 'integration-scoring-v2',
    revision: '2',
    experiment_id: options.matrix.experiment.experiment_id,
    experiment_revision: options.matrix.experiment.revision,
    plan_digest: options.matrix.experiment.plan_digest,

    targets: [{
      task_id: targetTask.task_id,
      document: 'documents/task-v2.json',
      package: 'task-success-v2'
    }]
  })

  const migration = await regradeExperiment(
    options.matrixPath,
    migrationDefinitionPath
  )

  if (
    migration.regradedRuns !== 2 ||
    migration.retainedTechnicalRuns !== 0 ||
    migration.migration.record.regrade_provider_calls !== 0
  ) {
    throw new Error('Scoring migration result counts drifted')
  }

  const resumedMigration = await regradeExperiment(
    options.matrixPath,
    migrationDefinitionPath
  )

  if (resumedMigration.migration.digest !== migration.migration.digest) {
    throw new Error('Scoring migration resume changed the sealed identity')
  }

  const migratedSource = await readRegradedExperimentComparisonSource(
    options.matrix,
    migration.migration.recordPath
  )

  for (const source of migratedSource.records) {
    const regrade = source.regrade

    if (regrade === undefined) {
      throw new Error('Migrated integration source lost its regrade evidence')
    }

    const [config, lock, result] = await Promise.all([
      readFile(
        resolve(regrade.leaf, regrade.record.evidence.config_path),
        'utf8'
      ).then((value) => JSON.parse(value)),

      readFile(
        resolve(regrade.leaf, regrade.record.evidence.lock_path),
        'utf8'
      ).then((value) => JSON.parse(value)),

      readFile(
        resolve(regrade.leaf, regrade.record.evidence.result_path),
        'utf8'
      ).then((value) => JSON.parse(value))
    ]) as [
      RegradeIntegrationConfig,
      RegradeIntegrationLock,
      RegradeIntegrationResult
    ]

    const sourceEvaluator = regrade.record.source.evaluator
    const targetEvaluator = regrade.record.target.evaluator

    if (
      sourceEvaluator.verifier_revision !== '1' ||
      sourceEvaluator.scoring_revision !== '1' ||
      sourceEvaluator.rubric_revision !== '1' ||
      targetEvaluator.verifier_revision !== '2' ||
      targetEvaluator.scoring_revision !== '2' ||
      targetEvaluator.rubric_revision !== '2' ||
      config.source_trial?.action !== 'regrade' ||
      config.source_trial?.trial_id !== regrade.record.source.trial.trial_id ||
      lock.source_trial?.task?.digest !==
        regrade.record.source.trial.task_digest ||
      lock.task?.digest !== regrade.record.target.task_lock_digest ||
      lock.verifier?.env?.HARBOR_RUN_ID !==
        source.record.identities.run.run_id ||
      result.verifier_environment_mode !== 'separate' ||
      result.environment_setup !== null ||
      result.agent_setup !== null ||
      result.agent_execution !== null
    ) {
      throw new Error('Regrade config, lock, or evaluator provenance drifted')
    }
  }

  const migratedAnalysis = analyzeExperimentComparison(migratedSource)

  const migratedComposite = migratedAnalysis.pairs[0]?.metrics.find(
    ({ metric }) => metric === 'composite'
  )

  const migratedDirect = migratedAnalysis.pairs[0]?.metrics.find(
    ({ metric }) => metric === 'direct_behavior'
  )

  if (
    migratedComposite?.leftDistribution.mean !== 0.875 ||
    migratedComposite.rightDistribution.mean !== 0.875 ||
    migratedDirect?.leftDistribution.mean !== 0.5 ||
    migratedDirect.rightDistribution.mean !== 0.5 ||
    migratedAnalysis.migration?.providerCalls !== 0
  ) {
    throw new Error('Migration overlay did not apply scoring v2 exactly')
  }

  for (const assignment of options.matrix.assignments) {
    const after = await inspectRunTreeInventory(
      resolve(options.matrix.runs_directory, assignment.run_id)
    )

    if (after.digest !== sourceSnapshots.get(assignment.run_id)) {
      throw new Error('Verifier-only regrade changed original run bytes')
    }

    const regrades = await readdir(resolve(
      options.matrix.runs_directory,
      '.results',
      assignment.run_id,
      'regrades'
    ))

    if (regrades.filter((name) => /^[a-f0-9]{64}$/.test(name)).length !== 1) {
      throw new Error('Scoring migration resume duplicated regrade evidence')
    }
  }

  console.log(
    `regrade_migration: ${migration.migration.digest}, composite 1 -> 0.875, provider calls 0`
  )
}

async function prepareTaskPackage(
  root: string,
  mode: 'cancel' | 'fail' | 'success',
  baseCommit: string,
  sourceDigest: string,
  providerCanaryUrl: string
): Promise<string> {
  const taskRoot = resolve(root, `task-${mode}`)

  await mkdir(resolve(taskRoot, 'environment'), { recursive: true })
  await mkdir(resolve(taskRoot, 'tests'), { recursive: true })
  await writeFile(resolve(taskRoot, 'instruction.md'), 'Create RESULT.md for the fixture.\n')
  await cp(resolve(fixtureRoot, 'verifier/test.sh'), resolve(taskRoot, 'tests/test.sh'))

  await writeFile(
    resolve(taskRoot, 'tests/docker-compose.yaml'),
    'services:\n  main:\n    network_mode: none\n'
  )

  await writeFile(
    resolve(taskRoot, 'environment/docker-compose.yaml'),
    `services:\n  main:\n    environment:\n      FAKE_CODEX_MODE: ${mode}\n      OPENAI_BASE_URL: ${providerCanaryUrl}\n    volumes:\n      - workspace:/app\n  collector:\n    image: ${imageTags.collector}\n    environment:\n      TASK_BASE_COMMIT: ${baseCommit}\n      TASK_SOURCE_DIGEST: ${sourceDigest}\n    network_mode: none\n    volumes:\n      - workspace:/workspace:ro\nvolumes:\n  workspace:\n`
  )

  await writeFile(
    resolve(taskRoot, 'task.toml'),
    `schema_version = "1.4"\n\n[metadata]\nprovider_calls = 0\nautomatic_retries = 0\nharbor_telemetry = "off"\n\n[agent]\ntimeout_sec = 30\nnetwork_mode = "public"\nuser = "pwuser"\n\n[environment]\ndocker_image = "${imageTags.agent}"\nos = "linux"\ncpus = 2\nmemory_mb = 2048\nnetwork_mode = "public"\nworkdir = "/app"\n\n[verifier]\ntimeout_sec = 60\nenvironment_mode = "separate"\nnetwork_mode = "no-network"\n\n[verifier.env]\nTASK_BASE_COMMIT = "${baseCommit}"\nTASK_SOURCE_DIGEST = "${sourceDigest}"\n\n[[verifier.collect]]\nservice = "collector"\ncommand = "node --experimental-strip-types /opt/collector/collector.ts"\ntimeout_sec = 30\n\n[verifier.environment]\ndocker_image = "${imageTags.verifier}"\nos = "linux"\ncpus = 2\nmemory_mb = 2048\nnetwork_mode = "no-network"\n\n[[artifacts]]\nsource = "/evidence"\ndestination = "trusted-collector"\nservice = "collector"\n`
  )

  return taskRoot
}

async function makeHarness(
  root: string,
  id: string,
  instructions: string,
  fakeCodex: string
): Promise<Awaited<ReturnType<typeof captureHarnessBundle>>> {
  const source = resolve(root, `${id}-source`)

  await mkdir(source)

  await writeFile(
    resolve(source, 'config.toml'),
    'forced_login_method = "chatgpt"\nweb_search = "disabled"\n'
  )

  await writeFile(resolve(source, 'mcp-tools.json'), '{"mcp_servers":[]}\n')
  await writeFile(resolve(source, 'AGENTS.override.md'), instructions)

  process.env.NODE_ENV = 'test'
  process.env.HARNESS_BENCH_TEST_CODEX_BINARY = fakeCodex

  return captureHarnessBundle({
    harnessId: id,
    revision: '1',
    source,
    store: resolve(root, `${id}-store`)
  })
}

function runnerDigest(): string {
  return sha256(JSON.stringify({
    agent: 'codex',
    agent_cli_version: '0.153.2',
    agent_timeout_seconds: 30,
    concurrency: 1,
    cpu_count: 2,
    cpu_enforcement_policy: 'limit',
    environment: 'docker',
    harbor_version: '0.22.0',
    max_retries: 0,
    memory_megabytes: 2048,
    memory_enforcement_policy: 'limit',
    n_attempts: 1,
    network_policy: 'public_unrestricted_agent',
    telemetry: 'off',
    verifier_environment: 'separate',
    verifier_network: 'none'
  }))
}

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp('/tmp/harness-bench-issue-7-integration-')
  const source = resolve(fixtureRoot, 'source')
  const sourceSnapshot = await inspectTaskSource(source)
  const materializedWorkspace = resolve(temporaryRoot, 'materialized-workspace')

  const materialized = await materializeTaskWorkspace({
    destination: materializedWorkspace,
    expectedSourceDigest: sourceSnapshot.digest,
    source
  })

  const fakeCodex = resolve(temporaryRoot, 'fake-codex')

  await cp(resolve(fixtureRoot, 'fake-codex.sh'), fakeCodex)
  await chmod(fakeCodex, 0o700)
  await prepareImages(temporaryRoot, materialized.baseCommit, materializedWorkspace)

  const imageIds = {
    agent: localImageId(imageTags.agent),
    collector: localImageId(imageTags.collector),
    verifier: localImageId(imageTags.verifier)
  }

  const harnessA = await makeHarness(
    temporaryRoot,
    'integration-a',
    'Use the provider-free integration behavior.\n',
    fakeCodex
  )

  const harnessB = await makeHarness(
    temporaryRoot,
    'integration-b',
    'Use the provider-free control behavior.\n',
    fakeCodex
  )

  const mcpDigest = harnessA.manifest.entries.find(
    ({ path }) => path === 'mcp-tools.json'
  )!.digest

  const budget = {
    wall_clock_seconds: 30,

    token_or_turn_limit: {
      status: 'unknown',
      reason: 'Subscription path has no enforceable token limit'
    },

    cpu_count: 2,
    cpu_enforcement_status: 'enforced',
    memory_megabytes: 2048,
    memory_enforcement_status: 'enforced'
  }

  const stackBase = {
    document_type: 'stack',
    schema_version: 1,
    revision: '1',

    agent: {
      product: 'codex',
      cli_version: '0.153.2',
      requested_model: 'provider-free-fixture',

      observed_provider_identity: {
        status: 'unknown',
        reason: 'No provider participates in this integration'
      },

      effort: 'low',

      auth: {
        mode: 'chatgpt_subscription',
        credential_store: 'file'
      }
    },

    runner: {
      name: 'harbor',
      version: '0.22.0',
      config_digest: runnerDigest(),

      telemetry: {
        requested: 'off',
        effective: 'off',
        owner_opt_in: false
      },

      concurrency: {
        requested: 1,

        effective: {
          status: 'known',
          value: 1
        },

        enforcement_status: 'enforced'
      }
    },

    environment: {
      id: 'macos-arm64-docker',
      revision: '1',
      digest: sha256('integration-host')
    },

    network_policy: {
      revision: '1',
      digest: sha256('integration-network'),
      mode: 'public_unrestricted_agent'
    },

    effective_permissions_digest: sha256('integration-permissions'),
    mcp_tools_digest: mcpDigest,
    budget
  }

  const stacks = [
    {
      ...stackBase,
      stack_id: 'integration-stack-a',
      digest: sha256('integration-stack-a'),

      harness: {
        id: harnessA.manifest.harness_id,
        revision: harnessA.manifest.revision,
        digest: harnessA.manifest.digest
      }
    },
    {
      ...stackBase,
      stack_id: 'integration-stack-b',
      digest: sha256('integration-stack-b'),

      harness: {
        id: harnessB.manifest.harness_id,
        revision: harnessB.manifest.revision,
        digest: harnessB.manifest.digest
      }
    }
  ]

  const instruction = 'Create RESULT.md for the fixture.\n'

  const task = {
    document_type: 'task',
    schema_version: 1,
    task_id: 'run-integration',
    revision: '1',
    base_commit: materialized.baseCommit,
    source_digest: materialized.sourceDigest,

    environment: {
      id: 'integration-agent',
      revision: '1',
      digest: imageIds.agent
    },

    collector: {
      revision: '1',
      image_digest: imageIds.collector
    },

    verifier: {
      revision: '1',
      image_digest: imageIds.verifier,

      network_enforcement_sidecar_digest: {
        status: 'not_applicable',
        reason: 'Docker disables verifier networking'
      }
    },

    scoring: {
      revision: '1',
      rubric_revision: '1'
    },

    prompt: {
      path: 'instruction.md',
      digest: sha256(instruction)
    },

    declared_artifacts: [
      {
      path: 'workspace.patch',
      required: true
    },
      {
      path: 'workspace-metadata.json',
      required: true
    }
    ],

    rubric: [
      {
        obligation_id: 'direct',
        facet: 'direct_behavior',
        expectation: 'The fake agent creates RESULT.md',
        evidence_paths: ['README.md'],
        justification: 'The public fixture states the expected result',
        deterministic_check: 'tests/test.sh',
        applicability: 'required',
        weight: 1
      },
      {
        obligation_id: 'regression',
        facet: 'regression',
        expectation: 'The source remains replayable',
        evidence_paths: ['README.md'],
        justification: 'Replay protects the pristine fixture source',
        deterministic_check: 'tests/test.sh',
        applicability: 'required',
        weight: 1
      }
    ],

    scope: {
      allowed: ['RESULT.md'],
      conditional: [],
      forbidden: ['README.md']
    },

    online_reachability: {
      status: 'ineligible',
      reason: 'The checked-in integration fixture is public'
    },

    retention: {
      classification: 'public',

      expires_at: {
        status: 'not_applicable',
        reason: 'Public synthetic fixture'
      }
    }
  } satisfies TaskDocument

  const suite = {
    document_type: 'suite',
    schema_version: 1,
    suite_id: 'run-integration-suite',
    revision: '1',
    digest: sha256('integration-suite'),

    tasks: [{
      task_id: task.task_id,
      revision: task.revision,
      source_digest: task.source_digest
    }]
  }

  const modes = ['success', 'fail', 'cancel'] as const

  const blocks = modes.map((mode, index) => ({
    block_id: `integration-${mode}`,
    task_id: task.task_id,
    replicate: index + 1,

    runs: [
      {
      run_id: `integration-${mode}`,
      arm_id: 'a',
      attempt: 1,
      selected: false
    },
      {
      run_id: `control-${mode}`,
      arm_id: 'b',
      attempt: 1,
      selected: false
    }
    ],

    first_started_at: {
      status: 'known',
      value: '2026-09-06T08:00:00Z'
    },

    deadline_at: {
      status: 'known',
      value: '2026-09-07T08:00:00Z'
    },

    completed_at: {
      status: 'unknown',
      reason: 'Block is still in progress'
    },

    completion_status: 'in_progress',
    contemporaneity: { status: 'pending' }
  }))

  const executionOrder = blocks.flatMap((block, blockIndex) => [
    {
      sequence: blockIndex * 2 + 1,
      block_id: block.block_id,
      arm_id: 'a',
      task_id: task.task_id,
      replicate: block.replicate
    },
    {
      sequence: blockIndex * 2 + 2,
      block_id: block.block_id,
      arm_id: 'b',
      task_id: task.task_id,
      replicate: block.replicate
    }
  ])

  const experiment = {
    document_type: 'experiment',
    schema_version: 1,
    experiment_id: 'run-integration-experiment',
    revision: '1',
    plan_digest: sha256('integration-experiment'),
    analysis_revision: '1',
    comparison_kind: 'harness_effect',

    suite: {
      id: suite.suite_id,
      revision: suite.revision,
      digest: suite.digest
    },

    arms: [
      {
        arm_id: 'a',

        stack: {
          id: stacks[0]!.stack_id,
          revision: '1',
          digest: stacks[0]!.digest
        },

        harness: stacks[0]!.harness,
        treatment: 'Provider-free fake Codex'
      },
      {
        arm_id: 'b',

        stack: {
          id: stacks[1]!.stack_id,
          revision: '1',
          digest: stacks[1]!.digest
        },

        harness: stacks[1]!.harness,
        treatment: 'Provider-free control harness'
      }
    ],

    tasks: suite.tasks,
    repeats: 3,
    ordering_seed: 7,

    retry_policy: {
      max_attempts_per_arm: 1,
      retryable_classifications: []
    },

    execution_order: executionOrder,
    budget,
    requested_concurrency: 1,

    effective_concurrency: {
      status: 'known',
      value: 1
    },

    concurrency_enforcement_status: 'enforced',
    blocks
  }

  const documentsRoot = resolve(temporaryRoot, 'documents')

  await mkdir(documentsRoot)

  const documentPaths = {
    experiment: resolve(documentsRoot, 'experiment.json'),

    harnesses: [
      resolve(documentsRoot, 'harness-a.json'),
      resolve(documentsRoot, 'harness-b.json')
    ],

    stacks: [
      resolve(documentsRoot, 'stack-a.json'),
      resolve(documentsRoot, 'stack-b.json')
    ],

    suite: resolve(documentsRoot, 'suite.json'),
    task: resolve(documentsRoot, 'task.json')
  }

  await Promise.all([
    writeJson(documentPaths.experiment, experiment),
    writeJson(documentPaths.harnesses[0]!, harnessA.manifest),
    writeJson(documentPaths.harnesses[1]!, harnessB.manifest),
    writeJson(documentPaths.stacks[0]!, stacks[0]),
    writeJson(documentPaths.stacks[1]!, stacks[1]),
    writeJson(documentPaths.suite, suite),
    writeJson(documentPaths.task, task)
  ])

  const providerCanary = await startProviderCanary()

  try {
    const taskPackages = Object.fromEntries(
      await Promise.all(modes.map(async (mode) => [
        mode,
        await prepareTaskPackage(
          temporaryRoot,
          mode,
          materialized.baseCommit,
          materialized.sourceDigest,
          providerCanary.url
        )
      ]))
    ) as Record<(typeof modes)[number], string>

  const authPath = resolve(temporaryRoot, 'provider-free-auth.json')

  await writeFile(authPath, '{"fixture":"provider-free-fake-codex-auth"}\n', {
    mode: 0o600
  })

  await chmod(authPath, 0o600)

  process.env.CODEX_AUTH_JSON_PATH = authPath

  const runtime: RunRuntime = {
    inspectHost: async () => ({
      apple_silicon_model: command('/usr/sbin/sysctl', ['-n', 'hw.model']),
      architecture: 'arm64',
      benchmark_repo_commit: command('git', ['rev-parse', 'HEAD']),
      container_architecture: 'linux/arm64',

      docker_desktop_version: command('/usr/bin/defaults', [
        'read',
        '/Applications/Docker.app/Contents/Info',
        'CFBundleShortVersionString'
      ]),

      docker_engine_version: command('docker', [
        'version',
        '--format={{.Server.Version}}'
      ]),

      linuxkit_kernel: command('docker', ['info', '--format={{.KernelVersion}}']),
      os: 'macos',
      os_version: command('/usr/bin/sw_vers', ['-productVersion'])
    }),

    now: () => new Date(),

    runHarbor: async (context) => {
      const cancel = context.runDirectory.endsWith('integration-cancel')

      const cancelTimer = cancel
        ? setTimeout(() => process.kill(process.pid, 'SIGINT'), 5_000)
        : undefined

      try {
        return await runHarborProcess(context, harborBinary)
      } finally {
        if (cancelTimer !== undefined) {
          clearTimeout(cancelTimer)
        }
      }
    }
  }

  const expected = {
    success: 'task_success',
    fail: 'agent_failure',
    cancel: 'cancellation'
  } as const

  for (const mode of modes) {
    const runId = `integration-${mode}`

    const plan = await resolveRunPlan({
      experiment: documentPaths.experiment,
      harnessBundle: harnessA.bundlePath,
      harnessDocuments: documentPaths.harnesses,
      runId,
      runsDirectory: resolve(temporaryRoot, 'runs'),
      stackDocuments: documentPaths.stacks,
      suite: documentPaths.suite,
      taskDocuments: [documentPaths.task],
      taskPackage: taskPackages[mode],
      taskSource: source
    })

    if (mode === 'success') {
      await assertPinnedTaskImages(
        plan.task,
        plan.inputs.task_package.image_references,
        plan.inputs.task_package.runtime_controls.agent_user,
        repositoryRoot
      )

      let wrongUserRejected = false

      try {
        await assertPinnedTaskImages(
          plan.task,
          plan.inputs.task_package.image_references,
          'root',
          repositoryRoot
        )
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'PIN_MISMATCH') {
          throw error
        }

        wrongUserRejected = true
      }

      if (!wrongUserRejected) {
        throw new Error('Pinned agent image accepted the wrong declared user')
      }
    }

    const result = await executeRunPlanWithRuntime(plan, runtime)

    if (result.classification !== expected[mode]) {
      throw new Error(
        `${mode} classified as ${result.classification}, expected ${expected[mode]}`
      )
    }

    const config = JSON.parse(
      await readFile(
        resolve(result.run_directory, 'raw/runner/job-config.json'),
        'utf8'
      )
    ) as {
      agents?: Array<{ kwargs?: Record<string, unknown>; n_concurrent?: unknown }>;
      environment?: Record<string, unknown>;
      n_attempts?: unknown;
      n_concurrent_trials?: unknown;
      retry?: { max_retries?: unknown };
      tasks?: unknown[];
    }

    const processControl = JSON.parse(
      await readFile(
        resolve(result.run_directory, 'raw/runner/process-control.json'),
        'utf8'
      )
    ) as Record<string, unknown>

    const harborJobResult = JSON.parse(
      await readFile(resolve(result.run_directory, 'raw/harbor/job/result.json'), 'utf8')
    ) as {
      n_total_trials?: unknown;
      stats?: { n_retries?: unknown };
    }

    const materializedTaskToml = await readFile(
      resolve(result.run_directory, 'raw/runner/materialized-task-package/task.toml'),
      'utf8'
    )

    const materializedCompose = await readFile(
      resolve(
        result.run_directory,
        'raw/runner/materialized-task-package/environment/docker-compose.yaml'
      ),
      'utf8'
    )

    if (
      config.n_attempts !== 1 ||
      config.n_concurrent_trials !== 1 ||
      config.retry?.max_retries !== 0 ||
      config.agents?.length !== 1 ||
      config.tasks?.length !== 1 ||
      config.agents[0]?.n_concurrent !== 1 ||
      config.agents[0]?.kwargs?.version !== '0.153.2' ||
      config.environment?.cpu_enforcement_policy !== 'limit' ||
      config.environment?.memory_enforcement_policy !== 'limit' ||
      config.environment?.override_cpus !== budget.cpu_count ||
      config.environment?.override_memory_mb !== budget.memory_megabytes ||
      processControl.auth_transport !== 'private-temporary-file' ||
      processControl.harbor_telemetry !== 'off' ||
      processControl.shell !== false ||
      harborJobResult.n_total_trials !== 1 ||
      harborJobResult.stats?.n_retries !== 0 ||
      plan.inputs.task_package.runtime_controls.agent_user !== 'pwuser' ||
      !materializedTaskToml.includes(imageIds.agent) ||
      !materializedTaskToml.includes(imageIds.verifier) ||
      !materializedTaskToml.includes('user = "pwuser"') ||
      !materializedCompose.includes(imageIds.collector)
    ) {
      throw new Error('Integration runner controls drifted')
    }

    if (mode === 'success') {
      const normalized = await normalizeRun(result.run_directory)

      if (normalized.kind !== 'normalized') {
        throw new Error('Integration result was unexpectedly restricted')
      }

      const hasCompleteEvidence =
        normalized.record.evidence_availability.native_rollout === 'available' &&
        normalized.record.evidence_availability.atif_trajectory === 'available' &&
        normalized.record.evidence_availability.merged_agent_output === 'available'

      if (!hasCompleteEvidence) {
        throw new Error('Integration normalized evidence availability drifted')
      }

      const hasKnownZeroUsage =
        normalized.record.usage.input_tokens.status === 'known' &&
        normalized.record.usage.input_tokens.value === 0 &&
        normalized.record.usage.output_tokens.status === 'known' &&
        normalized.record.usage.output_tokens.value === 0

      if (!hasKnownZeroUsage) {
        throw new Error('Integration normalized usage drifted')
      }

      console.log(`normalized: ${normalized.digest}`)
    }

    console.log(`${mode}: ${result.classification}`)
  }

    if (
      process.env.HARNESS_BENCH_EXPERIMENT_INTEGRATION === '1' ||
      process.env.HARNESS_BENCH_REGRADE_INTEGRATION === '1'
    ) {
      const definitionPath = resolve(temporaryRoot, 'experiment-definition.json')

      await writeJson(definitionPath, {
        document_type: 'experiment_definition',
        schema_version: 1,
        experiment_id: 'integration-matrix',
        revision: '1',
        analysis_revision: '1',
        suite: documentPaths.suite,
        repeats: 1,
        ordering_seed: 42,
        budget,
        requested_concurrency: 1,

        arms: [
          {
          arm_id: 'a',
          treatment: 'A instructions',
          stack: documentPaths.stacks[0],
          harness_document: documentPaths.harnesses[0],
          harness_bundle: harnessA.bundlePath
        },
          {
          arm_id: 'b',
          treatment: 'B instructions',
          stack: documentPaths.stacks[1],
          harness_document: documentPaths.harnesses[1],
          harness_bundle: harnessB.bundlePath
        }
        ],

        tasks: [{
          document: documentPaths.task,
          source,
          package: taskPackages.success
        }]
      })

      const matrix = await planExperiment(definitionPath, resolve(temporaryRoot, 'runs'))
      const matrixPath = await saveExperimentPlan(matrix)
      let stoppedBetweenAssignments = false
      let matrixInvocations = 0

      const matrixRuntime = {
        now: () => new Date(),

        readState: async (plan: typeof matrix, recover: boolean) => {
          const state = await readExperimentState(plan, recover)
          const history = await readExperimentHistory(plan)
          const finished = history.entries.filter(({ event }) => event.type === 'finished')

          if (!stoppedBetweenAssignments && finished.length === 1) {
            stoppedBetweenAssignments = true
            throw new Error('Deterministic controller stop between assignments')
          }

          return state
        },

        execute: async (plan: Awaited<ReturnType<typeof resolveRunPlan>>) => {
          matrixInvocations += 1

          return executeRunPlanWithRuntime(plan, runtime)
        }
      }

      try {
        await executeExperiment(matrixPath, false, matrixRuntime)

        throw new Error('Expected a deterministic matrix interruption')
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'Deterministic controller stop between assignments') throw error
      }

      if (matrixInvocations !== 1) throw new Error('Matrix did not stop after its first assignment')

      const resumed = await executeExperiment(matrixPath, true, matrixRuntime)
      const finalInvocations = Number(matrixInvocations)

      if (finalInvocations !== 2 || resumed.blocks.some(({ status }) => status !== 'completed')) throw new Error('Matrix resume did not finish both arms exactly once')

      const inspected = await readExperimentState(matrix)

      if (inspected.blocks.some(({ runs }) => runs.some(({ result }) => result?.classification !== 'task_success'))) throw new Error('Matrix report lost a verified successful result')

      if (process.env.HARNESS_BENCH_REGRADE_INTEGRATION === '1') {
        await runRegradeIntegration({
          documentsRoot,
          matrix,
          matrixPath,
          task,
          taskPackage: taskPackages.success,
          temporaryRoot
        })
      }

      console.log(`experiment_matrix: 2 verified arms, interrupted/resumed, ${finalInvocations} invocations`)
      console.log(`experiment_plan: ${matrixPath}`)
    }

    assertNoRunDockerResources(temporaryRoot)

    if (providerCanary.observedAttempts() !== 0) {
      throw new Error(
        `Provider canary observed ${providerCanary.observedAttempts()} forbidden request(s)`
      )
    }

    console.log(`provider_calls: ${providerCanary.observedAttempts()}`)
    console.log(`integration_root: ${temporaryRoot}`)
  } finally {
    await providerCanary.close()
  }
}

const originalUmask = process.umask(0o077)

try {
  await main()
} finally {
  process.umask(originalUmask)
}
