import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildOrderReceiptTaskDocument } from '../../../benchmark/tasks/order-receipt/task-document.ts'
import { inspectTaskSource, materializeTaskWorkspace } from '../src/index.ts'

const root = resolve(import.meta.dirname, '../../..')
const fixture = resolve(root, 'fixtures/order-receipt')

describe('canonical order receipt task', () => {
  it('materializes its frozen source and validates a v1 task document', async () => {
    const snapshot = await inspectTaskSource(fixture)
    const destination = resolve('/tmp', `order-receipt-${crypto.randomUUID()}`)

    const materialized = await materializeTaskWorkspace({
      destination,
      expectedSourceDigest: snapshot.digest,
      source: fixture
    })

    const imageDigest = `sha256:${'1'.repeat(64)}`

    const task = await buildOrderReceiptTaskDocument({
      baseCommit: materialized.baseCommit,
      collectorImageDigest: `sha256:${'2'.repeat(64)}`,
      environmentImageDigest: imageDigest,
      sourceDigest: snapshot.digest,
      verifierImageDigest: `sha256:${'3'.repeat(64)}`
    })

    expect(task.task_id).toBe('order-receipt')
    expect(task.base_commit).toBe(materialized.baseCommit)
    expect(task.source_digest).toBe(snapshot.digest)
    expect(task.environment.digest).toBe(imageDigest)
    expect(task.online_reachability.status).toBe('ineligible')

    expect(
      task.rubric.filter(({ facet }) => facet === 'repository_contracts')
    ).toHaveLength(6)

    expect(task.declared_artifacts.map(({ path }) => path)).toEqual([
      'workspace.patch',
      'workspace-metadata.json'
    ])

    await rm(destination, {
      force: true,
      recursive: true
    })
  })
})
