import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { disposeTaskImport } from '@harness-bench/core'
import { runCli, type CliIo } from '../src/cli.ts'

let testRoot: string

function git(repository: string, arguments_: readonly string[]): string {
  return execFileSync('git', arguments_, {
    cwd: repository,
    encoding: 'utf8',

    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '0',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1'
    }
  }).trim()
}

function createIo(): {
  readonly io: CliIo;
  readonly stderr: string[];
  readonly stdout: string[];
} {
  const stderr: string[] = []
  const stdout: string[] = []

  return {
    io: {
      stderr: (value) => stderr.push(value),
      stdout: (value) => stdout.push(value)
    },

    stderr,
    stdout
  }
}

async function makeWritable(path: string): Promise<void> {
  const metadata = await lstat(path).catch(() => undefined)

  if (metadata === undefined || metadata.isSymbolicLink()) return

  if (metadata.isDirectory()) {
    await chmod(path, 0o700)

    for (const entry of await readdir(path)) await makeWritable(resolve(path, entry))
  } else {
    await chmod(path, 0o600)
  }
}

async function makeDefinition(
  classification: 'public' | 'private',
  source = 'export const value = 1\n'
): Promise<string> {
  const repository = resolve(testRoot, `repository-${classification}`)

  await mkdir(repository)
  git(repository, ['init', '--quiet', '--initial-branch=main'])
  await writeFile(resolve(repository, 'main.ts'), source)
  git(repository, ['add', '--all'])

  git(repository, [
    '-c', 'user.name=Test',
    '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'base'
  ])

  const baseCommit = git(repository, ['rev-parse', 'HEAD'])
  const path = resolve(testRoot, `${classification}.json`)

  await writeFile(path, `${JSON.stringify({
    document_type: 'task_import_definition',
    schema_version: 1,
    task_id: `cli-${classification}`,
    task_revision: 'v1',
    repository_path: repository,
    base_commit: baseCommit,

    provenance: {
      repository_id: `opaque-${classification}`,
      merged_pull_request: { status: 'not_applicable' }
    },

    online_reachability: {
      status: 'eligible',
      reason: 'No grading material is reachable from the public source.'
    },

    retention: classification === 'public'
      ? { classification: 'public' }
      : {
          classification: 'private',

          expires_at: {
            status: 'known',
            value: '2099-01-01T00:00:00.000Z'
          }
        }
  }, null, 2)}\n`)

  return path
}

beforeEach(async () => {
  testRoot = await mkdtemp('/tmp/harness-bench-task-cli-test-')
})

afterEach(async () => {
  await makeWritable(testRoot)

  await rm(testRoot, {
    force: true,
    recursive: true
  })
})

