import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALLOWED_CHANGED_PATHS, PROTOCOL_REVISION } from './constants.ts'
import { scanWorkspace, type TreeManifest } from './capture.ts'

interface CheckResult {
  readonly detail: string;
  readonly passed: boolean;
}

interface VerificationChecks {
  readonly canary: CheckResult;
  readonly cleanup: CheckResult;
  readonly credentials: CheckResult;
  readonly network: CheckResult;
  readonly patch: CheckResult;
  readonly regressions: CheckResult;
  readonly scope: CheckResult;
  readonly taskContract: CheckResult;
  readonly treeManifest: CheckResult;
}

interface RewardRecord {
  readonly integrity: number;
  readonly regressions: number;
  readonly scope: number;
  readonly task_contract: number;
}

interface VerificationContext {
  readonly changedPaths: readonly string[];
  readonly phase: 'public';
}

interface CollectorStatus {
  readonly canary: Record<string, boolean>;
  readonly cleanup: Record<string, { empty: boolean; exists: boolean }>;
  readonly dockerSocketPresent: boolean;
  readonly protocolRevision: string;
  readonly phase: 'public';
}

const evidencePath = '/evidence'
const verifierLogPath = '/logs/verifier'
const trustedBasePath = '/trusted/base'

function runGit(repository: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',

    env: {
      GIT_ATTR_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/tmp/verifier-git-home',
      PATH: process.env.PATH
    }
  })
}

async function readJson<T>(path: string): Promise<T> {
  const source = await readFile(path, 'utf8')

  return JSON.parse(source) as T
}

function passed(detail: string): CheckResult {
  return {
    detail,
    passed: true
  }
}

function failed(detail: string): CheckResult {
  return {
    detail,
    passed: false
  }
}

function onlyLoopbackNetwork(): boolean {
  const interfaces = Object.values(networkInterfaces()).flatMap(
    (value) => value ?? []
  )

  return interfaces.length > 0 && interfaces.every((entry) => entry.internal)
}

function credentialsAbsent(): boolean {
  const names = [
    'CODEX_ACCESS_TOKEN',
    'CODEX_AUTH_JSON_PATH',
    'OPENAI_API_KEY'
  ]

  return names.every((name) => !process.env[name])
}

function runNodeTests(
  workspace: string,
  tests: readonly string[]
): CheckResult {
  const result = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: workspace,
    encoding: 'utf8',

    env: {
      HOME: '/tmp/verifier-home',
      PATH: process.env.PATH,
      SPIKE_WORKSPACE: workspace
    }
  })

  const detail = [result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
    .trim()

  return result.status === 0 ? passed(detail) : failed(detail)
}

function allBooleanValues(value: Record<string, boolean>): boolean {
  return Object.values(value).every(Boolean)
}

function cleanupPassed(status: CollectorStatus): boolean {
  const probes = Object.values(status.cleanup)

  return probes.every((probe) => probe.empty)
}

async function conventionArtifactsEmpty(): Promise<boolean> {
  const path = '/logs/artifacts'

  if (!existsSync(path)) {
    return true
  }

  const entries = await readdir(path)

  return entries.length === 0
}

