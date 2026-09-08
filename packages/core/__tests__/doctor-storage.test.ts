import { execFileSync } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  doctorDigest,
  doctorInventory,
  verifyDoctorInventory,
  type DoctorInventoryEntry
} from '../src/doctor-storage.ts'

import { captureWorkspaceArtifacts, verifyWorkspaceArtifacts } from '../src/task-artifacts.ts'
import { inspectTaskSource, materializeTaskWorkspace } from '../src/task.ts'
import { removeDoctorFixture } from '../../../tests/fixtures/doctor/fixture.ts'

const roots: string[] = []

async function root() {
  const value = await mkdtemp('/tmp/harness-bench-doctor-inventory-')

  roots.push(value)

  return value
}

afterEach(async () => { for (const path of roots.splice(0)) await removeDoctorFixture(path) })

describe('doctor evidence inventory', () => {
  it('records empty directories and verifies every staged entry', async () => {
    const path = await root()

    await mkdir(resolve(path, 'empty'))
    await writeFile(resolve(path, 'file.txt'), 'evidence')

    const inventory = await doctorInventory(path)

    expect(inventory.map((entry) => [entry.path, entry.kind])).toEqual([['empty', 'directory'], ['file.txt', 'file']])
    await expect(verifyDoctorInventory(path, inventory)).resolves.toBeUndefined()
    await mkdir(resolve(path, 'unlisted-empty'))
    await expect(verifyDoctorInventory(path, inventory)).rejects.toMatchObject({ code: 'INVENTORY_MISMATCH' })
  })

  it.each(['../escape', '/absolute', 'nested/sha256-manifest.json'])('rejects unsafe manifest path %s before inspecting filesystem', async (unsafe) => {
    const path = await root()

    const entry: DoctorInventoryEntry = {
      path: unsafe,
      kind: 'file',
      size: 0,
      executable: false,
      digest: doctorDigest('')
    }

    await expect(verifyDoctorInventory(path, [entry])).rejects.toMatchObject({ code: 'UNSAFE_ARTIFACT_PATH' })
  })

  it.each(['unlisted', 'missing', 'duplicate', 'conflicting', 'reserved', 'symlink', 'hardlink', 'fifo'] as const)('rejects %s evidence', async (kind) => {
    const path = await root()

    await writeFile(resolve(path, 'file.txt'), 'evidence')

    const inventory = await doctorInventory(path)

    if (kind === 'unlisted') await writeFile(resolve(path, 'extra.txt'), 'extra')

    if (kind === 'missing') await rm(resolve(path, 'file.txt'))

    if (kind === 'duplicate') inventory.push(inventory[0]!)

    if (kind === 'conflicting') inventory[0] = {
      ...inventory[0]!,
      digest: doctorDigest('other')
    }

    if (kind === 'reserved') {
      await mkdir(resolve(path, 'nested'))
      await writeFile(resolve(path, 'nested/sha256-manifest.json'), '{}')
    }

    if (kind === 'symlink') await symlink('file.txt', resolve(path, 'link'))

    if (kind === 'hardlink') await link(resolve(path, 'file.txt'), resolve(path, 'link'))

    if (kind === 'fifo') execFileSync('mkfifo', [resolve(path, 'fifo')])

    const code = ['symlink', 'hardlink', 'fifo'].includes(kind) ? 'UNSAFE_EVIDENCE'
      : kind === 'reserved' ? 'UNSAFE_ARTIFACT_PATH' : 'INVENTORY_MISMATCH'

    await expect(verifyDoctorInventory(path, inventory)).rejects.toMatchObject({ code })
  })
})

describe('workspace replay path controls', () => {
  it.each(['../escape', '/absolute', 'verifier/overlap', 'nested/sha256-manifest.json', 'duplicate', 'overlapping', 'interposed-overlap'] as const)('rejects %s in authenticated metadata before creating a replay workspace', async (kind) => {
    const path = await root()
    const source = resolve(path, 'source')

    await mkdir(source)
    await writeFile(resolve(source, 'main.txt'), 'base\n')

    const snapshot = await inspectTaskSource(source)

    const materialized = await materializeTaskWorkspace({
      source,
      destination: resolve(path, 'workspace'),
      expectedSourceDigest: snapshot.digest
    })

    const artifacts = resolve(path, 'artifacts')

    const metadata = await captureWorkspaceArtifacts({
      source,
      workspace: materialized.workspace,
      artifacts,
      baseCommit: materialized.baseCommit,
      expectedSourceDigest: snapshot.digest
    })

    const tree = [...metadata.result_tree]

    if (kind === 'duplicate') tree.push(tree[0]!)
    else if (kind === 'overlapping' || kind === 'interposed-overlap') tree.push({
      ...tree[0]!,
      path: 'main.txt/child'
    })
    else tree[0] = {
      ...tree[0]!,
      path: kind
    }

    if (kind === 'interposed-overlap') tree.push({
      ...tree[0]!,
      path: 'main.txt-other'
    })

    await writeFile(resolve(artifacts, 'workspace-metadata.json'), JSON.stringify({
      ...metadata,
      result_tree: tree
    }))

    const destination = resolve(path, 'replay')

    await expect(verifyWorkspaceArtifacts({
      artifacts,
      source,
      destination,
      expectedBaseCommit: materialized.baseCommit,
      expectedSourceDigest: snapshot.digest
    })).rejects.toThrow(/unsafe path|duplicate tree path|overlapping tree paths/)

    await expect(readFile(resolve(destination, 'main.txt'))).rejects.toThrow()
  })
})
