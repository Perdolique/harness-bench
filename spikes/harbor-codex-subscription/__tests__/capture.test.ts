import { execFileSync } from 'node:child_process'
import { chmod, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTrustedCapture, scanWorkspace, type TreeManifest } from '../capture.ts'

const temporaryRoots: string[] = []

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-bench-capture-test-'))

  temporaryRoots.push(root)

  return root
}

function runGit(repository: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',

    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: repository,
      PATH: process.env.PATH
    }
  })
}

async function createTrustedBase(root: string): Promise<string> {
  const base = join(root, 'base')

  await mkdir(join(base, 'src'), { recursive: true })
  await mkdir(join(base, 'test'), { recursive: true })
  await writeFile(join(base, 'src', 'tracked.txt'), 'original\n', 'utf8')
  await writeFile(join(base, 'src', 'deleted.txt'), 'delete me\n', 'utf8')
  await writeFile(join(base, 'test', 'regression.txt'), 'stable\n', 'utf8')
  runGit(base, ['init', '--quiet'])
  runGit(base, ['config', 'user.email', 'spike@example.invalid'])
  runGit(base, ['config', 'user.name', 'Spike Fixture'])
  runGit(base, ['add', '--all'])
  runGit(base, ['commit', '--quiet', '-m', 'fixture: initialize base'])

  return base
}

async function applyCapture(
  base: string,
  patchPath: string,
  destination: string
): Promise<TreeManifest> {
  await cp(base, destination, {
    recursive: true,
    verbatimSymlinks: true
  })

  runGit(destination, ['apply', '--binary', patchPath])

  return scanWorkspace(destination)
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await chmod(root, 0o700).catch(() => {})

      await rm(root, {
        force: true,
        recursive: true
      })
    })
  )
})

describe(createTrustedCapture, () => {
  it('captures tracked, untracked, binary, mode, deletion, and safe symlink changes', async () => {
    const root = await createTemporaryRoot()
    const base = await createTrustedBase(root)
    const workspace = join(root, 'workspace')
    const evidence = join(root, 'evidence')

    await cp(base, workspace, {
      recursive: true,
      verbatimSymlinks: true
    })

    await writeFile(join(workspace, 'src', 'tracked.txt'), 'changed\n', 'utf8')
    await rm(join(workspace, 'src', 'deleted.txt'))
    await writeFile(join(workspace, 'new.txt'), 'untracked\n', 'utf8')
    await writeFile(join(workspace, 'binary.bin'), Buffer.from([0, 1, 2, 255]))
    await chmod(join(workspace, 'test', 'regression.txt'), 0o755)
    await symlink('src/tracked.txt', join(workspace, 'safe-link'))

    await writeFile(
      join(workspace, '.git', 'config'),
      '[core]\nrepositoryformatversion = 999\n',
      'utf8'
    )

    const capturedManifest = await createTrustedCapture({
      outputPath: evidence,
      stableDelayMs: 0,
      trustedBasePath: base,
      workspacePath: workspace
    })

    const appliedManifest = await applyCapture(
      base,
      join(evidence, 'change.patch'),
      join(root, 'applied')
    )

    expect(appliedManifest).toStrictEqual(capturedManifest)

    expect(capturedManifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'binary.bin',
          type: 'file'
        }),
        expect.objectContaining({
          mode: '100755',
          path: 'test/regression.txt'
        }),
        expect.objectContaining({
          path: 'safe-link',
          type: 'symlink'
        })
      ])
    )

    expect(capturedManifest.entries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '.git/config' })
      ])
    )

    expect(await readFile(join(evidence, 'change.patch'), 'utf8')).toContain(
      'GIT binary patch'
    )
  })

  it('rejects a symlink that escapes the workspace', async () => {
    const root = await createTemporaryRoot()
    const base = await createTrustedBase(root)
    const workspace = join(root, 'workspace')

    await cp(base, workspace, {
      recursive: true,
      verbatimSymlinks: true
    })

    await symlink('../../outside', join(workspace, 'unsafe-link'))

    await expect(
      createTrustedCapture({
        outputPath: join(root, 'evidence'),
        stableDelayMs: 0,
        trustedBasePath: base,
        workspacePath: workspace
      })
    ).rejects.toThrow('escapes the workspace')
  })

  it('rejects special files', async () => {
    const root = await createTemporaryRoot()
    const base = await createTrustedBase(root)
    const workspace = join(root, 'workspace')

    await cp(base, workspace, {
      recursive: true,
      verbatimSymlinks: true
    })

    execFileSync('mkfifo', [join(workspace, 'agent.fifo')])

    await expect(scanWorkspace(workspace)).rejects.toThrow(
      'Unsupported workspace entry type'
    )
  })

  it('rejects a workspace that changes during capture', async () => {
    const root = await createTemporaryRoot()
    const base = await createTrustedBase(root)
    const workspace = join(root, 'workspace')

    await cp(base, workspace, {
      recursive: true,
      verbatimSymlinks: true
    })

    await expect(
      createTrustedCapture({
        beforeSecondScan: async () => {
          await writeFile(join(workspace, 'late.txt'), 'late write\n', 'utf8')
        },

        outputPath: join(root, 'evidence'),
        stableDelayMs: 0,
        trustedBasePath: base,
        workspacePath: workspace
      })
    ).rejects.toThrow('changed during the stability window')
  })

  it('enforces path and byte limits', async () => {
    const root = await createTemporaryRoot()
    const base = await createTrustedBase(root)
    const workspace = join(root, 'workspace')

    await cp(base, workspace, {
      recursive: true,
      verbatimSymlinks: true
    })

    await expect(
      scanWorkspace(workspace, {
        maximumBytes: 1,
        maximumPaths: 100
      })
    ).rejects.toThrow('Workspace exceeds 1 bytes')

    await expect(
      scanWorkspace(workspace, {
        maximumBytes: 1_000,
        maximumPaths: 1
      })
    ).rejects.toThrow('Workspace exceeds 1 paths')
  })
})
