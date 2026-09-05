import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CODEX_VERSION, IMAGE_NAMES, LIMITS, MODEL, REASONING_EFFORT, SPIKE_ROOT } from './constants.ts'

function renderTemplate(
  source: string,
  replacements: Readonly<Record<string, string>>
): string {
  let rendered = source

  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(token, value)
  }

  if (/__[A-Z0-9_]+__/.test(rendered)) {
    throw new Error('Task template contains an unresolved token')
  }

  return rendered
}

export async function materializeTask(runPath: string): Promise<string> {
  const datasetPath = join(runPath, 'dataset')
  const taskPath = join(datasetPath, 'normalize-room-label')
  const environmentPath = join(taskPath, 'environment')
  const testsPath = join(taskPath, 'tests')

  await Promise.all([
    mkdir(environmentPath, {
      mode: 0o700,
      recursive: true
    }),
    mkdir(testsPath, {
      mode: 0o700,
      recursive: true
    })
  ])

  const taskTemplate = await readFile(
    join(SPIKE_ROOT, 'task', 'task.toml.template'),
    'utf8'
  )

  const composeTemplate = await readFile(
    join(SPIKE_ROOT, 'task', 'environment', 'docker-compose.yaml.template'),
    'utf8'
  )

  await Promise.all([
    cp(
      join(SPIKE_ROOT, 'task', 'instruction.md'),
      join(taskPath, 'instruction.md')
    ),
    writeFile(
      join(taskPath, 'task.toml'),
      renderTemplate(taskTemplate, {
        __AGENT_IMAGE__: IMAGE_NAMES.agent,
        __VERIFIER_IMAGE__: IMAGE_NAMES.verifier
      }),
      {
        encoding: 'utf8',
        mode: 0o600
      }
    ),
    writeFile(
      join(environmentPath, 'docker-compose.yaml'),
      renderTemplate(composeTemplate, {
        __COLLECTOR_IMAGE__: IMAGE_NAMES.collector
      }),
      {
        encoding: 'utf8',
        mode: 0o600
      }
    )
  ])

  await writeFile(
    join(testsPath, 'docker-compose.yaml'),
    'services:\n  main:\n    network_mode: none\n',
    {
      encoding: 'utf8',
      mode: 0o600
    }
  )

  return datasetPath
}

export function makeJobConfig(
  runPath: string,
  datasetPath: string,
  authPath: string,
  runId: string,
  reasoningEffort: 'low' | 'medium' = REASONING_EFFORT
): unknown {
  return {
    agents: [
      {
        env: { CODEX_AUTH_JSON_PATH: authPath },

        kwargs: {
          config: join(SPIKE_ROOT, 'harness', 'config.toml'),
          reasoning_effort: reasoningEffort,
          version: CODEX_VERSION,
          web_search: 'disabled'
        },

        mcp_servers: [],
        model_name: MODEL,
        n_concurrent: 1,
        name: 'codex',
        skills: [join(SPIKE_ROOT, 'harness', 'skills', 'spike-canary')]
      }
    ],

    datasets: [{ path: datasetPath }],
    debug: true,

    environment: {
      cpu_enforcement_policy: 'limit',
      delete: true,
      force_build: false,
      memory_enforcement_policy: 'limit',
      override_cpus: LIMITS.cpuCount,
      override_memory_mb: LIMITS.memoryMegabytes,
      type: 'docker'
    },

    job_name: `issue-2-${runId}`,
    jobs_dir: join(runPath, 'harbor'),
    n_attempts: 1,
    n_concurrent_trials: 1,
    quiet: false,
    retry: { max_retries: 0 }
  }
}
