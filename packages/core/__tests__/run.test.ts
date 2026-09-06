import { createHash } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import { captureHarnessBundle } from '../src/harness.ts'

import {
  executeRunPlanWithRuntime,
  runHarborProcess,
  type HarborExecutionContext,
  type RunRuntime
} from '../src/run-execution.ts'

import { inspectRunTree, resolveRunPlan, type ResolveRunPlanOptions } from '../src/run.ts'
import { inspectTaskSource, materializeTaskWorkspace } from '../src/task.ts'
import { captureWorkspaceArtifacts } from '../src/task-artifacts.ts'

const digest = (value: string | Uint8Array): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

let fakeCodexRoot: string
let fakeCodexAuditPath: string

async function makeWritable(path: string): Promise<void> {
  let metadata

  try {
    metadata = await lstat(path)
  } catch {
    return
  }

  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    await chmod(path, 0o700)

    for (const entry of await readdir(path)) {
      await makeWritable(resolve(path, entry))
    }
  } else if (!metadata.isSymbolicLink()) {
    await chmod(path, 0o600)
  }
}

async function removeFixture(path: string): Promise<void> {
  await makeWritable(path)

  await rm(path, {
    force: true,
    recursive: true
  })
}

beforeAll(async () => {
  fakeCodexRoot = await mkdtemp('/tmp/harness-bench-run-codex-')
  fakeCodexAuditPath = resolve(fakeCodexRoot, 'audit.log')

  const fakeCodex = resolve(fakeCodexRoot, 'codex')

  await writeFile(
    fakeCodex,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${fakeCodexAuditPath}
if [ "$1" = "--version" ]; then
  printf 'codex-cli 0.153.2\\n'
elif [ "$1" = "--strict-config" ] && [ "$2" = "doctor" ]; then
  printf '{"checks":{"config.load":{"status":"ok"}}}\\n'
elif [ "$1" = "exec" ] && [ "$2" = "--strict-config" ]; then
  printf 'unknown configuration field zzzzzzzzzzzzzzzzzzzzzzzzzzzz_harness_bench_strict_config_control\\n' >&2
  exit 2
elif [ "$1" = "mcp" ]; then
  printf '[]\\n'
else
  exit 9
fi
`
  )

  await writeFile(fakeCodexAuditPath, '')
  await chmod(fakeCodex, 0o700)

  process.env.HARNESS_BENCH_TEST_CODEX_BINARY = fakeCodex
})

afterAll(async () => {
  delete process.env.HARNESS_BENCH_TEST_CODEX_BINARY

  await removeFixture(fakeCodexRoot)
})

function runnerDigest(): string {
  return digest(JSON.stringify({
    agent: 'codex',
    agent_cli_version: '0.153.2',
    agent_timeout_seconds: 600,
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeCredential(path: string, value: string): Promise<void> {
  await writeFile(path, value, { mode: 0o600 })
  await chmod(path, 0o600)
}

async function makeHarness(
  root: string,
  id: string,
  instructions: string,
  rules = false
): Promise<{ readonly bundlePath: string; readonly manifest: Record<string, unknown> }> {
  const source = resolve(root, `${id}-source`)
  const store = resolve(root, `${id}-store`)

  await mkdir(source)

  await writeFile(
    resolve(source, 'config.toml'),
    'forced_login_method = "chatgpt"\ndeveloper_instructions = "Existing instructions."\n'
  )

  await writeFile(
    resolve(source, 'mcp-tools.json'),
    `${JSON.stringify({
      mcp_servers: [{
        args: ['serve'],
        command: 'fixture-tool',
        name: 'fixture-tool',
        transport: 'stdio'
      }]
    })}\n`
  )

  await writeFile(resolve(source, 'AGENTS.md'), 'Base instructions must not win.\n')
  await writeFile(resolve(source, 'AGENTS.override.md'), instructions)
  await mkdir(resolve(source, 'skills/sample'), { recursive: true })

  await writeFile(
    resolve(source, 'skills/sample/SKILL.md'),
    '---\nname: sample\ndescription: Fixture skill.\n---\n\nUse the fixture skill.\n'
  )

  if (rules) {
    await mkdir(resolve(source, 'rules'))

    await writeFile(
      resolve(source, 'rules/default.rules'),
      'prefix_rule(pattern=["git", "status"], decision="allow")\n'
    )
  }

  const result = await captureHarnessBundle({
    harnessId: id,
    revision: '1',
    source,
    store
  })

  return {
    bundlePath: result.bundlePath,
    manifest: result.manifest
  }
}

async function fixture(options: { readonly selectedRules?: boolean } = {}): Promise<{
  readonly options: ResolveRunPlanOptions;
  readonly root: string;
  readonly selectedStackPath: string;
}> {
  const root = await mkdtemp('/tmp/harness-bench-run-test-')

  const selectedHarness = await makeHarness(
    root,
    'harness-a',
    'A override instructions.\n',
    options.selectedRules
  )

  const otherHarness = await makeHarness(root, 'harness-b', 'B instructions.\n')
  const source = resolve(root, 'task-source')

  await mkdir(source)
  await writeFile(resolve(source, 'README.md'), 'fixture source\n')

  const sourceSnapshot = await inspectTaskSource(source)
  const sourceDigest = sourceSnapshot.digest
  const temporaryWorkspace = resolve(root, 'base-workspace')

  const { baseCommit } = await materializeTaskWorkspace({
    destination: temporaryWorkspace,
    expectedSourceDigest: sourceDigest,
    source
  })

  await rm(temporaryWorkspace, {
    force: true,
    recursive: true
  })

  const mcpDigest = (
    selectedHarness.manifest.entries as { readonly digest: string; readonly path: string }[]
  ).find(({ path }) => path === 'mcp-tools.json')!.digest

  const budget = {
    wall_clock_seconds: 600,

    token_or_turn_limit: {
      status: 'unknown',
      reason: 'Subscription execution has no enforceable token limit'
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
      requested_model: 'gpt-5.6-luna',

      observed_provider_identity: {
        status: 'unknown',
        reason: 'Provider identity unavailable'
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
      digest: digest('host')
    },

    network_policy: {
      revision: '1',
      digest: digest('network'),
      mode: 'public_unrestricted_agent'
    },

    effective_permissions_digest: digest('permissions'),
    mcp_tools_digest: mcpDigest,
    budget
  }

  const selectedStack = {
    ...stackBase,
    stack_id: 'stack-a',
    digest: digest('stack-a'),

    harness: {
      id: 'harness-a',
      revision: '1',
      digest: selectedHarness.manifest.digest
    }
  }

  const otherStack = {
    ...stackBase,
    stack_id: 'stack-b',
    digest: digest('stack-b'),

    harness: {
      id: 'harness-b',
      revision: '1',
      digest: otherHarness.manifest.digest
    }
  }

  const task = {
    document_type: 'task',
    schema_version: 1,
    task_id: 'task-a',
    revision: '1',
    base_commit: baseCommit,
    source_digest: sourceDigest,

    environment: {
      id: 'agent-image',
      revision: '1',
      digest: digest('agent-image')
    },

    collector: {
      revision: '1',
      image_digest: digest('collector-image')
    },

    verifier: {
      revision: '1',
      image_digest: digest('verifier-image'),

      network_enforcement_sidecar_digest: {
        status: 'not_applicable',
        reason: 'Verifier network is disabled by Docker'
      }
    },

    scoring: {
      revision: '1',
      rubric_revision: '1'
    },

    prompt: {
      path: 'instruction.md',
      digest: digest('Do the fixture task.\n')
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
        expectation: 'Implement the requested behavior',
        evidence_paths: ['README.md'],
        justification: 'Fixture behavior evidence',
        deterministic_check: 'tests/direct.test.ts',
        applicability: 'required',
        weight: 1
      },
      {
        obligation_id: 'regression',
        facet: 'regression',
        expectation: 'Preserve existing behavior',
        evidence_paths: ['README.md'],
        justification: 'Fixture regression evidence',
        deterministic_check: 'tests/regression.test.ts',
        applicability: 'required',
        weight: 1
      }
    ],

    scope: {
      allowed: ['src'],
      conditional: [],
      forbidden: ['package.json']
    },

    online_reachability: {
      status: 'eligible',
      reason: 'Private synthetic fixture'
    },

    retention: {
      classification: 'public',

      expires_at: {
        status: 'not_applicable',
        reason: 'Public fixture'
      }
    }
  }

  const suite = {
    document_type: 'suite',
    schema_version: 1,
    suite_id: 'suite-a',
    revision: '1',
    digest: digest('suite'),

    tasks: [{
      task_id: 'task-a',
      revision: '1',
      source_digest: sourceDigest
    }]
  }

  const experiment = {
    document_type: 'experiment',
    schema_version: 1,
    experiment_id: 'experiment-a',
    revision: '1',
    plan_digest: digest('experiment'),
    analysis_revision: '1',
    comparison_kind: 'harness_effect',

    suite: {
      id: 'suite-a',
      revision: '1',
      digest: suite.digest
    },

    arms: [
      {
        arm_id: 'a',

        stack: {
          id: 'stack-a',
          revision: '1',
          digest: selectedStack.digest
        },

        harness: selectedStack.harness,
        treatment: 'Harness A'
      },
      {
        arm_id: 'b',

        stack: {
          id: 'stack-b',
          revision: '1',
          digest: otherStack.digest
        },

        harness: otherStack.harness,
        treatment: 'Harness B'
      }
    ],

    tasks: suite.tasks,
    repeats: 1,
    ordering_seed: 7,

    retry_policy: {
      max_attempts_per_arm: 1,
      retryable_classifications: []
    },

    execution_order: [
      {
      sequence: 1,
      block_id: 'block-a',
      arm_id: 'a',
      task_id: 'task-a',
      replicate: 1
    },
      {
      sequence: 2,
      block_id: 'block-a',
      arm_id: 'b',
      task_id: 'task-a',
      replicate: 1
    }
    ],

    budget,
    requested_concurrency: 1,

    effective_concurrency: {
      status: 'known',
      value: 1
    },

    concurrency_enforcement_status: 'enforced',

    blocks: [{
      block_id: 'block-a',
      task_id: 'task-a',
      replicate: 1,

      runs: [
        {
        run_id: 'run-a',
        arm_id: 'a',
        attempt: 1,
        selected: false
      },
        {
        run_id: 'run-b',
        arm_id: 'b',
        attempt: 1,
        selected: false
      }
      ],

      first_started_at: {
        status: 'known',
        value: '2026-09-05T08:00:00Z'
      },

      deadline_at: {
        status: 'known',
        value: '2026-09-06T08:00:00Z'
      },

      completed_at: {
        status: 'unknown',
        reason: 'Block is still in progress'
      },

      completion_status: 'in_progress',
      contemporaneity: { status: 'pending' }
    }]
  }

  const packagePath = resolve(root, 'task-package')

  await mkdir(resolve(packagePath, 'environment'), { recursive: true })
  await mkdir(resolve(packagePath, 'tests'), { recursive: true })
  await writeFile(resolve(packagePath, 'instruction.md'), 'Do the fixture task.\n')
  await writeFile(resolve(packagePath, 'tests/docker-compose.yaml'), 'services:\n  main:\n    network_mode: none\n')

  await writeFile(
    resolve(packagePath, 'environment/docker-compose.yaml'),
    `services:\n  main:\n    volumes:\n      - workspace:/app\n  collector:\n    image: collector@${task.collector.image_digest}\n    environment:\n      TASK_BASE_COMMIT: ${task.base_commit}\n      TASK_SOURCE_DIGEST: ${task.source_digest}\n    network_mode: none\n    volumes:\n      - workspace:/workspace:ro\nvolumes:\n  workspace:\n`
  )

  await writeFile(
    resolve(packagePath, 'task.toml'),
    `schema_version = "1.4"\n\n[metadata]\nprovider_calls = 0\nautomatic_retries = 0\nharbor_telemetry = "off"\n\n[agent]\ntimeout_sec = 600\nnetwork_mode = "public"\n\n[environment]\ndocker_image = "agent@${task.environment.digest}"\ncpus = 2\nmemory_mb = 2048\nnetwork_mode = "public"\n\n[verifier]\ntimeout_sec = 600\nenvironment_mode = "separate"\nnetwork_mode = "no-network"\n\n[verifier.env]\nTASK_BASE_COMMIT = "${task.base_commit}"\nTASK_SOURCE_DIGEST = "${task.source_digest}"\n\n[verifier.environment]\ndocker_image = "verifier@${task.verifier.image_digest}"\ncpus = 2\nmemory_mb = 2048\nnetwork_mode = "no-network"\n\n[[verifier.collect]]\nservice = "collector"\ncommand = "node /opt/collector/collector.js"\ntimeout_sec = 30\n\n[[artifacts]]\nsource = "/evidence"\ndestination = "trusted-collector"\nservice = "collector"\n`
  )

  const paths = {
    experiment: resolve(root, 'experiment.json'),
    selectedHarness: resolve(root, 'harness-a.json'),
    otherHarness: resolve(root, 'harness-b.json'),
    selectedStack: resolve(root, 'stack-a.json'),
    otherStack: resolve(root, 'stack-b.json'),
    suite: resolve(root, 'suite.json'),
    task: resolve(root, 'task.json')
  }

  await Promise.all([
    writeJson(paths.experiment, experiment),
    writeJson(paths.selectedHarness, selectedHarness.manifest),
    writeJson(paths.otherHarness, otherHarness.manifest),
    writeJson(paths.selectedStack, selectedStack),
    writeJson(paths.otherStack, otherStack),
    writeJson(paths.suite, suite),
    writeJson(paths.task, task)
  ])

  return {
    root,
    selectedStackPath: paths.selectedStack,

    options: {
      experiment: paths.experiment,
      harnessBundle: selectedHarness.bundlePath,
      harnessDocuments: [paths.selectedHarness, paths.otherHarness],
      runId: 'run-a',
      runsDirectory: resolve(root, 'runs'),
      stackDocuments: [paths.selectedStack, paths.otherStack],
      suite: paths.suite,
      taskDocuments: [paths.task],
      taskPackage: packagePath,
      taskSource: source
    }
  }
}

describe(resolveRunPlan, () => {
  it('resolves one assigned arm without creating the run directory or reading auth', async () => {
    const test = await fixture()

    const documentPaths = [
      test.options.experiment,
      ...test.options.harnessDocuments,
      ...test.options.stackDocuments,
      test.options.suite,
      ...test.options.taskDocuments
    ]

    const documentDigestsBefore = await Promise.all(
      documentPaths.map(async (path) => digest(await readFile(path)))
    )

    const sourceBefore = await inspectTaskSource(test.options.taskSource)
    const packageBefore = await inspectRunTree(test.options.taskPackage)
    const harnessBefore = await inspectRunTree(test.options.harnessBundle)

    process.env.CODEX_AUTH_JSON_PATH = resolve(test.root, 'missing-auth.json')

    try {
      const plan = await resolveRunPlan(test.options)

      expect(plan).toMatchObject({
        run_id: 'run-a',
        attempt_id: 'run-a-attempt-1',

        experiment: {
          arm_id: 'a',
          block_id: 'block-a',
          replicate: 1
        },

        runner: {
          concurrency: 1,
          max_retries: 0,
          telemetry: 'off'
        }
      })

      expect(Object.isFrozen(plan)).toBe(true)
      expect(Object.isFrozen(plan.runner)).toBe(true)
      expect(Object.isFrozen(plan.inputs.task_source.entries)).toBe(true)

      expect(() => {
        Object.assign(plan.runner, { max_retries: 1 })
      }).toThrow(TypeError)

      expect(await Promise.all(
        documentPaths.map(async (path) => digest(await readFile(path)))
      )).toEqual(documentDigestsBefore)

      expect(await inspectTaskSource(test.options.taskSource)).toEqual(sourceBefore)
      expect((await inspectRunTree(test.options.taskPackage)).digest).toBe(packageBefore.digest)
      expect((await inspectRunTree(test.options.harnessBundle)).digest).toBe(harnessBefore.digest)
      await expect(readFile(resolve(test.options.runsDirectory, 'run-a'))).rejects.toThrow()
    } finally {
      delete process.env.CODEX_AUTH_JSON_PATH

      await removeFixture(test.root)
    }
  })

  it('rejects a missing assignment, changed source, policy rules, and pin drift', async () => {
    const test = await fixture()

    try {
      await expect(resolveRunPlan({
        ...test.options,
        runId: 'missing'
      })).rejects.toMatchObject({
        code: 'RELATIONSHIP_MISMATCH'
      })

      const sourcePath = resolve(test.options.taskSource, 'README.md')

      await writeFile(sourcePath, 'changed\n')
      await expect(resolveRunPlan(test.options)).rejects.toMatchObject({ code: 'INPUT_CHANGED' })
      await writeFile(sourcePath, 'fixture source\n')

      const stack = JSON.parse(await readFile(test.selectedStackPath, 'utf8')) as Record<string, unknown>
      const agent = stack.agent as Record<string, unknown>

      agent.cli_version = '0.154.0'

      await writeJson(test.selectedStackPath, stack)
      await expect(resolveRunPlan(test.options)).rejects.toMatchObject({ code: 'PIN_MISMATCH' })
    } finally {
      await removeFixture(test.root)
    }
  })

  it('rejects a selected bundle whose rules cannot be enforced by Harbor', async () => {
    const test = await fixture({ selectedRules: true })

    try {
      await expect(resolveRunPlan(test.options)).rejects.toMatchObject({
        code: 'UNSUPPORTED_CONTROL'
      })
    } finally {
      await removeFixture(test.root)
    }
  })

  it('rejects an existing run directory before execution', async () => {
    const test = await fixture()

    try {
      await mkdir(resolve(test.options.runsDirectory, 'run-a'), { recursive: true })

      await expect(resolveRunPlan(test.options)).rejects.toMatchObject({
        code: 'DESTINATION_EXISTS'
      })
    } finally {
      await removeFixture(test.root)
    }
  })

  it('rejects a completed or selected assignment', async () => {
    const test = await fixture()
    const experimentPath = test.options.experiment

    const experiment = JSON.parse(await readFile(experimentPath, 'utf8')) as {
      blocks: Array<Record<string, unknown> & { runs: Array<Record<string, unknown>> }>;
    }

    experiment.blocks[0]!.completion_status = 'completed'
    experiment.blocks[0]!.completed_at = {
      status: 'known',
      value: '2026-09-05T09:00:00Z'
    }

    experiment.blocks[0]!.contemporaneity = { status: 'eligible' }

    for (const run of experiment.blocks[0]!.runs) {
      run.selected = true
    }

    try {
      await writeJson(experimentPath, experiment)

      await expect(resolveRunPlan(test.options)).rejects.toMatchObject({
        code: 'RELATIONSHIP_MISMATCH'
      })
    } finally {
      await removeFixture(test.root)
    }
  })

  it.each([
    ['provider calls', 'provider_calls = 0', 'provider_calls = 1'],
    [
      'agent timeout',
      'timeout_sec = 600\nnetwork_mode = "public"',
      'timeout_sec = 599\nnetwork_mode = "public"'
    ],
    ['agent network', 'network_mode = "public"', 'network_mode = "no-network"'],
    ['environment CPU', 'cpus = 2', 'cpus = 4'],
    ['environment memory', 'memory_mb = 2048', 'memory_mb = 4096'],
    [
      'environment network',
      'memory_mb = 2048\nnetwork_mode = "public"',
      'memory_mb = 2048\nnetwork_mode = "no-network"'
    ],
    [
      'verifier network',
      'environment_mode = "separate"\nnetwork_mode = "no-network"',
      'environment_mode = "separate"\nnetwork_mode = "public"'
    ],
    [
      'verifier environment memory',
      'memory_mb = 2048\nnetwork_mode = "no-network"\n\n[[verifier.collect]]',
      'memory_mb = 4096\nnetwork_mode = "no-network"\n\n[[verifier.collect]]'
    ],
    ['verifier timeout', 'timeout_sec = 600\nenvironment_mode', 'timeout_sec = 0\nenvironment_mode'],
    ['collector timeout', 'timeout_sec = 30\n\n[[artifacts]]', 'timeout_sec = 0\n\n[[artifacts]]'],
    ['collector service', 'service = "collector"\ncommand', 'service = "main"\ncommand'],
    ['artifact destination', 'destination = "trusted-collector"', 'destination = "untrusted"'],
    ['telemetry', 'harbor_telemetry = "off"', 'harbor_telemetry = "on"'],
    ['automatic retries', 'automatic_retries = 0', 'automatic_retries = 1']
  ] as const)('rejects task TOML %s drift', async (_name, from, to) => {
    const test = await fixture()
    const taskToml = resolve(test.options.taskPackage, 'task.toml')

    try {
      const source = await readFile(taskToml, 'utf8')

      await writeFile(taskToml, source.replace(from, to))

      await expect(resolveRunPlan(test.options)).rejects.toMatchObject({
        code: 'INVALID_TASK_PACKAGE'
      })
    } finally {
      await removeFixture(test.root)
    }
  })

  it.each([
    ['host-home bind', 'workspace:/app', '${HOME}:/host:ro'],
    ['Docker socket bind', 'workspace:/app', '/var/run/docker.sock:/var/run/docker.sock'],
    ['privileged service', '  main:\n', '  main:\n    privileged: true\n'],
    ['build override', '  main:\n', '  main:\n    build: .\n'],
    ['image override', '  main:\n', '  main:\n    image: unpinned:latest\n'],
    ['resource override', '  main:\n', '  main:\n    cpus: 8\n'],
    ['offline main service', '  main:\n', '  main:\n    network_mode: none\n'],
    [
      'collector command override',
      '    network_mode: none\n    volumes:',
      '    network_mode: none\n    command: echo forged\n    volumes:'
    ],
    [
      'extra sidecar',
      'volumes:\n  workspace:\n',
      '  rogue:\n    image: untrusted:latest\nvolumes:\n  workspace:\n'
    ],
    [
      'bind-backed named volume',
      'volumes:\n  workspace:\n',
      'volumes:\n  workspace:\n    driver_opts:\n      type: none\n      device: /tmp\n      o: bind\n'
    ],
    ['environment interpolation', 'image: collector@', 'image: ${COLLECTOR_IMAGE:-collector}@']
  ] as const)('rejects Compose %s access', async (_name, from, to) => {
    const test = await fixture()
    const composePath = resolve(test.options.taskPackage, 'environment/docker-compose.yaml')

    try {
      const compose = await readFile(composePath, 'utf8')

      await writeFile(composePath, compose.replace(from, to))

      await expect(resolveRunPlan(test.options)).rejects.toMatchObject({
        code: 'INVALID_TASK_PACKAGE'
      })
    } finally {
      await removeFixture(test.root)
    }
  })

  it.each([
    ['public network', 'network_mode: none', 'network_mode: bridge'],
    ['image override', '  main:\n', '  main:\n    image: unpinned:latest\n'],
    [
      'host bind mount',
      '    network_mode: none\n',
      '    network_mode: none\n    volumes:\n      - /tmp:/host\n'
    ],
    [
      'privileged access',
      '    network_mode: none\n',
      '    network_mode: none\n    privileged: true\n'
    ]
  ] as const)('rejects verifier Compose %s drift', async (_name, from, to) => {
    const test = await fixture()
    const composePath = resolve(test.options.taskPackage, 'tests/docker-compose.yaml')

    try {
      const compose = await readFile(composePath, 'utf8')

      await writeFile(composePath, compose.replace(from, to))

      await expect(resolveRunPlan(test.options)).rejects.toMatchObject({
        code: 'INVALID_TASK_PACKAGE'
      })
    } finally {
      await removeFixture(test.root)
    }
  })

  it('rejects an existing unsafe runs directory during dry-run resolution', async () => {
    const test = await fixture()

    try {
      await mkdir(test.options.runsDirectory, { mode: 0o755 })

      await expect(resolveRunPlan(test.options)).rejects.toMatchObject({
        code: 'DESTINATION_EXISTS'
      })
    } finally {
      await removeFixture(test.root)
    }
  })

  it('rejects a symlinked runs directory during dry-run resolution', async () => {
    const test = await fixture()
    const target = resolve(test.root, 'runs-target')

    try {
      await mkdir(target, { mode: 0o700 })
      await symlink(target, test.options.runsDirectory)

      await expect(resolveRunPlan(test.options)).rejects.toMatchObject({
        code: 'DESTINATION_EXISTS'
      })
    } finally {
      await removeFixture(test.root)
    }
  })

  it('classifies a missing task source through RunError', async () => {
    const test = await fixture()

    try {
      await rm(test.options.taskSource, { recursive: true })

      await expect(resolveRunPlan(test.options)).rejects.toMatchObject({
        code: 'INVALID_TASK_PACKAGE'
      })
    } finally {
      await removeFixture(test.root)
    }
  })

  it('rejects a TaskDocument artifact contract the collector cannot satisfy exactly', async () => {
    const test = await fixture()
    const taskPath = test.options.taskDocuments[0]!

    try {
      const task = JSON.parse(await readFile(taskPath, 'utf8')) as {
        declared_artifacts: Array<{ path: string; required: boolean }>;
      }

      task.declared_artifacts.push({
        path: 'agent-report.json',
        required: true
      })

      await writeJson(taskPath, task)

      await expect(resolveRunPlan(test.options)).rejects.toMatchObject({
        code: 'INVALID_TASK_PACKAGE'
      })
    } finally {
      await removeFixture(test.root)
    }
  })

  it('rejects a physical bundle from a different arm', async () => {
    const test = await fixture()
    const otherHarness = test.options.harnessDocuments[1]

    if (otherHarness === undefined) {
      throw new Error('Fixture is missing its control harness')
    }

    const manifest = JSON.parse(await readFile(otherHarness, 'utf8')) as {
      readonly digest: string;
    }

    try {
      await expect(resolveRunPlan({
        ...test.options,

        harnessBundle: resolve(
          test.root,
          `harness-b-store/${manifest.digest.slice('sha256:'.length)}`
        )
      })).rejects.toMatchObject({ code: 'INVALID_HARNESS' })
    } finally {
      await removeFixture(test.root)
    }
  })

  it.each([
    ['telemetry', 'UNSUPPORTED_CONTROL'],
    ['token-limit', 'UNSUPPORTED_CONTROL'],
    ['runner-digest', 'RELATIONSHIP_MISMATCH']
  ] as const)('rejects unsupported %s drift', async (control, code) => {
    const test = await fixture()

    try {
      const stack = JSON.parse(
        await readFile(test.selectedStackPath, 'utf8')
      ) as Record<string, unknown>

      const runner = stack.runner as Record<string, unknown>
      const budget = stack.budget as Record<string, unknown>

      if (control === 'telemetry') {
        runner.telemetry = {
          requested: 'on',
          effective: 'on',
          owner_opt_in: true
        }
      } else if (control === 'token-limit') {
        budget.token_or_turn_limit = {
          status: 'known',
          unit: 'turns',
          value: 10
        }
      } else {
        runner.config_digest = digest('drifted runner config')
      }

      await writeJson(test.selectedStackPath, stack)
      await expect(resolveRunPlan(test.options)).rejects.toMatchObject({ code })
    } finally {
      await removeFixture(test.root)
    }
  })
})

interface FixtureVerifierCheck {
  readonly detail: string;
  readonly facet: string;
  readonly passed: boolean;
}

type FixtureVerifierChecks = Record<string, FixtureVerifierCheck>

function scoreDocument(
  runId: string,
  verifierDigest: string,
  checks: FixtureVerifierChecks,
  success = true
): unknown {
  const evidence = (checkId: string) => ({
    check_id: checkId,
    outcome: checks[checkId]!.passed ? 'passed' : 'failed',
    evidence_digest: digest(JSON.stringify(checks[checkId]))
  })

  return {
    document_type: 'score',
    schema_version: 1,
    score_id: `score-${runId}`,
    run_id: runId,
    verifier_result_digest: verifierDigest,
    scoring_revision: '1',
    rubric_revision: '1',
    valid_grade: true,

    gates: {
      direct_behavior_pass: success,
      regression_pass: true,
      verifier_integrity_pass: true
    },

    facets: {
      direct_behavior: {
        status: 'value',
        value: success ? 1 : 0,
        evidence: [evidence('direct')]
      },

      repository_contracts: {
        status: 'value',
        value: 1,
        evidence: [evidence('contracts')]
      },

      regression: {
        status: 'value',
        value: 1,
        evidence: [evidence('regression')]
      },

      scope_integrity: {
        status: 'value',
        value: 1,
        evidence: [evidence('scope')]
      },

      maintainability: {
        status: 'not_applicable',
        reason: 'Not measured by this fixture',
        evidence: []
      }
    },

    scope_violations: [],

    harbor_reward: {
      status: 'retained_upstream',
      numeric_values: { reward: success ? 1 : 0 }
    },

    composite: {
      status: 'value',
      value: success ? 1 : 0
    }
  }
}

function runtime(
  runHarbor: (context: HarborExecutionContext) => Promise<{
    readonly cancelled: boolean;
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly timedOut: boolean;
  }>
): RunRuntime {
  const timestamps = [
    new Date('2026-09-06T10:00:00Z'),
    new Date('2026-09-06T10:00:05Z')
  ]

  return {
    inspectHost: async () => ({
      apple_silicon_model: 'Mac16,1',
      architecture: 'arm64',
      benchmark_repo_commit: 'b'.repeat(40),
      container_architecture: 'linux/arm64',
      docker_desktop_version: '4.55.0',
      docker_engine_version: '29.1.3',
      linuxkit_kernel: '6.12.54-linuxkit',
      os: 'macos',
      os_version: '26.0'
    }),

    now: () => timestamps.shift() ?? new Date('2026-09-06T10:00:05Z'),
    runHarbor
  }
}

async function writeSuccessfulHarborEvidence(
  context: HarborExecutionContext,
  plan: Awaited<ReturnType<typeof resolveRunPlan>>,
  success = true
): Promise<void> {
  const trial = resolve(context.runDirectory, 'raw/harbor/job/trial-1')
  const collector = resolve(trial, 'artifacts/trusted-collector')
  const verifier = resolve(trial, 'verifier')
  const candidate = resolve(context.runDirectory, 'candidate')

  await mkdir(resolve(context.stdoutPath, '..'), { recursive: true })
  await writeFile(context.stdoutPath, 'Harbor fixture completed\n')
  await writeFile(context.stderrPath, '')
  await mkdir(resolve(collector, '..'), { recursive: true })
  await mkdir(verifier, { recursive: true })

  await materializeTaskWorkspace({
    destination: candidate,
    expectedSourceDigest: plan.task.source_digest,
    source: plan.inputs.task_source.path
  })

  await captureWorkspaceArtifacts({
    artifacts: collector,
    baseCommit: plan.task.base_commit,
    expectedSourceDigest: plan.task.source_digest,
    source: plan.inputs.task_source.path,
    workspace: candidate
  })

  await removeFixture(candidate)

  await writeJson(resolve(trial, 'artifacts/manifest.json'), [
    {
      source: '/logs/artifacts',
      destination: 'artifacts/logs/artifacts',
      type: 'directory',
      status: 'empty',
      service: null
    },
    {
      source: '/evidence',
      destination: 'artifacts/trusted-collector',
      type: 'directory',
      status: 'ok',
      service: 'collector'
    }
  ])

  await writeFile(
    resolve(trial, 'trial.log'),
    'Stopping main service before sidecar evidence collection\nMain service stopped\nRunning collect hook in service \'collector\'\nCollect hook in service \'collector\' completed\n'
  )

  await writeJson(resolve(trial, 'result.json'), {
    verifier_environment_mode: 'separate',
    exception_info: null
  })

  const checks = {
    contracts: {
      detail: 'fixture contract check',
      facet: 'repository_contracts',
      passed: true
    },

    direct: {
      detail: 'fixture direct check',
      facet: 'direct_behavior',
      passed: success
    },

    regression: {
      detail: 'fixture regression check',
      facet: 'regression',
      passed: true
    },

    scope: {
      detail: 'fixture scope check',
      facet: 'scope_integrity',
      passed: true
    }
  }

  const verifierResult = {
    checks,

    integrity: {
      passed: true,
      credentialsAbsent: true,
      networkIsolated: true
    },

    scopeViolations: []
  }

  const verifierSource = `${JSON.stringify(verifierResult, null, 2)}\n`
  const verifierDigest = digest(verifierSource)

  await writeFile(resolve(verifier, 'verifier-result.json'), verifierSource)

  await writeJson(
    resolve(verifier, 'score.json'),
    scoreDocument(plan.run_id, verifierDigest, checks, success)
  )
}

type EvidenceControl =
  | 'collector-output'
  | 'hash'
  | 'manifest-entry'
  | 'score'
  | 'stop-evidence'
  | 'verifier-result'

type SemanticEvidenceControl =
  | 'credential-integrity'
  | 'digest-mismatch'
  | 'duplicate-check'
  | 'facet-mismatch'
  | 'gate-mismatch'
  | 'integrity-passed'
  | 'network-integrity'
  | 'omitted-check'
  | 'outcome-mismatch'
  | 'scope-mismatch'

async function removeEvidence(
  context: HarborExecutionContext,
  control: EvidenceControl
): Promise<void> {
  const trial = resolve(context.runDirectory, 'raw/harbor/job/trial-1')

  switch (control) {
    case 'collector-output':
      await rm(resolve(trial, 'artifacts/trusted-collector/workspace-metadata.json'))

      break
    case 'hash':
      await writeFile(
        resolve(trial, 'artifacts/trusted-collector/workspace.patch'),
        'changed after collection\n'
      )

      break
    case 'manifest-entry':
      await writeJson(resolve(trial, 'artifacts/manifest.json'), [])

      break
    case 'score':
      await rm(resolve(trial, 'verifier/score.json'))

      break
    case 'stop-evidence':
      await writeFile(
        resolve(trial, 'trial.log'),
        'Collect hook in service \'collector\' completed\n'
      )

      break
    case 'verifier-result':
      await rm(resolve(trial, 'verifier/verifier-result.json'))

      break
  }
}

async function mutateSemanticEvidence(
  context: HarborExecutionContext,
  control: SemanticEvidenceControl
): Promise<void> {
  const trial = resolve(context.runDirectory, 'raw/harbor/job/trial-1')
  const verifierResultPath = resolve(trial, 'verifier/verifier-result.json')
  const scorePath = resolve(trial, 'verifier/score.json')

  const verifierResult = JSON.parse(await readFile(verifierResultPath, 'utf8')) as {
    checks: Record<string, Record<string, unknown>>;
    integrity: Record<string, unknown>;
    scopeViolations: Array<Record<string, unknown>>;
  }

  const score = JSON.parse(await readFile(scorePath, 'utf8')) as {
    composite: Record<string, unknown>;
    facets: Record<string, { evidence: Array<Record<string, unknown>> }>;
    gates: Record<string, unknown>;
    scope_violations: Array<Record<string, unknown>>;
    verifier_result_digest: string;
  }

  const directEvidence = score.facets.direct_behavior!.evidence[0]!

  switch (control) {
    case 'credential-integrity':
      verifierResult.integrity.credentialsAbsent = false

      break
    case 'digest-mismatch':
      directEvidence.evidence_digest = digest('different check')

      break
    case 'duplicate-check':
      score.facets.repository_contracts!.evidence[0]!.check_id = 'direct'
      score.facets.repository_contracts!.evidence[0]!.evidence_digest =
        digest(JSON.stringify(verifierResult.checks.direct))

      break
    case 'facet-mismatch':
      verifierResult.checks.direct!.facet = 'repository_contracts'
      directEvidence.evidence_digest = digest(JSON.stringify(verifierResult.checks.direct))

      break
    case 'gate-mismatch':
      score.gates.regression_pass = false
      score.composite.value = 0

      break
    case 'integrity-passed':
      verifierResult.integrity.passed = false

      break
    case 'network-integrity':
      verifierResult.integrity.networkIsolated = false

      break
    case 'omitted-check':
      verifierResult.checks.unreported = {
        detail: 'unreported check',
        facet: 'maintainability',
        passed: true
      }

      break
    case 'outcome-mismatch':
      directEvidence.outcome = 'failed'

      break
    case 'scope-mismatch':
      verifierResult.scopeViolations.push({
        path: 'package.json',
        reason: 'Fixture scope violation'
      })

      break
  }

  await writeJson(verifierResultPath, verifierResult)

  score.verifier_result_digest = digest(await readFile(verifierResultPath))

  await writeJson(scorePath, score)
}

describe(executeRunPlanWithRuntime, () => {
  it('writes separate immutable records and seals a valid provider-free grade', async () => {
    const test = await fixture()
    const authPath = resolve(test.root, 'selected-auth.json')
    const sentinel = 'sentinel-auth-material-that-must-not-leak'
    const ignoredSource = resolve(test.options.taskSource, 'node_modules/ignored.txt')

    await writeCredential(authPath, `{"tokens":{"access_token":"${sentinel}"}}\n`)
    await mkdir(resolve(ignoredSource, '..'), { recursive: true })
    await writeFile(ignoredSource, 'ignored-source-bytes\n')

    process.env.CODEX_AUTH_JSON_PATH = authPath

    try {
      const plan = await resolveRunPlan(test.options)
      const auditBeforeExecution = (await readFile(fakeCodexAuditPath, 'utf8')).trim().split('\n').length

      const originalTaskToml = await readFile(
        resolve(test.options.taskPackage, 'task.toml'),
        'utf8'
      )

      const result = await executeRunPlanWithRuntime(
        plan,
        runtime(async (context) => {
          const initialPath = resolve(context.runDirectory, 'initial.json')
          const initial = JSON.parse(await readFile(initialPath, 'utf8')) as Record<string, unknown>

          const jobConfig = JSON.parse(
            await readFile(resolve(context.runDirectory, context.configPath), 'utf8')
          ) as {
            agents: Array<Record<string, unknown> & {
              kwargs: Record<string, unknown>;
              mcp_servers: unknown[];
              skills: string[];
            }>;
            environment: Record<string, unknown>;
            n_attempts: number;
            n_concurrent_trials: number;
            retry: Record<string, unknown>;
            tasks: Array<Record<string, unknown>>;
          }

          expect(initial).toMatchObject({ record_type: 'initial' })
          expect((await lstat(initialPath)).mode & 0o777).toBe(0o400)
          expect(await readFile(`/dev/fd/${context.authDescriptor}`, 'utf8')).toContain(sentinel)
          expect(jobConfig.n_attempts).toBe(1)
          expect(jobConfig.n_concurrent_trials).toBe(1)
          expect(jobConfig.retry.max_retries).toBe(0)
          expect(jobConfig.agents).toHaveLength(1)
          expect(jobConfig.tasks).toHaveLength(1)

          expect(jobConfig.agents[0]).toMatchObject({
            mcp_servers: [{
              args: ['serve'],
              command: 'fixture-tool',
              name: 'fixture-tool',
              transport: 'stdio'
            }],

            n_concurrent: 1,
            skills: ['staging/harness/home/.agents/skills/sample'],

            kwargs: {
              reasoning_effort: plan.stack.agent.effort,
              version: '0.153.2'
            }
          })

          expect(jobConfig.environment).toMatchObject({
            cpu_enforcement_policy: 'limit',
            memory_enforcement_policy: 'limit',
            override_cpus: plan.budget.cpu_count,
            override_memory_mb: plan.budget.memory_megabytes
          })

          await writeSuccessfulHarborEvidence(context, plan)

          return {
            cancelled: false,
            exitCode: 0,
            signal: null,
            timedOut: false
          }
        })
      )

      expect(result).toMatchObject({
        classification: 'task_success',
        valid_grade: true
      })

      const runDirectory = resolve(test.options.runsDirectory, 'run-a')
      const initialSource = await readFile(resolve(runDirectory, 'initial.json'), 'utf8')
      const completionSource = await readFile(resolve(runDirectory, 'completion.json'), 'utf8')
      const manifestSource = await readFile(resolve(runDirectory, 'raw-manifest.json'), 'utf8')

      const configSource = await readFile(
        resolve(runDirectory, 'raw/runner/job-config.json'),
        'utf8'
      )

      const effectiveConfig = await readFile(
        resolve(runDirectory, 'staging/harness/codex-home/config.toml'),
        'utf8'
      )

      const materializedTaskToml = parseToml(
        await readFile(resolve(runDirectory, 'staging/task-package/task.toml'), 'utf8')
      ) as Record<string, Record<string, unknown>>

      const materializedCompose = parseYaml(
        await readFile(
          resolve(runDirectory, 'staging/task-package/environment/docker-compose.yaml'),
          'utf8'
        )
      ) as { services: { collector: { image: string } } }

      const completion = JSON.parse(completionSource) as {
        initial_manifest_digest: string;
      }

      const materialization = JSON.parse(
        await readFile(resolve(runDirectory, 'raw/runner/materialization.json'), 'utf8')
      ) as {
        harness_tree_digest: string;
        task_package_tree_digest: string;
      }

      const stagingHarness = await inspectRunTree(resolve(runDirectory, 'staging/harness'))

      const stagingTaskPackage = await inspectRunTree(
        resolve(runDirectory, 'staging/task-package')
      )

      expect(JSON.parse(initialSource)).toMatchObject({ record_type: 'initial' })

      expect(JSON.parse(completionSource)).toMatchObject({
        record_type: 'completion',
        classification: 'task_success',
        valid_grade: true
      })

      expect(`${initialSource}${completionSource}${manifestSource}${configSource}`).not.toContain(sentinel)
      expect(`${initialSource}${completionSource}${manifestSource}${configSource}`).not.toContain(authPath)
      expect(completion.initial_manifest_digest).toBe(digest(initialSource))

      expect(materialization).toEqual({
        harness_tree_digest: stagingHarness.digest,
        task_package_tree_digest: stagingTaskPackage.digest
      })

      expect((await inspectRunTree(
        resolve(runDirectory, 'raw/runner/materialized-harness')
      )).digest).toBe(stagingHarness.digest)

      expect((await inspectRunTree(
        resolve(runDirectory, 'raw/runner/materialized-task-package')
      )).digest).toBe(stagingTaskPackage.digest)

      expect(materializedTaskToml.environment!.docker_image).toBe(
        plan.task.environment.digest
      )

      expect(materializedTaskToml.verifier!.environment).toMatchObject({
        docker_image: plan.task.verifier.image_digest
      })

      expect(materializedCompose.services.collector.image).toBe(
        plan.task.collector.image_digest
      )

      expect(await readFile(resolve(test.options.taskPackage, 'task.toml'), 'utf8')).toBe(
        originalTaskToml
      )

      const copiedDocumentDigests = [
        plan.inputs.experiment,
        ...plan.inputs.stacks,
        ...plan.inputs.harness_documents,
        plan.inputs.suite,
        ...plan.inputs.task_documents
      ]

      for (const [index, input] of copiedDocumentDigests.entries()) {
        const copiedPath = resolve(
          runDirectory,
          `inputs/documents/${String(index).padStart(3, '0')}.json`
        )

        expect(digest(await readFile(copiedPath))).toBe(input.digest)
        expect((await lstat(copiedPath)).mode & 0o777).toBe(0o400)
      }

      await expect(
        readFile(resolve(runDirectory, 'inputs/task-source/node_modules/ignored.txt'))
      ).rejects.toMatchObject({ code: 'ENOENT' })

      const auditAfterExecution = (await readFile(fakeCodexAuditPath, 'utf8')).trim().split('\n')
      const executionAudit = auditAfterExecution.slice(auditBeforeExecution)

      expect(executionAudit).toHaveLength(8)

      expect(executionAudit.slice(-4)).toEqual([
        '--version',
        '--strict-config doctor --json',
        'exec --strict-config --skip-git-repo-check --json Provider-free config rejection control',
        'mcp list --json'
      ])

      expect(effectiveConfig.indexOf('Existing instructions.')).toBeLessThan(
        effectiveConfig.indexOf('A override instructions.')
      )

      expect(effectiveConfig).not.toContain('Base instructions must not win.')
      expect((await lstat(resolve(runDirectory, 'initial.json'))).mode & 0o777).toBe(0o400)
      expect((await lstat(resolve(runDirectory, 'completion.json'))).mode & 0o777).toBe(0o400)
      expect((await lstat(resolve(runDirectory, 'raw'))).mode & 0o777).toBe(0o500)
    } finally {
      delete process.env.CODEX_AUTH_JSON_PATH

      await removeFixture(test.root)
    }
  })

  it('keeps a genuine task failure as a valid grade', async () => {
    const test = await fixture()
    const authPath = resolve(test.root, 'selected-auth.json')

    await writeCredential(authPath, '{"fixture":"selected credential"}\n')

    process.env.CODEX_AUTH_JSON_PATH = authPath

    try {
      const plan = await resolveRunPlan(test.options)

      const result = await executeRunPlanWithRuntime(
        plan,
        runtime(async (context) => {
          await writeSuccessfulHarborEvidence(context, plan, false)

          return {
            cancelled: false,
            exitCode: 0,
            signal: null,
            timedOut: false
          }
        })
      )

      expect(result).toMatchObject({
        classification: 'task_failure',
        valid_grade: true
      })
    } finally {
      delete process.env.CODEX_AUTH_JSON_PATH

      await removeFixture(test.root)
    }
  })

  it('keeps trustworthy evidence after an agent timeout as a budget-exhausted grade', async () => {
    const test = await fixture()
    const authPath = resolve(test.root, 'selected-auth.json')

    await writeCredential(authPath, '{"fixture":"selected credential"}\n')

    process.env.CODEX_AUTH_JSON_PATH = authPath

    try {
      const plan = await resolveRunPlan(test.options)

      const result = await executeRunPlanWithRuntime(
        plan,
        runtime(async (context) => {
          await writeSuccessfulHarborEvidence(context, plan, false)

          const resultPath = resolve(
            context.runDirectory,
            'raw/harbor/job/trial-1/result.json'
          )

          await writeJson(resultPath, {
            verifier_environment_mode: 'separate',

            exception_info: {
              exception_type: 'AgentTimeoutError',
              message: 'timed out after 600 seconds'
            }
          })

          return {
            cancelled: false,
            exitCode: 1,
            signal: 'SIGTERM',
            timedOut: true
          }
        })
      )

      expect(result).toMatchObject({
        classification: 'task_failure',
        valid_grade: true
      })

      const completion = JSON.parse(
        await readFile(resolve(test.options.runsDirectory, 'run-a/completion.json'), 'utf8')
      ) as Record<string, unknown>

      expect(completion).toMatchObject({
        classification: 'task_failure',

        termination: {
          kind: 'budget_exhausted'
        },

        valid_grade: true
      })

      expect(completion.score_id).toMatchObject({
        status: 'known',
        value: 'score-run-a'
      })
    } finally {
      delete process.env.CODEX_AUTH_JSON_PATH

      await removeFixture(test.root)
    }
  })

  it.each([
    ['agent_failure', {
      cancelled: false,
      exitCode: 1,
      signal: null,
      timedOut: false
    }],
    ['cancellation', {
      cancelled: true,
      exitCode: null,
      signal: 'SIGINT',
      timedOut: false
    }],
    ['agent_failure', {
      cancelled: false,
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true
    }]
  ] as const)('classifies %s without inventing a grade', async (classification, outcome) => {
    const test = await fixture()
    const authPath = resolve(test.root, 'selected-auth.json')

    await writeCredential(authPath, '{"tokens":{"access_token":"fixture-only-secret"}}\n')

    process.env.CODEX_AUTH_JSON_PATH = authPath

    try {
      const plan = await resolveRunPlan(test.options)

      const result = await executeRunPlanWithRuntime(
        plan,
        runtime(async (context) => {
          await mkdir(resolve(context.stdoutPath, '..'), { recursive: true })
          await writeFile(context.stdoutPath, '')
          await writeFile(context.stderrPath, '')

          if (outcome.exitCode === 1) {
            const trial = resolve(context.runDirectory, 'raw/harbor/job/trial-1')

            await mkdir(trial, { recursive: true })

            await writeJson(resolve(trial, 'result.json'), {
              exception_info: { exception_type: 'AgentTimeoutError' }
            })
          }

          return outcome
        })
      )

      expect(result).toMatchObject({
        classification,
        valid_grade: false
      })

      const completion = JSON.parse(
        await readFile(resolve(test.options.runsDirectory, 'run-a/completion.json'), 'utf8')
      ) as Record<string, unknown>

      expect(completion).toMatchObject({
        classification,
        valid_grade: false
      })

      expect(completion.score_id).toMatchObject({ status: 'not_applicable' })
    } finally {
      delete process.env.CODEX_AUTH_JSON_PATH

      await removeFixture(test.root)
    }
  })

  it.each([
    ['collector-output', 'runner_failure'],
    ['hash', 'runner_failure'],
    ['manifest-entry', 'runner_failure'],
    ['score', 'verifier_failure'],
    ['stop-evidence', 'runner_failure'],
    ['verifier-result', 'verifier_failure']
  ] as const)('invalidates the grade when %s evidence is removed', async (control, classification) => {
    const test = await fixture()
    const authPath = resolve(test.root, 'selected-auth.json')

    await writeCredential(authPath, '{"fixture":"selected credential"}\n')

    process.env.CODEX_AUTH_JSON_PATH = authPath

    try {
      const plan = await resolveRunPlan(test.options)

      const result = await executeRunPlanWithRuntime(
        plan,
        runtime(async (context) => {
          await writeSuccessfulHarborEvidence(context, plan)
          await removeEvidence(context, control)

          return {
            cancelled: false,
            exitCode: 0,
            signal: null,
            timedOut: false
          }
        })
      )

      expect(result).toMatchObject({
        classification,
        valid_grade: false
      })

      const completion = JSON.parse(
        await readFile(resolve(test.options.runsDirectory, 'run-a/completion.json'), 'utf8')
      ) as Record<string, unknown>

      expect(completion).toMatchObject({
        classification,
        valid_grade: false
      })

      expect(completion.score_id).toMatchObject({ status: 'not_applicable' })
    } finally {
      delete process.env.CODEX_AUTH_JSON_PATH

      await removeFixture(test.root)
    }
  })

  it.each([
    'credential-integrity',
    'digest-mismatch',
    'duplicate-check',
    'facet-mismatch',
    'gate-mismatch',
    'integrity-passed',
    'network-integrity',
    'omitted-check',
    'outcome-mismatch',
    'scope-mismatch'
  ] as const)('rejects %s verifier/score evidence drift', async (control) => {
    const test = await fixture()
    const authPath = resolve(test.root, 'selected-auth.json')

    await writeCredential(authPath, '{"fixture":"selected credential"}\n')

    process.env.CODEX_AUTH_JSON_PATH = authPath

    try {
      const plan = await resolveRunPlan(test.options)

      const result = await executeRunPlanWithRuntime(
        plan,
        runtime(async (context) => {
          await writeSuccessfulHarborEvidence(context, plan)
          await mutateSemanticEvidence(context, control)

          return {
            cancelled: false,
            exitCode: 0,
            signal: null,
            timedOut: false
          }
        })
      )

      expect(result).toMatchObject({
        classification: 'verifier_failure',
        valid_grade: false
      })

      const completion = JSON.parse(
        await readFile(resolve(test.options.runsDirectory, 'run-a/completion.json'), 'utf8')
      ) as Record<string, unknown>

      expect(completion).toMatchObject({
        classification: 'verifier_failure',
        valid_grade: false
      })

      expect(completion.score_id).toMatchObject({ status: 'not_applicable' })
    } finally {
      delete process.env.CODEX_AUTH_JSON_PATH

      await removeFixture(test.root)
    }
  })

  it.each([
    ['AgentSetupTimeoutError', 'setup', 'agent_failure', 600],
    ['EnvironmentStartTimeoutError', 'setup', 'infrastructure_failure', 600],
    ['AgentTimeoutError', 'agent', 'agent_failure', 600],
    ['QuiescenceTimeoutError', 'quiescence', 'runner_failure', 600],
    ['CollectionTimeoutError', 'collection', 'runner_failure', 30],
    ['VerifierTimeoutError', 'verification', 'verifier_failure', 600],
    ['FinalizationTimeoutError', 'finalization', 'runner_failure', 600]
  ] as const)(
    'preserves %s as %s timeout',
    async (exceptionType, stage, classification, limitSeconds) => {
      const test = await fixture()
      const authPath = resolve(test.root, 'selected-auth.json')

      await writeCredential(authPath, '{"fixture":"selected credential"}\n')

      process.env.CODEX_AUTH_JSON_PATH = authPath

      try {
        const plan = await resolveRunPlan(test.options)

        const result = await executeRunPlanWithRuntime(
          plan,
          runtime(async (context) => {
            const trial = resolve(context.runDirectory, 'raw/harbor/job/trial-1')

            await mkdir(resolve(context.stdoutPath, '..'), { recursive: true })
            await writeFile(context.stdoutPath, '')
            await writeFile(context.stderrPath, '')
            await mkdir(trial, { recursive: true })

            await writeJson(resolve(trial, 'result.json'), {
              exception_info: {
                exception_type: exceptionType,
                message: 'timed out after 617 seconds'
              }
            })

            return {
              cancelled: false,
              exitCode: 1,
              signal: null,
              timedOut: true
            }
          })
        )

        expect(result).toMatchObject({
          classification,
          valid_grade: false
        })

        const completion = JSON.parse(
          await readFile(resolve(test.options.runsDirectory, 'run-a/completion.json'), 'utf8')
        ) as Record<string, unknown>

        expect(completion.termination).toMatchObject({
          elapsed_seconds: 617,
          kind: 'timeout',
          limit_seconds: limitSeconds,
          stage
        })
      } finally {
        delete process.env.CODEX_AUTH_JSON_PATH

        await removeFixture(test.root)
      }
    }
  )

  it.each([
    ['ApiUsageLimitError', 'provider_failure'],
    ['AgentAuthenticationError', 'provider_failure'],
    ['ContextWindowExceededError', 'provider_failure'],
    ['OutputTokenExceededError', 'provider_failure'],
    ['NetworkConnectionError', 'agent_failure'],
    ['NonZeroAgentExitCodeError', 'agent_failure'],
    ['VerifierOutputParseError', 'verifier_failure'],
    ['DockerRuntimeError', 'infrastructure_failure'],
    ['UnrecognizedUpstreamError', 'runner_failure']
  ] as const)('classifies %s without a score', async (exceptionType, classification) => {
    const test = await fixture()
    const authPath = resolve(test.root, 'selected-auth.json')

    await writeCredential(authPath, '{"fixture":"selected credential"}\n')

    process.env.CODEX_AUTH_JSON_PATH = authPath

    try {
      const plan = await resolveRunPlan(test.options)

      const result = await executeRunPlanWithRuntime(
        plan,
        runtime(async (context) => {
          const trial = resolve(context.runDirectory, 'raw/harbor/job/trial-1')

          await mkdir(resolve(context.stdoutPath, '..'), { recursive: true })
          await writeFile(context.stdoutPath, '')
          await writeFile(context.stderrPath, '')
          await mkdir(trial, { recursive: true })

          await writeJson(resolve(trial, 'result.json'), {
            exception_info: { exception_type: exceptionType }
          })

          return {
            cancelled: false,
            exitCode: 1,
            signal: null,
            timedOut: false
          }
        })
      )

      expect(result).toMatchObject({
        classification,
        valid_grade: false
      })
    } finally {
      delete process.env.CODEX_AUTH_JSON_PATH

      await removeFixture(test.root)
    }
  })

  it('quarantines a credential sentinel without returning its bytes', async () => {
    const test = await fixture()
    const authPath = resolve(test.root, 'selected-auth.json')
    const sentinel = 'sentinel-auth-material-never-print-this'

    await writeCredential(authPath, `{"tokens":{"access_token":"${sentinel}"}}\n`)

    process.env.CODEX_AUTH_JSON_PATH = authPath

    try {
      const plan = await resolveRunPlan(test.options)

      const result = await executeRunPlanWithRuntime(
        plan,
        runtime(async (context) => {
          await mkdir(resolve(context.stdoutPath, '..'), { recursive: true })
          await writeFile(context.stdoutPath, `${sentinel}\n`)
          await writeFile(context.stderrPath, '')

          return {
            cancelled: false,
            exitCode: 1,
            signal: null,
            timedOut: false
          }
        })
      )

      const completionSource = await readFile(
        resolve(test.options.runsDirectory, 'run-a/completion.json'),
        'utf8'
      )

      expect(result).toMatchObject({
        classification: 'runner_failure',
        valid_grade: false
      })

      expect(JSON.stringify(result)).not.toContain(sentinel)
      expect(completionSource).not.toContain(sentinel)
      expect(completionSource).not.toContain(authPath)

      expect(JSON.parse(completionSource)).toMatchObject({
        raw_artifact_path: 'quarantine/raw'
      })
    } finally {
      delete process.env.CODEX_AUTH_JSON_PATH

      await removeFixture(test.root)
    }
  })

  it('quarantines a raw symlink and still writes an immutable completion', async () => {
    const test = await fixture()
    const authPath = resolve(test.root, 'selected-auth.json')

    await writeCredential(authPath, '{"fixture":"selected credential"}\n')

    process.env.CODEX_AUTH_JSON_PATH = authPath

    try {
      const plan = await resolveRunPlan(test.options)

      const result = await executeRunPlanWithRuntime(
        plan,
        runtime(async (context) => {
          await mkdir(resolve(context.stdoutPath, '..'), { recursive: true })
          await writeFile(context.stdoutPath, '')
          await writeFile(context.stderrPath, '')
          await symlink('/dev/null', resolve(context.runDirectory, 'raw/hostile-link'))

          return {
            cancelled: false,
            exitCode: 1,
            signal: null,
            timedOut: false
          }
        })
      )

      expect(result).toMatchObject({
        classification: 'runner_failure',
        valid_grade: false
      })

      const completionPath = resolve(test.options.runsDirectory, 'run-a/completion.json')
      const completion = JSON.parse(await readFile(completionPath, 'utf8')) as Record<string, unknown>

      expect(completion).toMatchObject({
        raw_artifact_path: 'quarantine/terminal-raw',
        valid_grade: false
      })

      expect((await lstat(completionPath)).mode & 0o777).toBe(0o400)

      expect((await lstat(
        resolve(test.options.runsDirectory, 'run-a/quarantine/invalid-raw/hostile-link')
      )).isSymbolicLink()).toBe(true)
    } finally {
      delete process.env.CODEX_AUTH_JSON_PATH

      await removeFixture(test.root)
    }
  })

  it('rejects a forged plan before reading auth or calling adapters', async () => {
    const test = await fixture()
    const inspectHost = vi.fn()
    const runHarbor = vi.fn()

    delete process.env.CODEX_AUTH_JSON_PATH

    try {
      const plan = await resolveRunPlan(test.options)
      const forged = structuredClone(plan)

      await expect(executeRunPlanWithRuntime(forged, {
        inspectHost,
        now: () => new Date(),
        runHarbor
      })).rejects.toMatchObject({ code: 'RELATIONSHIP_MISMATCH' })

      expect(inspectHost).not.toHaveBeenCalled()
      expect(runHarbor).not.toHaveBeenCalled()
    } finally {
      await removeFixture(test.root)
    }
  })

  it('rejects credentials inside run inputs before calling adapters', async () => {
    const test = await fixture()
    const inspectHost = vi.fn()
    const runHarbor = vi.fn()

    try {
      const plan = await resolveRunPlan(test.options)
      const authPath = resolve(test.options.taskPackage, 'selected-auth.json')

      await writeCredential(authPath, '{"fixture":"selected credential"}\n')

      process.env.CODEX_AUTH_JSON_PATH = authPath

      await expect(executeRunPlanWithRuntime(plan, {
        inspectHost,
        now: () => new Date(),
        runHarbor
      })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })

      expect(inspectHost).not.toHaveBeenCalled()
      expect(runHarbor).not.toHaveBeenCalled()
    } finally {
      delete process.env.CODEX_AUTH_JSON_PATH

      await removeFixture(test.root)
    }
  })

  it('rejects a credential hard link to an input document before calling adapters', async () => {
    const test = await fixture()
    const inspectHost = vi.fn()
    const runHarbor = vi.fn()

    try {
      const plan = await resolveRunPlan(test.options)
      const authPath = resolve(test.root, 'linked-auth.json')

      await link(test.options.experiment, authPath)
      await chmod(authPath, 0o600)

      process.env.CODEX_AUTH_JSON_PATH = authPath

      await expect(executeRunPlanWithRuntime(plan, {
        inspectHost,
        now: () => new Date(),
        runHarbor
      })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })

      expect(inspectHost).not.toHaveBeenCalled()
      expect(runHarbor).not.toHaveBeenCalled()
    } finally {
      delete process.env.CODEX_AUTH_JSON_PATH

      await removeFixture(test.root)
    }
  })

  it('requires the selected auth file before calling host or process adapters', async () => {
    const test = await fixture()
    const inspectHost = vi.fn()
    const runHarbor = vi.fn()

    delete process.env.CODEX_AUTH_JSON_PATH

    try {
      const plan = await resolveRunPlan(test.options)

      await expect(executeRunPlanWithRuntime(plan, {
        inspectHost,
        now: () => new Date(),
        runHarbor
      })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })

      expect(inspectHost).not.toHaveBeenCalled()
      expect(runHarbor).not.toHaveBeenCalled()
    } finally {
      await removeFixture(test.root)
    }
  })
})

describe(runHarborProcess, () => {
  it('spawns without a shell using fd-only auth and telemetry off', async () => {
    const root = await mkdtemp('/tmp/harness-bench-run-process-')
    const harbor = resolve(root, 'fake-harbor')
    const authPath = resolve(root, 'auth.json')
    const stdoutPath = resolve(root, 'raw/runner/stdout.log')
    const stderrPath = resolve(root, 'raw/runner/stderr.log')
    const ambientApiKey = process.env.OPENAI_API_KEY

    process.env.OPENAI_API_KEY = 'ambient-key-must-not-be-forwarded'

    try {
      await mkdir(resolve(stdoutPath, '..'), { recursive: true })

      await writeFile(
        harbor,
        '#!/bin/sh\n' +
        'test "$1 $2 $4" = "run --config --yes" || exit 21\n' +
        'test "$CODEX_AUTH_JSON_PATH" = "/dev/fd/3" || exit 22\n' +
        'test "$HARBOR_TELEMETRY" = "off" || exit 23\n' +
        `test "$HOME" = "${root}" || exit 24\n` +
        'test -z "$CODEX_HOME" || exit 25\n' +
        'test -z "$OPENAI_API_KEY" || exit 26\n' +
        'grep -q process-adapter-sentinel "$CODEX_AUTH_JSON_PATH" || exit 27\n' +
        'printf "provider-free harbor fixture\\n"\n'
      )

      await chmod(harbor, 0o700)
      await writeCredential(authPath, '{"token":"process-adapter-sentinel"}\n')

      const auth = await open(authPath, 'r')

      try {
        const outcome = await runHarborProcess({
          authDescriptor: auth.fd,
          configPath: 'raw/runner/job-config.json',
          runDirectory: root,
          stderrPath,
          stdoutPath,
          wallClockSeconds: 5
        }, harbor)

        expect(outcome).toEqual({
          cancelled: false,
          exitCode: 0,
          signal: null,
          timedOut: false
        })
      } finally {
        await auth.close()
      }

      expect(await readFile(stdoutPath, 'utf8')).toBe('provider-free harbor fixture\n')
      expect(await readFile(stderrPath, 'utf8')).toBe('')

      expect(JSON.parse(
        await readFile(resolve(root, 'raw/runner/process-control.json'), 'utf8')
      )).toEqual({
        auth_transport: 'inherited-fd-3',
        harbor_telemetry: 'off',
        shell: false
      })
    } finally {
      if (ambientApiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = ambientApiKey
      }

      await removeFixture(root)
    }
  })
})
