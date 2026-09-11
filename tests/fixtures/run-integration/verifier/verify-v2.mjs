import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { access, lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyWorkspaceArtifacts } from '/opt/core/task-artifacts.ts'

const runId = process.env.HARBOR_RUN_ID
const baseCommit = process.env.TASK_BASE_COMMIT
const sourceDigest = process.env.TASK_SOURCE_DIGEST
const verifierLogs = '/logs/verifier'

if (runId === undefined || baseCommit === undefined || sourceDigest === undefined) {
  throw new Error('Verifier identity environment is incomplete')
}

function sha256(contents) {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

const workspace = '/tmp/replayed-workspace'

async function artifactCredentialsAbsent(root) {
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const entryPath = resolve(path, entry.name)
      const metadata = await lstat(entryPath)

      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        return false
      }

      if (metadata.isDirectory()) {
        if (!await visit(entryPath)) return false

        continue
      }

      const source = await readFile(entryPath, 'utf8')

      if (
        /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(source) ||
        /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(source) ||
        /["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["']?[^\s"']{8,}/i.test(source)
      ) return false
    }

    return true
  }

  return visit(root)
}

const environmentCredentialsAbsent = [
  'CODEX_ACCESS_TOKEN',
  'CODEX_AUTH_JSON_PATH',
  'OPENAI_API_KEY'
].every((name) => process.env[name] === undefined)

let credentialFilesAbsent = true

try {
  await access('/tmp/codex-secrets/auth.json')

  credentialFilesAbsent = false
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const artifactsCredentialFree = await artifactCredentialsAbsent('/evidence')
const credentialsAbsent = environmentCredentialsAbsent && credentialFilesAbsent && artifactsCredentialFree

await verifyWorkspaceArtifacts({
  artifacts: '/evidence',
  destination: workspace,
  expectedBaseCommit: baseCommit,
  expectedSourceDigest: sourceDigest,
  source: '/trusted/source'
})

const result = await readFile(resolve(workspace, 'RESULT.md'), 'utf8')

const networkIsolated = Object.values(networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .every(({ internal }) => internal)

const passed = result === 'fixture-success\n' && credentialsAbsent && networkIsolated
const directCredit = passed ? 0.5 : 0

const changedPaths = execFileSync(
  'git',
  ['-C', workspace, 'diff', '--name-only', 'HEAD'],
  { encoding: 'utf8' }
).trim().split('\n').filter(Boolean)

const scopeViolations = changedPaths
  .filter((path) => path === 'README.md')
  .map((path) => ({
    path,
    reason: 'The integration fixture forbids README.md changes'
  }))

const scopePassed = scopeViolations.length === 0

const checks = {
  contracts: {
    credit: Number(passed),
    detail: 'fixture contract check',
    facet: 'repository_contracts',
    passed
  },

  direct: {
    credit: directCredit,
    detail: 'fixture direct check with partial v2 credit',
    facet: 'direct_behavior',
    passed
  },

  regression: {
    credit: Number(passed),
    detail: 'fixture regression check',
    facet: 'regression',
    passed
  },

  scope: {
    credit: Number(scopePassed),
    detail: 'fixture scope check',
    facet: 'scope_integrity',
    passed: scopePassed
  }
}

const verifierResult = {
  checks,

  integrity: {
    credentialsAbsent,
    networkIsolated,
    passed
  },

  scopeViolations
}

const verifierSource = `${JSON.stringify(verifierResult, null, 2)}\n`
const verifierResultDigest = sha256(verifierSource)
const composite = passed ? 0.675 + 0.2 * Number(scopePassed) : 0

const evidence = (checkId) => ({
  check_id: checkId,
  outcome: checks[checkId].passed ? 'passed' : 'failed',
  evidence_digest: sha256(JSON.stringify(checks[checkId]))
})

const score = {
  document_type: 'score',
  schema_version: 1,
  score_id: `score-${runId}`,
  run_id: runId,
  verifier_result_digest: verifierResultDigest,
  scoring_revision: '2',
  rubric_revision: '2',
  valid_grade: true,

  gates: {
    direct_behavior_pass: passed,
    regression_pass: passed,
    verifier_integrity_pass: passed
  },

  facets: {
    direct_behavior: {
      status: 'value',
      value: directCredit,
      evidence: [evidence('direct')]
    },

    repository_contracts: {
      status: 'value',
      value: Number(passed),
      evidence: [evidence('contracts')]
    },

    regression: {
      status: 'value',
      value: Number(passed),
      evidence: [evidence('regression')]
    },

    scope_integrity: {
      status: 'value',
      value: Number(scopePassed),
      evidence: [evidence('scope')]
    },

    maintainability: {
      status: 'not_applicable',
      reason: 'Not measured by the provider-free integration fixture',
      evidence: []
    }
  },

  scope_violations: scopeViolations.map((violation) => ({
    ...violation,
    evidence_digest: sha256(JSON.stringify(violation))
  })),

  harbor_reward: {
    status: 'retained_upstream',

    numeric_values: {
      reward: composite,
      provider_calls: 0
    }
  },

  composite: {
    status: 'value',
    value: composite
  }
}

await writeFile(resolve(verifierLogs, 'verifier-result.json'), verifierSource)
await writeFile(resolve(verifierLogs, 'score.json'), `${JSON.stringify(score, null, 2)}\n`)

await writeFile(resolve(verifierLogs, 'reward.json'), `${JSON.stringify({
  reward: composite,
  provider_calls: 0
})}\n`)

if (!passed) process.exitCode = 1
