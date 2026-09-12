import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  captureWorkspaceArtifacts,
  inspectMaterializedTaskWorkspace,
  inspectTaskSource,
  materializeTaskWorkspace,
  verifyWorkspaceArtifacts
} from '../src/index.ts'

let testRoot: string
let fixtureSequence: number

const UNSAFE_WORKSPACE_ROOTS = [
  'auth',
  'credentials',
  'logs',
  'sha256-manifest.json',
  'solution',
  'tests-hidden',
  'trusted-base',
  'trusted-tools',
  'verifier'
] as const

function sha256(contents: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

async function createSource(path: string): Promise<string> {
  await mkdir(resolve(path, 'src'), { recursive: true })
  await writeFile(resolve(path, 'package.json'), '{"private":true}\n')
  await writeFile(resolve(path, 'src', 'main.ts'), 'export const value = 1\n')

  return (await inspectTaskSource(path)).digest
}

async function waitForStagingCopy(parent: string, path: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const entries = await readdir(parent, { withFileTypes: true })

    const staging = entries.find(
      (entry) => entry.isDirectory() && entry.name.startsWith('.task-workspace-')
    )

    if (staging !== undefined) {
      const stagedPath = resolve(parent, staging.name, 'workspace', path)
      const copied = await lstat(stagedPath).then(() => true).catch(() => false)

      if (copied) {
        return
      }
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 1))
  }

  throw new Error(`Timed out waiting for staged copy of ${path}`)
}

beforeEach(async () => {
  testRoot = await mkdtemp('/tmp/harness-bench-task-test-')
  fixtureSequence = 0
})

afterEach(async () => {
  await rm(testRoot, {
    force: true,
    recursive: true
  })
})

describe('task workspace materialization', () => {
  it('creates a deterministic one-commit repository without inherited Git state', async () => {
    const source = resolve(testRoot, 'source')
    const expectedSourceDigest = await createSource(source)

    const first = await materializeTaskWorkspace({
      destination: resolve(testRoot, 'first'),
      expectedSourceDigest,
      source
    })

    const second = await materializeTaskWorkspace({
      destination: resolve(testRoot, 'second'),
      expectedSourceDigest,
      source
    })

    expect(second.baseCommit).toBe(first.baseCommit)
    expect(second.sourceDigest).toBe(expectedSourceDigest)

    const inspection = await inspectMaterializedTaskWorkspace(first.workspace)

    expect(inspection).toEqual({
      alternates: [],
      baseCommit: first.baseCommit,
      commitCount: 1,
      hooks: [],
      refs: ['refs/heads/main'],
      remotes: [],
      status: '',
      unreachable: ''
    })

    expect(execFileSync('git', ['diff', '--exit-code'], { cwd: first.workspace })).toEqual(
      Buffer.alloc(0)
    )
  })

  it('rejects a changed digest and unsafe source entries', async () => {
    const source = resolve(testRoot, 'source')

    await createSource(source)

    await expect(
      materializeTaskWorkspace({
        destination: resolve(testRoot, 'mismatch'),
        expectedSourceDigest: `sha256:${'0'.repeat(64)}`,
        source
      })
    ).rejects.toThrow('digest mismatch')

    await mkdir(resolve(source, '.git'))
    await expect(inspectTaskSource(source)).rejects.toThrow('unsafe path')
  })

  it('rejects source bytes changed after the accepted inspection', async () => {
    const source = resolve(testRoot, 'source')

    await mkdir(source)
    await writeFile(resolve(source, 'a-large.bin'), Buffer.alloc(32 * 1024 * 1024))
    await writeFile(resolve(source, 'z-target.ts'), 'export const value = 1\n')

    const expectedSourceDigest = (await inspectTaskSource(source)).digest
    const destination = resolve(testRoot, 'materialized')

    const materialization = materializeTaskWorkspace({
      destination,
      expectedSourceDigest,
      source
    })

    await waitForStagingCopy(testRoot, 'a-large.bin')
    await writeFile(resolve(source, 'z-target.ts'), 'export const value = 2\n')
    await expect(materialization).rejects.toThrow('changed while materializing')
    await expect(lstat(destination)).rejects.toThrow()
  })

  it('does not run hooks from ambient Git configuration', async () => {
    const source = resolve(testRoot, 'source')
    const expectedSourceDigest = await createSource(source)
    const hooks = resolve(testRoot, 'ambient-hooks')
    const hookMarker = resolve(testRoot, 'ambient-hook-ran')
    const globalConfig = resolve(testRoot, 'ambient-gitconfig')

    await mkdir(hooks)

    await writeFile(
      resolve(hooks, 'pre-commit'),
      `#!/bin/sh\nprintf 'ran' > ${JSON.stringify(hookMarker)}\n`
    )

    await chmod(resolve(hooks, 'pre-commit'), 0o755)
    await writeFile(globalConfig, `[core]\n\thooksPath = ${hooks}\n`)

    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL

    process.env.GIT_CONFIG_GLOBAL = globalConfig

    try {
      const materialized = await materializeTaskWorkspace({
        destination: resolve(testRoot, 'materialized'),
        expectedSourceDigest,
        source
      })

      expect((await inspectMaterializedTaskWorkspace(materialized.workspace)).status).toBe('')
      await expect(lstat(hookMarker)).rejects.toThrow()
    } finally {
      if (previousGlobalConfig === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL
      } else {
        process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig
      }
    }
  })
})