describe('task CLI', () => {
  it('imports, validates, and materializes with stable safe JSON', async () => {
    const definition = await makeDefinition('public')
    const importedIo = createIo()

    const exit = await runCli([
      'task',
      'import',
      definition,
      '--store',
      resolve(testRoot, 'store')
    ], importedIo.io)

    const imported = JSON.parse(importedIo.stdout.join('')) as Record<string, string>

    expect(exit).toBe(0)
    expect(importedIo.stderr).toEqual([])

    expect(imported).toStrictEqual({
      status: 'imported',
      import_path: expect.stringMatching(/\/[a-f0-9]{64}$/),
      import_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      source_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      materialized_base_commit: expect.stringMatching(/^[a-f0-9]{40}$/),
      task_id: 'cli-public',
      task_revision: 'v1'
    })

    expect(importedIo.stdout.join('')).not.toContain('example.invalid')
    expect(importedIo.stdout.join('')).not.toContain('repository-public')

    const validatedIo = createIo()

    expect(await runCli(['task', 'validate', imported.import_path!], validatedIo.io)).toBe(0)

    expect(JSON.parse(validatedIo.stdout.join(''))).toStrictEqual({
      status: 'active',
      import_path: imported.import_path,
      import_digest: imported.import_digest,
      source_digest: imported.source_digest,
      materialized_base_commit: imported.materialized_base_commit,
      task_id: imported.task_id,
      task_revision: imported.task_revision
    })

    const materializedIo = createIo()
    const destination = resolve(testRoot, 'workspace')

    expect(await runCli([
      'task',
      'materialize',
      imported.import_path!,
      '--destination',
      destination
    ], materializedIo.io)).toBe(0)

    expect(JSON.parse(materializedIo.stdout.join(''))).toStrictEqual({
      status: 'materialized',
      import_digest: imported.import_digest,
      source_digest: imported.source_digest,
      base_commit: imported.materialized_base_commit,
      workspace: destination
    })

    expect(await readFile(resolve(destination, 'main.ts'), 'utf8')).toContain('value = 1')
  }, 20_000)

  it('disposes a private import and validates its tombstone', async () => {
    const definition = await makeDefinition('private')
    const importedIo = createIo()

    expect(await runCli([
      'task', 'import', definition, '--store', resolve(testRoot, 'private-store')
    ], importedIo.io)).toBe(0)

    const imported = JSON.parse(importedIo.stdout.join('')) as Record<string, string>
    const disposedIo = createIo()

    expect(await runCli([
      'task',
      'dispose',
      imported.import_path!,
      '--confirm-import-digest',
      imported.import_digest!,
      '--reason',
      'owner-request'
    ], disposedIo.io)).toBe(0)

    const disposed = JSON.parse(disposedIo.stdout.join('')) as Record<string, string>

    expect(disposed).toStrictEqual({
      status: 'disposed',
      import_path: imported.import_path,
      import_digest: imported.import_digest,
      source_digest: imported.source_digest,
      tombstone_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      task_id: imported.task_id,
      task_revision: imported.task_revision
    })

    const validatedIo = createIo()

    expect(await runCli(['task', 'validate', imported.import_path!], validatedIo.io)).toBe(0)

    expect(JSON.parse(validatedIo.stdout.join(''))).toStrictEqual({
      status: 'disposed',
      import_path: imported.import_path,
      import_digest: imported.import_digest,
      source_digest: imported.source_digest,
      tombstone_digest: disposed.tombstone_digest,
      task_id: imported.task_id,
      task_revision: imported.task_revision
    })
  }, 20_000)

  it('uses exit 2 for every malformed task command without starting an operation', async () => {
    const path = resolve(testRoot, 'candidate')
    const digest = `sha256:${'a'.repeat(64)}`

    const malformed = [
      ['task', 'import'],
      ['task', 'import', path],
      ['task', 'import', path, 'extra', '--store', resolve(testRoot, 'store')],
      ['task', 'import', path, '--store', resolve(testRoot, 'store'), '--unknown'],
      ['task', 'validate'],
      ['task', 'validate', path, 'extra'],
      ['task', 'validate', path, '--unknown'],
      ['task', 'materialize', path],
      ['task', 'materialize', path, 'extra', '--destination', resolve(testRoot, 'workspace')],
      ['task', 'dispose', path, '--reason', 'owner-request'],
      ['task', 'dispose', path, '--confirm-import-digest', digest],
      [
        'task', 'dispose', path, '--confirm-import-digest', digest,
        '--reason', 'owner-request', '--credential-action', 'revoked'
      ],
      ['task', 'recover', path],
      ['task', 'recover', path, 'extra', '--confirm-import-digest', digest]
    ]

    for (const arguments_ of malformed) {
      const output = createIo()

      expect(await runCli(arguments_, output.io)).toBe(2)
      expect(output.stdout).toEqual([])
      expect(output.stderr.join('')).toContain('USAGE_ERROR')
    }

    await expect(lstat(resolve(testRoot, 'store'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(resolve(testRoot, 'workspace'))).rejects.toMatchObject({ code: 'ENOENT' })

    const missingImport = createIo()

    expect(await runCli([
      'task', 'validate', resolve(testRoot, '0'.repeat(64))
    ], missingImport.io)).toBe(2)

    expect(missingImport.stdout).toEqual([])

    expect(missingImport.stderr).toStrictEqual([
      'INVALID_IMPORT: Task import is unavailable\n'
    ])

    expect(missingImport.stderr.join('')).not.toContain(testRoot)
  })

  it('prints a fixed safe error for credential rejection', async () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'
    const definition = await makeDefinition('public', `export const token = '${token}'\n`)
    const output = createIo()
    const store = resolve(testRoot, 'credential-store')

    expect(await runCli([
      'task', 'import', definition, '--store', store
    ], output.io)).toBe(2)

    expect(output.stdout).toEqual([])

    expect(output.stderr).toStrictEqual([
      'CREDENTIAL_DETECTED: Git tree contains credential-like bytes\n'
    ])

    expect(output.stderr.join('')).not.toContain(token)
    expect(output.stderr.join('')).not.toContain(testRoot)
    expect(output.stderr.join('')).not.toContain('example.invalid')
    expect(await readdir(store)).toEqual([])
  })

  it('recovers a sealed post-delete tombstone through the public CLI', async () => {
    const definition = await makeDefinition('private')
    const importedIo = createIo()

    expect(await runCli([
      'task', 'import', definition, '--store', resolve(testRoot, 'recovery-store')
    ], importedIo.io)).toBe(0)

    const imported = JSON.parse(importedIo.stdout.join('')) as Record<string, string>

    await expect(disposeTaskImport(imported.import_path!, {
      confirmImportDigest: imported.import_digest!,
      reason: 'owner-request',

      testHooks: {
        afterDelete: () => { throw new Error('injected post-delete failure') }
      }
    })).rejects.toMatchObject({ code: 'INVALID_LIFECYCLE' })

    const recoveredIo = createIo()

    expect(await runCli([
      'task',
      'recover',
      imported.import_path!,
      '--confirm-import-digest',
      imported.import_digest!
    ], recoveredIo.io)).toBe(0)

    expect(JSON.parse(recoveredIo.stdout.join(''))).toStrictEqual({
      status: 'recovered',
      kind: 'disposed',
      import_path: imported.import_path,
      import_digest: imported.import_digest,
      source_digest: imported.source_digest,
      tombstone_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      task_id: imported.task_id,
      task_revision: imported.task_revision
    })

    expect(recoveredIo.stderr).toEqual([])
  }, 20_000)
})
