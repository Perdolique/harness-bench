import { access } from 'node:fs/promises'

// @ts-expect-error -- The integration image provides this absolute module.
import { captureWorkspaceArtifacts } from '/opt/core/task-artifacts.ts'

const sourceDigest = process.env.TASK_SOURCE_DIGEST
const baseCommit = process.env.TASK_BASE_COMMIT

if (sourceDigest === undefined || baseCommit === undefined) {
  throw new Error('Collector requires TASK_SOURCE_DIGEST and TASK_BASE_COMMIT')
}

for (const name of ['CODEX_ACCESS_TOKEN', 'CODEX_AUTH_JSON_PATH', 'OPENAI_API_KEY']) {
  if (process.env[name] !== undefined) {
    throw new Error('Collector received an agent credential environment variable')
  }
}

try {
  await access('/tmp/codex-secrets/auth.json')

  throw new Error('Collector received the agent credential file')
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}

await captureWorkspaceArtifacts({
  artifacts: '/evidence',
  baseCommit,
  expectedSourceDigest: sourceDigest,
  source: '/trusted/source',
  workspace: '/workspace'
})
