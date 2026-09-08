import { readFile, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'
import { verifyWorkspaceArtifacts } from '/opt/core/task-artifacts.ts'
import { scanCredentialTree } from '/opt/core/secret-scan.ts'
import { fixtureScore } from '/opt/verifier/score.ts'

const workspace = '/tmp/replay'

await verifyWorkspaceArtifacts({
  artifacts: '/evidence',
  destination: workspace,
  source: '/trusted/source',
  expectedBaseCommit: process.env.TASK_BASE_COMMIT,
  expectedSourceDigest: process.env.TASK_SOURCE_DIGEST
})

const contents = (name) => readFile(resolve(workspace, name), 'utf8').catch(() => '')
const scan = await scanCredentialTree({ root: '/evidence' })

const values = {
  contracts: await contents('candidate.test.txt') === 'test\n',
  direct: await contents('RESULT.md') === 'success\n',
  regression: await contents('regression.txt') === 'enabled\n',
  scope: await contents('forbidden.txt') === 'unchanged\n'
}

const integrity = {
  credentialsAbsent: !scan.credentialFound && ['OPENAI_API_KEY', 'CODEX_AUTH_JSON_PATH'].every((key) => process.env[key] === undefined),
  networkIsolated: Object.values(networkInterfaces()).flat().every((entry) => entry.internal)
}

const result = fixtureScore(process.env.HARBOR_RUN_ID, values, integrity)

await writeFile('/logs/verifier/verifier-result.json', result.verifierSource)
await writeFile('/logs/verifier/score.json', `${JSON.stringify(result.score, null, 2)}\n`)
await writeFile('/logs/verifier/reward.json', `${JSON.stringify(result.reward)}\n`)
