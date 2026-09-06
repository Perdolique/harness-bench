import { captureWorkspaceArtifacts } from '/opt/core/task-artifacts.ts'

const sourceDigest = process.env.TASK_SOURCE_DIGEST
const baseCommit = process.env.TASK_BASE_COMMIT

if (sourceDigest === undefined || baseCommit === undefined) {
  throw new Error('Collector requires TASK_SOURCE_DIGEST and TASK_BASE_COMMIT')
}

await captureWorkspaceArtifacts({
  artifacts: '/evidence',
  baseCommit,
  expectedSourceDigest: sourceDigest,
  source: '/trusted/source',
  workspace: '/workspace'
})