describe('trusted workspace artifacts', () => {
  async function captureFixture(): Promise<{
    readonly artifacts: string;
    readonly baseCommit: string;
    readonly source: string;
    readonly sourceDigest: string;
    readonly workspace: string;
  }> {
    fixtureSequence += 1

    const source = resolve(testRoot, `source-${fixtureSequence}`)
    const sourceDigest = await createSource(source)
    const workspace = resolve(testRoot, `workspace-${fixtureSequence}`)

    const materialized = await materializeTaskWorkspace({
      destination: workspace,
      expectedSourceDigest: sourceDigest,
      source
    })

    await writeFile(resolve(workspace, 'src', 'main.ts'), 'export const value = 2\n')
    await writeFile(resolve(workspace, 'src', 'added.ts'), 'export const added = true\n')

    const artifacts = resolve(testRoot, `artifacts-${fixtureSequence}`)

    await captureWorkspaceArtifacts({
      artifacts,
      baseCommit: materialized.baseCommit,
      expectedSourceDigest: sourceDigest,
      source,
      workspace
    })

    return {
      artifacts,
      baseCommit: materialized.baseCommit,
      source,
      sourceDigest,
      workspace
    }
  }

  it('captures exactly two artifacts and replays the verified tree', async () => {
    const fixture = await captureFixture()
    const replay = resolve(testRoot, 'replay')

    const metadata = await verifyWorkspaceArtifacts({
      artifacts: fixture.artifacts,
      destination: replay,
      expectedBaseCommit: fixture.baseCommit,
      expectedSourceDigest: fixture.sourceDigest,
      source: fixture.source
    })

    expect((await readdir(fixture.artifacts)).sort()).toEqual([
      'workspace-metadata.json',
      'workspace.patch'
    ])

    expect(await readFile(resolve(replay, 'src', 'main.ts'), 'utf8')).toContain('value = 2')
    expect(metadata.result_tree.some(({ path }) => path === 'src/added.ts')).toBe(true)
  })

  it('replays ordinary source files in a nested auth directory', async () => {
    const source = resolve(testRoot, 'auth-source')

    await createSource(source)
    await mkdir(resolve(source, 'src/auth'))
    await writeFile(resolve(source, 'src/auth/form.ts'), 'export const title = "Sign in"\n')

    const sourceDigest = (await inspectTaskSource(source)).digest

    const materialized = await materializeTaskWorkspace({
      destination: resolve(testRoot, 'auth-workspace'),
      expectedSourceDigest: sourceDigest,
      source
    })

    const updated = 'export const title = "Welcome"\n'

    await writeFile(resolve(materialized.workspace, 'src/auth/form.ts'), updated)

    const artifacts = resolve(testRoot, 'auth-artifacts')

    await captureWorkspaceArtifacts({
      artifacts,
      baseCommit: materialized.baseCommit,
      expectedSourceDigest: sourceDigest,
      source,
      workspace: materialized.workspace
    })

    const destination = resolve(testRoot, 'auth-replay')

    await verifyWorkspaceArtifacts({
      artifacts,
      destination,
      expectedBaseCommit: materialized.baseCommit,
      expectedSourceDigest: sourceDigest,
      source
    })

    expect(await readFile(resolve(destination, 'src/auth/form.ts'), 'utf8')).toBe(updated)
  })

  it('accepts an empty patch for a pristine workspace', async () => {
    const source = resolve(testRoot, 'pristine-source')
    const sourceDigest = await createSource(source)

    const materialized = await materializeTaskWorkspace({
      destination: resolve(testRoot, 'pristine-workspace'),
      expectedSourceDigest: sourceDigest,
      source
    })

    const artifacts = resolve(testRoot, 'pristine-artifacts')

    await captureWorkspaceArtifacts({
      artifacts,
      baseCommit: materialized.baseCommit,
      expectedSourceDigest: sourceDigest,
      source,
      workspace: materialized.workspace
    })

    await expect(
      verifyWorkspaceArtifacts({
        artifacts,
        destination: resolve(testRoot, 'pristine-replay'),
        expectedBaseCommit: materialized.baseCommit,
        expectedSourceDigest: sourceDigest,
        source
      })
    ).resolves.toMatchObject({ base_commit: materialized.baseCommit })
  })

  it.each([
    ['missing artifact', async (artifacts: string) => rm(resolve(artifacts, 'workspace.patch'))],
    ['extra artifact', async (artifacts: string) => writeFile(resolve(artifacts, 'extra'), '')],
    [
      'wrong hash',
      async (artifacts: string) => writeFile(resolve(artifacts, 'workspace.patch'), 'changed')
    ]
  ])('rejects a %s', async (_name, mutate) => {
    const fixture = await captureFixture()

    await mutate(fixture.artifacts)

    await expect(
      verifyWorkspaceArtifacts({
        artifacts: fixture.artifacts,
        destination: resolve(testRoot, 'replay'),
        expectedBaseCommit: fixture.baseCommit,
        expectedSourceDigest: fixture.sourceDigest,
        source: fixture.source
      })
    ).rejects.toThrow()
  })

  it.each([
    {
      name: 'empty',
      unsafePath: ''
    },
    {
      name: 'absolute',
      unsafePath: '/absolute.ts'
    },
    {
      name: 'backslash',
      unsafePath: 'src\\escape.ts'
    },
    {
      name: 'empty segment',
      unsafePath: 'src//escape.ts'
    },
    {
      name: 'dot segment',
      unsafePath: 'src/./escape.ts'
    },
    {
      name: 'traversal',
      unsafePath: '../escape.ts'
    },
    {
      name: 'nested traversal',
      unsafePath: 'src/../escape.ts'
    },
    ...UNSAFE_WORKSPACE_ROOTS.map((root) => ({
      name: `reserved ${root}`,
      unsafePath: `${root}/hidden.ts`
    }))
  ])('rejects a $name patch path', async ({ unsafePath }) => {
    const fixture = await captureFixture()
    const patchPath = resolve(fixture.artifacts, 'workspace.patch')
    const metadataPath = resolve(fixture.artifacts, 'workspace-metadata.json')
    const original = await readFile(patchPath, 'utf8')
    const mutated = original.replaceAll('src/added.ts', unsafePath)

    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      patch: { digest: string; size: number };
    }

    metadata.patch = {
      digest: sha256(mutated),
      size: Buffer.byteLength(mutated)
    }

    await writeFile(patchPath, mutated)
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)

    await expect(
      verifyWorkspaceArtifacts({
        artifacts: fixture.artifacts,
        destination: resolve(testRoot, 'replay'),
        expectedBaseCommit: fixture.baseCommit,
        expectedSourceDigest: fixture.sourceDigest,
        source: fixture.source
      })
    ).rejects.toThrow('unsafe path')
  })

  it('rejects symlinks in both workspaces and artifact directories', async () => {
    const source = resolve(testRoot, 'source')
    const sourceDigest = await createSource(source)

    const materialized = await materializeTaskWorkspace({
      destination: resolve(testRoot, 'workspace'),
      expectedSourceDigest: sourceDigest,
      source
    })

    await symlink('main.ts', resolve(materialized.workspace, 'src', 'link.ts'))

    await expect(
      captureWorkspaceArtifacts({
        artifacts: resolve(testRoot, 'artifacts'),
        baseCommit: materialized.baseCommit,
        expectedSourceDigest: sourceDigest,
        source,
        workspace: materialized.workspace
      })
    ).rejects.toThrow('symbolic links')

    await rm(resolve(materialized.workspace, 'src', 'link.ts'))

    const fixture = await captureFixture()
    const copiedArtifacts = resolve(testRoot, 'copied-artifacts')

    await cp(fixture.artifacts, copiedArtifacts, { recursive: true })
    await rm(resolve(copiedArtifacts, 'workspace.patch'))

    await symlink(
      resolve(fixture.artifacts, 'workspace.patch'),
      resolve(copiedArtifacts, 'workspace.patch')
    )

    await expect(
      verifyWorkspaceArtifacts({
        artifacts: copiedArtifacts,
        destination: resolve(testRoot, 'replay'),
        expectedBaseCommit: fixture.baseCommit,
        expectedSourceDigest: fixture.sourceDigest,
        source: fixture.source
      })
    ).rejects.toThrow('regular file')
  })

  it.each(UNSAFE_WORKSPACE_ROOTS)('rejects a rename-only patch into a reserved %s root', async (reserved) => {
    const source = resolve(testRoot, 'rename-source')
    const sourceDigest = await createSource(source)

    const materialized = await materializeTaskWorkspace({
      destination: resolve(testRoot, 'rename-workspace'),
      expectedSourceDigest: sourceDigest,
      source
    })

    await mkdir(resolve(materialized.workspace, reserved))

    await rename(
      resolve(materialized.workspace, 'src', 'main.ts'),
      resolve(materialized.workspace, reserved, 'hidden.ts')
    )

    const artifacts = resolve(testRoot, 'rename-artifacts')

    await captureWorkspaceArtifacts({
      artifacts,
      baseCommit: materialized.baseCommit,
      expectedSourceDigest: sourceDigest,
      source,
      workspace: materialized.workspace
    })

    await expect(
      verifyWorkspaceArtifacts({
        artifacts,
        destination: resolve(testRoot, 'rename-replay'),
        expectedBaseCommit: materialized.baseCommit,
        expectedSourceDigest: sourceDigest,
        source
      })
    ).rejects.toThrow('unsafe path')
  })
})
