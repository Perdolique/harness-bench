import { createHash } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { CompletionRunRecord, InitialRunRecord } from '@harness-bench/schemas'

const fixtureRoot = resolve(
  import.meta.dirname,
  '../../../tests/fixtures/results/harbor-0.22.0'
)

const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`
const digestC = `sha256:${'c'.repeat(64)}`
const digestD = `sha256:${'d'.repeat(64)}`

export type FixtureClassification = CompletionRunRecord['classification']

export interface ResultFixtureOptions {
  readonly classification?: FixtureClassification;
  readonly experiment?: InitialRunRecord['experiment'];
  readonly expiresAt?: string;
  readonly harborVersion?: string;
  readonly private?: boolean;
  readonly quarantined?: boolean;
  readonly rawMutator?: (rawRoot: string) => Promise<void>;
  readonly requestedModel?: string;
  readonly runId?: string;
}

export interface ResultFixture {
  readonly runDirectory: string;
  readonly runsDirectory: string;
}

interface ManifestEntry {
  readonly digest: string;
  readonly executable: boolean;
  readonly path: string;
  readonly size: number;
}

interface MutableFixtureScore {
  readonly gates: { direct_behavior_pass: boolean };
  readonly facets: {
    direct_behavior: {
      value: number;
      evidence: Array<{ outcome: string }>;
    };
  };
  readonly harbor_reward: {
    numeric_values: { direct_behavior: number };
  };
  readonly composite: { value: number };
}

export function digest(contents: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function manifest(root: string): Promise<readonly ManifestEntry[]> {
  const entries: ManifestEntry[] = []

  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true })

    children.sort((left, right) => left.name.localeCompare(right.name))

    for (const child of children) {
      const path = resolve(directory, child.name)

      if (child.isDirectory()) {
        await visit(path)

        continue
      }

      const contents = await readFile(path)
      const metadata = await lstat(path)

      entries.push({
        digest: digest(contents),
        executable: (metadata.mode & 0o111) !== 0,
        path: relative(root, path).split('\\').join('/'),
        size: contents.byteLength
      })
    }
  }

  await visit(root)

  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

export async function sealTree(path: string): Promise<void> {
  const metadata = await lstat(path)

  if (metadata.isDirectory()) {
    for (const entry of await readdir(path)) {
      await sealTree(resolve(path, entry))
    }

    await chmod(path, 0o500)

    return
  }

  await chmod(path, (metadata.mode & 0o111) === 0 ? 0o400 : 0o500)
}

function retention(options: ResultFixtureOptions): InitialRunRecord['retention'] {
  return options.private === false
    ? {
        classification: 'public',

        expires_at: {
          status: 'not_applicable',
          reason: 'Public synthetic fixture'
        }
      }
    : {
        classification: 'private',
        default_days: 90,
        expires_at: options.expiresAt ?? '2026-12-05T12:00:00.000Z'
      }
}

function initialRecord(
  runId: string,
  options: ResultFixtureOptions
): InitialRunRecord {
  return {
    document_type: 'run',
    schema_version: 1,
    record_type: 'initial',

    identity: {
      run_id: runId,
      attempt_id: `${runId}-attempt-1`,
      attempt: 1
    },

    created_at: '2026-09-06T12:00:00.000Z',
    benchmark_repo_commit: '1'.repeat(40),

    stack: {
      id: 'fixture-stack',
      revision: '1',
      digest: digestA
    },

    suite: {
      id: 'fixture-suite',
      revision: '1',
      digest: digestB
    },

    task: {
      id: 'fixture-task',
      revision: '1',
      base_commit: 'a'.repeat(40),
      source_digest: digestB,
      environment_image_digest: digestC
    },

    collector: {
      revision: 'fixture-collector-v1',
      image_digest: digestC
    },

    verifier: {
      revision: 'fixture-verifier-v1',
      image_digest: digestD,

      network_enforcement_sidecar_digest: {
        status: 'not_applicable',
        reason: 'Docker network_mode none is direct'
      }
    },

    scoring_revision: 'fixture-scoring-v1',

    runner: {
      name: 'harbor',
      version: options.harborVersion ?? '0.22.0',
      config_digest: digestA,
      telemetry: 'off',
      requested_concurrency: 1,

      effective_concurrency: {
        status: 'known',
        value: 1
      },

      concurrency_enforcement_status: 'enforced'
    },

    agent: {
      product: 'codex',
      cli_version: '0.153.2',
      requested_model: options.requestedModel ?? 'gpt-5.6-luna',

      observed_provider_identity: {
        status: 'unknown',
        reason: 'Provider identity is hidden'
      },

      effort: 'low',
      auth_mode: 'chatgpt_subscription'
    },

    harness: {
      id: 'fixture-harness',
      revision: '1',
      digest: digestD
    },

    network_policy_digest: digestA,
    effective_permissions_digest: digestB,
    mcp_tools_digest: digestC,

    budget: {
      wall_clock_seconds: 600,

      token_or_turn_limit: {
        status: 'unknown',
        reason: 'Subscription limit is not enforceable'
      },

      cpu_count: 2,
      cpu_enforcement_status: 'enforced',
      memory_megabytes: 2048,
      memory_enforcement_status: 'enforced'
    },

    experiment: options.experiment ?? {
      experiment_id: 'fixture-experiment',
      experiment_revision: '1',
      plan_digest: digestD,
      arm_id: 'a',
      block_id: 'fixture-block',
      replicate: 1
    },

    retention: retention(options),

    host: {
      os: 'macos',
      os_version: '15.6',
      architecture: 'arm64',
      apple_silicon_model: 'Apple M4',
      docker_desktop_version: '4.50.0',
      docker_engine_version: '28.0.0',
      linuxkit_kernel: '6.10.0-linuxkit',
      container_architecture: 'linux/arm64'
    }
  }
}

function evidence(status: 'missing' | 'passed', evidenceDigest: string) {
  return status === 'passed'
    ? {
        status: 'passed' as const,

        evidence_digest: {
          status: 'known' as const,
          value: evidenceDigest
        }
      }
    : {
        status: 'missing' as const,

        evidence_digest: {
          status: 'unknown' as const,
          reason: 'No trusted evidence exists'
        }
      }
}

function termination(classification: FixtureClassification) {
  if (classification === 'cancellation') {
    return {
      kind: 'cancelled' as const,
      reason: 'Owner cancelled the run'
    }
  }

  if (classification === 'task_success' || classification === 'task_failure') {
    return { kind: 'success' as const }
  }

  return {
    kind: 'error' as const,
    reason: 'Execution did not produce a grade'
  }
}

async function setTaskFailure(rawRoot: string): Promise<void> {
  const verifier = resolve(rawRoot, 'harbor/job/trial-fixture/verifier')
  const scorePath = resolve(verifier, 'score.json')
  const rewardPath = resolve(verifier, 'reward.json')

  const score = JSON.parse(
    await readFile(scorePath, 'utf8')
  ) as MutableFixtureScore

  const reward = JSON.parse(await readFile(rewardPath, 'utf8')) as Record<string, number>

  score.gates.direct_behavior_pass = false
  score.facets.direct_behavior.value = 0

  const directEvidence = score.facets.direct_behavior.evidence[0]

  if (directEvidence === undefined) {
    throw new Error('Fixture direct evidence is missing')
  }

  directEvidence.outcome = 'failed'
  score.harbor_reward.numeric_values.direct_behavior = 0
  score.composite.value = 0
  reward.direct_behavior = 0

  await writeJson(scorePath, score)
  await writeJson(rewardPath, reward)
}

export async function createResultFixture(
  root: string,
  options: ResultFixtureOptions = {}
): Promise<ResultFixture> {
  const runId = options.runId ?? 'fixture-run'
  const classification = options.classification ?? 'task_success'
  const runsDirectory = resolve(root, 'runs')
  const runDirectory = resolve(runsDirectory, runId)
  const rawArtifactPath = options.quarantined ? 'quarantine/raw' : 'raw'
  const rawRoot = resolve(runDirectory, rawArtifactPath)

  await mkdir(runDirectory, {
    recursive: true,
    mode: 0o700
  })

  await chmod(runsDirectory, 0o700)

  await mkdir(resolve(rawRoot, '..'), {
    recursive: true,
    mode: 0o700
  })

  await cp(resolve(fixtureRoot, 'raw'), rawRoot, { recursive: true })

  const scorePath = resolve(
    rawRoot,
    'harbor/job/trial-fixture/verifier/score.json'
  )

  const score = JSON.parse(await readFile(scorePath, 'utf8')) as Record<string, unknown>

  score.run_id = runId
  score.score_id = `${runId}-score`

  await writeJson(scorePath, score)

  if (classification === 'task_failure') {
    await setTaskFailure(rawRoot)
  }

  await options.rawMutator?.(rawRoot)

  const rawManifest = await manifest(rawRoot)
  const rawManifestPath = resolve(runDirectory, 'raw-manifest.json')

  await writeJson(rawManifestPath, rawManifest)

  const initial = initialRecord(runId, options)
  const initialPath = resolve(runDirectory, 'initial.json')

  await writeJson(initialPath, initial)

  const initialDigest = digest(await readFile(initialPath))
  const rawManifestDigest = digest(await readFile(rawManifestPath))

  const verifierResultDigest = digest(
    await readFile(
      resolve(rawRoot, 'harbor/job/trial-fixture/verifier/verifier-result.json')
    )
  )

  const validGrade =
    classification === 'task_success' || classification === 'task_failure'

  const status = validGrade ? 'passed' : 'missing'
  const trialRoot = resolve(rawRoot, 'harbor/job/trial-fixture')

  const collectionDigests = {
    collection: digest(await readFile(
      resolve(trialRoot, 'artifacts/trusted-collector/workspace-metadata.json')
    )),

    exactManifest: digest(await readFile(
      resolve(trialRoot, 'artifacts/manifest.json')
    )),

    hashes: digest(await readFile(
      resolve(trialRoot, 'artifacts/trusted-collector/workspace.patch')
    )),

    quiescence: digest(await readFile(resolve(trialRoot, 'trial.log')))
  }

  const completion: CompletionRunRecord = {
    document_type: 'run',
    schema_version: 1,
    record_type: 'completion',
    identity: initial.identity,
    completed_at: '2026-09-06T12:00:10.000Z',
    initial_manifest_digest: initialDigest,
    classification,
    termination: termination(classification),

    collection: {
      collector_revision: initial.collector.revision,
      collector_image_digest: initial.collector.image_digest,
      quiescence: evidence(status, collectionDigests.quiescence),
      collection: evidence(status, collectionDigests.collection),
      exact_manifest: evidence(status, collectionDigests.exactManifest),
      hashes: evidence(status, collectionDigests.hashes)
    },

    verifier: {
      verifier_revision: initial.verifier.revision,
      verifier_image_digest: initial.verifier.image_digest,

      network_enforcement_sidecar_digest:
        initial.verifier.network_enforcement_sidecar_digest,

      separate_environment: evidence(status, digestA),
      network_disabled: evidence(status, digestA),
      credential_free: evidence(status, digestA),

      result_digest: validGrade
        ? {
        status: 'known',
        value: verifierResultDigest
      }
        : {
        status: 'unknown',
        reason: 'No valid verifier result exists'
      }
    },

    valid_grade: validGrade,

    score_id: validGrade
      ? {
      status: 'known',
      value: `${runId}-score`
    }
      : {
          status: 'not_applicable',
          reason: 'Execution did not produce a valid grade'
        },

    timings: {
      total_seconds: 10,

      agent_seconds: {
        status: 'unknown',
        reason: 'Retained in raw evidence'
      },

      verifier_seconds: {
        status: 'unknown',
        reason: 'Retained in raw evidence'
      }
    },

    usage: {
      input_tokens: {
        status: 'unknown',
        reason: 'Retained in raw evidence'
      },

      output_tokens: {
        status: 'unknown',
        reason: 'Retained in raw evidence'
      },

      subscription_money: {
        status: 'not_applicable',
        reason: 'Subscription money is not fabricated'
      },

      upstream_api_price_estimate: {
        status: 'unknown',
        reason: 'Retained in raw evidence'
      }
    },

    retention: initial.retention,
    raw_artifact_path: rawArtifactPath,
    raw_artifact_manifest_digest: rawManifestDigest
  }

  await writeJson(resolve(runDirectory, 'completion.json'), completion)

  if (options.quarantined) {
    await sealTree(resolve(runDirectory, 'quarantine'))
  } else {
    await sealTree(rawRoot)
  }

  await chmod(initialPath, 0o400)
  await chmod(rawManifestPath, 0o400)
  await chmod(resolve(runDirectory, 'completion.json'), 0o400)
  await chmod(runDirectory, 0o500)

  return {
    runDirectory,
    runsDirectory
  }
}

export async function makeWritable(path: string): Promise<void> {
  const metadata = await lstat(path)

  if (metadata.isSymbolicLink()) {
    return
  }

  if (metadata.isDirectory()) {
    await chmod(path, 0o700)

    for (const entry of await readdir(path)) {
      await makeWritable(resolve(path, entry))
    }

    return
  }

  await chmod(path, 0o600)
}
