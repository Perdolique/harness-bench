import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { captureHarnessBundle } from '../src/harness.ts'
import { inspectTaskSource, materializeTaskWorkspace } from '../src/task.ts'
import type { ResolveRunPlanOptions } from '../src/run.ts'

const digest = (value: string | Uint8Array): string => `sha256:${createHash('sha256').update(value).digest('hex')}`

export function runnerDigest(): string {
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

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function makeHarness(
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

export async function fixture(options: { readonly selectedRules?: boolean } = {}): Promise<{
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
      },
      {
        obligation_id: 'contracts',
        facet: 'repository_contracts',
        expectation: 'Preserve the repository contract',
        evidence_paths: ['README.md'],
        justification: 'Fixture repository evidence',
        deterministic_check: 'tests/contracts.test.ts',
        applicability: 'required',
        weight: 1
      },
      {
        obligation_id: 'scope',
        facet: 'scope_integrity',
        expectation: 'Keep changes in scope',
        evidence_paths: ['README.md'],
        justification: 'Fixture scope evidence',
        deterministic_check: 'tests/scope.test.ts',
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
    `schema_version = "1.4"\n\n[metadata]\nprovider_calls = 0\nautomatic_retries = 0\nharbor_telemetry = "off"\n\n[agent]\ntimeout_sec = 600\nnetwork_mode = "public"\nuser = "pwuser"\n\n[environment]\ndocker_image = "agent@${task.environment.digest}"\ncpus = 2\nmemory_mb = 2048\nnetwork_mode = "public"\n\n[verifier]\ntimeout_sec = 600\nenvironment_mode = "separate"\nnetwork_mode = "no-network"\n\n[verifier.env]\nTASK_BASE_COMMIT = "${task.base_commit}"\nTASK_SOURCE_DIGEST = "${task.source_digest}"\n\n[verifier.environment]\ndocker_image = "verifier@${task.verifier.image_digest}"\ncpus = 2\nmemory_mb = 2048\nnetwork_mode = "no-network"\n\n[[verifier.collect]]\nservice = "collector"\ncommand = "node /opt/collector/collector.js"\ntimeout_sec = 30\n\n[[artifacts]]\nsource = "/evidence"\ndestination = "trusted-collector"\nservice = "collector"\n`
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