function manifestsMatch(left: TreeManifest, right: TreeManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function verify(): Promise<{
  checks: VerificationChecks;
  context: VerificationContext;
  reward: RewardRecord;
}> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'harness-bench-verify-'))
  const checkoutPath = join(temporaryRoot, 'checkout')

  try {
    await cp(trustedBasePath, checkoutPath, {
      recursive: true,
      verbatimSymlinks: true
    })

    const patchPath = join(evidencePath, 'change.patch')
    const patch = await readFile(patchPath, 'utf8')

    if (patch.trim().length > 0) {
      runGit(checkoutPath, ['apply', '--binary', patchPath])
    }

    const expectedManifest = await readJson<TreeManifest>(
      join(evidencePath, 'tree-manifest.json')
    )

    const actualManifest = await scanWorkspace(checkoutPath)
    const treeManifestPassed = manifestsMatch(expectedManifest, actualManifest)

    runGit(checkoutPath, ['add', '--all'])

    const changedPaths = runGit(checkoutPath, [
      'diff',
      '--cached',
      '--name-only',
      'HEAD',
      '--'
    ])
      .split('\n')
      .filter(Boolean)
      .sort()

    const scopePassed = changedPaths.every((path) =>
      ALLOWED_CHANGED_PATHS.includes(
        path as (typeof ALLOWED_CHANGED_PATHS)[number]
      )
    )

    const regressions = runNodeTests(checkoutPath, [
      'test/regression.test.mjs'
    ])

    const taskContract = runNodeTests(checkoutPath, ['/tests/hidden.test.mjs'])

    const status = await readJson<CollectorStatus>(
      join(evidencePath, 'collector-status.json')
    )

    const networkPassed = onlyLoopbackNetwork()

    const canaryPassed =
      Object.keys(status.canary).length === 10 &&
      allBooleanValues(status.canary) &&
      !status.dockerSocketPresent &&
      status.phase === 'public' &&
      status.protocolRevision === PROTOCOL_REVISION

    const artifactsEmpty = await conventionArtifactsEmpty()

    const integrityPassed =
      treeManifestPassed &&
      credentialsAbsent() &&
      networkPassed &&
      canaryPassed &&
      cleanupPassed(status) &&
      artifactsEmpty

    const checks: VerificationChecks = {
      canary: canaryPassed
        ? passed('all fixed canary probes passed')
        : failed('one or more fixed canary probes failed'),

      cleanup: cleanupPassed(status)
        ? passed('temporary Codex directories are empty or absent')
        : failed('temporary Codex directories retained entries'),

      credentials: credentialsAbsent()
        ? passed('no provider credential variables reached the verifier')
        : failed('provider credential variables reached the verifier'),

      network: networkPassed
        ? passed('verifier has loopback-only Docker networking')
        : failed('verifier network isolation failed'),

      patch: passed('trusted binary patch applied to the immutable base'),
      regressions,

      scope: scopePassed
        ? passed(changedPaths.join(', '))
        : failed(changedPaths.join(', ')),

      taskContract,

      treeManifest: treeManifestPassed
        ? passed('applied tree matches the collector manifest')
        : failed('applied tree differs from the collector manifest')
    }

    const reward: RewardRecord = {
      integrity: integrityPassed ? 1 : 0,
      regressions: regressions.passed ? 1 : 0,
      scope: scopePassed ? 1 : 0,
      task_contract: taskContract.passed ? 1 : 0
    }

    return {
      checks,

      context: {
        changedPaths,
        phase: status.phase
      },

      reward
    }
  } finally {
    await rm(temporaryRoot, {
      force: true,
      recursive: true
    })
  }
}

async function writeResults(
  checks: Partial<VerificationChecks>,
  reward: RewardRecord,
  context?: VerificationContext,
  integrityError?: string
): Promise<void> {
  await mkdir(verifierLogPath, { recursive: true })

  const errorClasses = Object.entries(checks)
    .filter(([, check]) => !check.passed)
    .map(([check]) => ({
      category:
        check === 'regressions'
          ? 'regression'
          : check === 'scope'
            ? 'scope'
            : check === 'taskContract'
              ? 'task-contract'
              : 'integrity',

      check
    }))

  if (integrityError) {
    errorClasses.push({
      category: 'integrity',
      check: 'verifier-exception'
    })
  }

  const verification = {
    applicability: {
      fixture: 'normalize-room-label',
      phase: context?.phase ?? 'unknown',
      syntheticFixtureOnly: true,
      verifierEnvironment: 'fresh-linux-arm64-no-network'
    },

    checks,
    errorClasses,

    evidence: {
      changedPaths: context?.changedPaths ?? [],
      evaluatedChecks: Object.keys(checks).sort()
    },

    integrityError: integrityError ?? null,
    protocolRevision: PROTOCOL_REVISION,
    schemaVersion: 'spike-1',
    validGrade: reward.integrity === 1
  }

  await writeFile(
    join(verifierLogPath, 'verification.json'),
    `${JSON.stringify(verification, null, 2)}\n`,
    'utf8'
  )

  await writeFile(
    join(verifierLogPath, 'reward.json'),
    `${JSON.stringify(reward, null, 2)}\n`,
    'utf8'
  )
}

try {
  const result = await verify()

  await writeResults(result.checks, result.reward, result.context)

  if (result.reward.integrity === 0) {
    process.exitCode = 2
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)

  await writeResults(
    {},
    {
      integrity: 0,
      regressions: 0,
      scope: 0,
      task_contract: 0
    },
    undefined,
    message
  )

  process.exitCode = 2
}
