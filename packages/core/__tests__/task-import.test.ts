import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  disposeTaskImport,
  importTaskSource,
  inspectMaterializedTaskWorkspace,
  materializeTaskImport,
  recoverTaskImportDisposal,
  validateTaskImport,
  type TaskImportDefinitionV1
} from '../src/index.ts'

const fixedNow = () => new Date('2026-01-01T00:00:00.000Z')
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

function gitInput(repository: string, arguments_: readonly string[], input: string): string {
  return execFileSync('git', arguments_, {
    cwd: repository,
    encoding: 'utf8',
    input,

    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      GIT_CONFIG_COUNT: '0',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1'
    }
  }).trim()
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

async function createRepository(name = 'repository'): Promise<{
  readonly baseCommit: string;
  readonly futureCommit: string;
  readonly path: string;
}> {
  const path = resolve(testRoot, name)

  await mkdir(resolve(path, 'src'), { recursive: true })
  git(path, ['init', '--quiet', '--initial-branch=main'])
  await writeFile(resolve(path, 'package.json'), '{"private":true}\n')
  await writeFile(resolve(path, 'src/main.ts'), 'export const answer = 42\n')
  await writeFile(resolve(path, 'run.sh'), '#!/bin/sh\necho ready\n')
  await chmod(resolve(path, 'run.sh'), 0o755)
  git(path, ['add', '--all'])

  git(path, [
    '-c', 'user.name=Test',
    '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'base'
  ])

  const baseCommit = git(path, ['rev-parse', 'HEAD'])

  await writeFile(resolve(path, 'solution.txt'), 'FUTURE_SOLUTION_SENTINEL\n')
  git(path, ['add', '--all'])

  git(path, [
    '-c', 'user.name=Test',
    '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'future'
  ])

  const futureCommit = git(path, ['rev-parse', 'HEAD'])

  await writeFile(resolve(path, 'dirty.txt'), 'DIRTY_SENTINEL\n')
  git(path, ['remote', 'add', 'origin', 'https://user:password@example.invalid/private.git'])
  await writeFile(resolve(path, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 99\n')
  await chmod(resolve(path, '.git/hooks/pre-commit'), 0o755)

  const alternateObjects = resolve(testRoot, `${name}-alternate-objects`)

  await mkdir(alternateObjects)
  await mkdir(resolve(path, '.git/objects/info'), { recursive: true })
  await writeFile(resolve(path, '.git/objects/info/alternates'), `${alternateObjects}\n`)

  return {
    baseCommit,
    futureCommit,
    path
  }
}

function definition(
  repositoryPath: string,
  baseCommit: string,
  retention: TaskImportDefinitionV1['retention'] = { classification: 'public' }
): TaskImportDefinitionV1 {
  return {
    document_type: 'task_import_definition',
    schema_version: 1,
    task_id: 'real-task',
    task_revision: 'v1',
    repository_path: repositoryPath,
    base_commit: baseCommit,

    provenance: {
      repository_id: 'opaque-repository-1',
      merged_pull_request: { status: 'not_applicable' }
    },

    online_reachability: {
      status: 'ineligible',
      reason: 'Future solution history remains reachable online.'
    },

    retention
  }
}

async function writeDefinition(value: unknown, name = 'definition.json'): Promise<string> {
  const path = resolve(testRoot, name)

  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)

  return path
}

async function importFixture(
  retention: TaskImportDefinitionV1['retention'] = { classification: 'public' },
  storeName = 'store'
) {
  const repository = await createRepository(`repository-${storeName}`)

  const definitionPath = await writeDefinition(
    definition(repository.path, repository.baseCommit, retention),
    `${storeName}.json`
  )

  return {
    repository,

    result: await importTaskSource({
      definition: definitionPath,
      now: fixedNow,
      store: resolve(testRoot, storeName)
    })
  }
}

beforeEach(async () => {
  testRoot = await mkdtemp('/tmp/harness-bench-task-import-test-')
})

afterEach(async () => {
  await makeWritable(testRoot)

  await rm(testRoot, {
    force: true,
    recursive: true
  })
})

describe('task source import', () => {
  it('imports shared filename prefixes in the source walker order', async () => {
    const repository = resolve(testRoot, 'prefix-repository')

    const paths = [
      'src/widget.ts',
      'src/widget-view.ts',
      'src/widget/view.ts',
      'src/widget/view-extra.ts',
      'src/widget/view/part.ts'
    ]

    for (const path of paths) {
      const target = resolve(repository, path)

      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, `// Fixture: ${path}\n`)
    }

    git(repository, ['init', '--quiet', '--initial-branch=main'])
    git(repository, ['add', '--all'])
    git(repository, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'base'])

    const baseCommit = git(repository, ['rev-parse', 'HEAD'])
    const definitionPath = await writeDefinition(definition(repository, baseCommit))

    const imported = await importTaskSource({
      definition: definitionPath,
      now: fixedNow,
      store: resolve(testRoot, 'prefix-store')
    })

    expect(imported.manifest.inventory.map((entry) => entry.path)).toEqual([
      'src/widget/view/part.ts',
      'src/widget/view-extra.ts',
      'src/widget/view.ts',
      'src/widget-view.ts',
      'src/widget.ts'
    ])

    const materialized = await materializeTaskImport({
      importPath: imported.importPath,
      destination: resolve(testRoot, 'prefix-workspace')
    })

    expect(materialized.sourceDigest).toBe(imported.manifest.source_digest)

    for (const path of paths) {
      expect(await readFile(resolve(materialized.workspace, path), 'utf8')).toBe(`// Fixture: ${path}\n`)
    }
  })

  it('freezes only the selected commit and creates deterministic isolated materialization', async () => {
    const first = await importFixture()
    const source = resolve(first.result.importPath, 'source')

    expect(await readFile(resolve(source, 'src/main.ts'), 'utf8')).toContain('answer = 42')
    expect((await lstat(resolve(source, 'run.sh'))).mode & 0o777).toBe(0o500)
    expect((await lstat(dirname(first.result.importPath))).mode & 0o777).toBe(0o700)
    await expect(readFile(resolve(source, 'solution.txt'))).rejects.toThrow()
    await expect(readFile(resolve(source, 'dirty.txt'))).rejects.toThrow()

    const materialized = await materializeTaskImport({
      destination: resolve(testRoot, 'workspace'),
      importPath: first.result.importPath
    })

    const inspection = await inspectMaterializedTaskWorkspace(materialized.workspace)

    expect(materialized.baseCommit).toBe(first.result.manifest.materialized_base_commit)
    expect((await lstat(resolve(materialized.workspace, 'run.sh'))).mode & 0o777).toBe(0o755)

    expect(inspection).toEqual({
      alternates: [],
      baseCommit: materialized.baseCommit,
      commitCount: 1,
      hooks: [],
      refs: ['refs/heads/main'],
      remotes: [],
      status: '',
      unreachable: ''
    })

    const secondDefinition = await writeDefinition(
      definition(first.repository.path, first.repository.baseCommit),
      'repeat.json'
    )

    const repeated = await importTaskSource({
      definition: secondDefinition,
      now: fixedNow,
      store: resolve(testRoot, 'repeat-store')
    })

    expect(repeated.manifest.import_digest).toBe(first.result.manifest.import_digest)
    expect(repeated.manifest.source_digest).toBe(first.result.manifest.source_digest)

    expect(repeated.manifest.materialized_base_commit).toBe(
      first.result.manifest.materialized_base_commit
    )

    expect(JSON.stringify(repeated.manifest)).not.toContain(first.repository.path)
    expect(JSON.stringify(repeated.manifest)).not.toContain('example.invalid')
  })

  it('normalizes private retention and rejects invalid definitions fail-closed', async () => {
    const imported = await importFixture({
      classification: 'private',
      expires_at: { status: 'default' }
    })

    expect(imported.result.manifest.retention).toEqual({
      classification: 'private',
      default_days: 90,
      expires_at: '2026-04-01T00:00:00.000Z'
    })

    const repository = await createRepository('invalid-definition-repository')
    const invalid = definition(repository.path, repository.baseCommit) as Record<string, unknown>

    invalid.online_reachability = {
      status: 'unknown',
      reason: 'Not assessed.'
    }

    await expect(importTaskSource({
      definition: await writeDefinition(invalid, 'invalid.json'),
      now: fixedNow,
      store: resolve(testRoot, 'invalid-store')
    })).rejects.toMatchObject({ code: 'INVALID_DEFINITION' })

    const past = definition(repository.path, repository.baseCommit, {
      classification: 'private',

      expires_at: {
        status: 'known',
        value: '2025-12-31T00:00:00.000Z'
      }
    })

    await expect(importTaskSource({
      definition: await writeDefinition(past, 'past.json'),
      now: fixedNow,
      store: resolve(testRoot, 'past-store')
    })).rejects.toMatchObject({ code: 'INVALID_DEFINITION' })
  })

  it('rejects unsafe retained metadata and oversized definitions', async () => {
    const repository = await createRepository('unsafe-metadata-repository')
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'

    const unsafeDefinitions = [
      {
        name: 'revision-secret',

        value: {
          ...definition(repository.path, repository.baseCommit),
          task_revision: token
        }
      },
      {
        name: 'identifier-secret',

        value: {
          ...definition(repository.path, repository.baseCommit),
          task_id: token
        }
      },
      {
        name: 'reason-url',

        value: {
          ...definition(repository.path, repository.baseCommit),

          online_reachability: {
            status: 'ineligible' as const,
            reason: 'Future material remains at https://example.invalid/private.'
          }
        }
      },
      {
        name: 'reason-path',

        value: {
          ...definition(repository.path, repository.baseCommit),

          online_reachability: {
            status: 'ineligible' as const,
            reason: 'Reviewed from /Users/example/private/source.'
          }
        }
      }
    ]

    for (const candidate of unsafeDefinitions) {
      const store = resolve(testRoot, `${candidate.name}-store`)

      await expect(importTaskSource({
        definition: await writeDefinition(candidate.value, `${candidate.name}.json`),
        now: fixedNow,
        store
      })).rejects.toMatchObject({ code: 'INVALID_DEFINITION' })

      await expect(lstat(store)).rejects.toMatchObject({ code: 'ENOENT' })
    }

    const oversized = resolve(testRoot, 'oversized-definition.json')

    await writeFile(oversized, `{${' '.repeat(1024 * 1024)}}`)

    await expect(importTaskSource({
      definition: oversized,
      now: fixedNow,
      store: resolve(testRoot, 'oversized-store')
    })).rejects.toMatchObject({ code: 'INVALID_DEFINITION' })
  })

  it('keeps the external store restricted and outside the complete source worktree', async () => {
    const repository = await createRepository('store-location-repository')

    const nestedDefinition = definition(
      resolve(repository.path, 'src'),
      repository.baseCommit
    )

    await expect(importTaskSource({
      definition: await writeDefinition(nestedDefinition, 'nested-repository.json'),
      now: fixedNow,
      store: resolve(repository.path, 'task-imports')
    })).rejects.toMatchObject({ code: 'INVALID_DEFINITION' })

    const realStore = resolve(testRoot, 'real-store')
    const linkedStore = resolve(testRoot, 'linked-store')

    await mkdir(realStore)
    await symlink(realStore, linkedStore)

    await expect(importTaskSource({
      definition: await writeDefinition(
        definition(repository.path, repository.baseCommit),
        'linked-store.json'
      ),

      now: fixedNow,
      store: linkedStore
    })).rejects.toMatchObject({ code: 'INVALID_DEFINITION' })

    const restrictedStore = resolve(testRoot, 'restricted-store')

    await mkdir(restrictedStore, { mode: 0o777 })
    await chmod(restrictedStore, 0o777)

    await importTaskSource({
      definition: await writeDefinition(
        definition(repository.path, repository.baseCommit),
        'restricted-store.json'
      ),

      now: fixedNow,
      store: restrictedStore
    })

    expect((await lstat(restrictedStore)).mode & 0o777).toBe(0o700)
  })

  it('rejects unsupported entries, colliding paths, ignored paths, and invalid commits', async () => {
    for (const [name, mutate] of [
      ['symlink', async (path: string) => symlink('package.json', resolve(path, 'link'))],
      ['ignored', async (path: string) => writeFile(resolve(path, '.DS_Store'), 'tracked')],
      ['secret-name', async (path: string) => writeFile(resolve(path, '.npmrc'), 'harmless')],
      ['lfs', async (path: string) => writeFile(
        resolve(path, 'large.bin'),
        `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 10\n`
      )]
    ] as const) {
      const repository = await createRepository(`bad-${name}`)

      await mutate(repository.path)
      git(repository.path, ['add', '--all'])

      git(repository.path, [
        '-c', 'user.name=Test',
        '-c', 'user.email=test@example.invalid',
        'commit', '--quiet', '--no-verify', '-m', name
      ])

      const commit = git(repository.path, ['rev-parse', 'HEAD'])

      await expect(importTaskSource({
        definition: await writeDefinition(definition(repository.path, commit), `${name}.json`),
        now: fixedNow,
        store: resolve(testRoot, `${name}-store`)
      })).rejects.toMatchObject({ code: 'INELIGIBLE_SOURCE' })
    }

    const collision = await createRepository('bad-collision')
    const firstBlob = gitInput(collision.path, ['hash-object', '-w', '--stdin'], 'a')
    const secondBlob = gitInput(collision.path, ['hash-object', '-w', '--stdin'], 'b')

    const tree = gitInput(
      collision.path,
      ['mktree'],
      `100644 blob ${firstBlob}\tREADME\n100644 blob ${secondBlob}\treadme\n`
    )

    const collisionCommit = gitInput(collision.path, ['commit-tree', tree], 'collision\n')

    await expect(importTaskSource({
      definition: await writeDefinition(
        definition(collision.path, collisionCommit),
        'collision.json'
      ),

      now: fixedNow,
      store: resolve(testRoot, 'collision-store')
    })).rejects.toMatchObject({ code: 'INELIGIBLE_SOURCE' })

    const submoduleTree = gitInput(
      collision.path,
      ['mktree'],
      `160000 commit ${collision.baseCommit}\tvendor\n`
    )

    const submoduleCommit = gitInput(
      collision.path,
      ['commit-tree', submoduleTree],
      'submodule\n'
    )

    await expect(importTaskSource({
      definition: await writeDefinition(
        definition(collision.path, submoduleCommit),
        'submodule.json'
      ),

      now: fixedNow,
      store: resolve(testRoot, 'submodule-store')
    })).rejects.toMatchObject({ code: 'INELIGIBLE_SOURCE' })

    const repository = await createRepository('invalid-commit')

    await expect(importTaskSource({
      definition: await writeDefinition(
        definition(repository.path, '0'.repeat(40)),
        'invalid-commit.json'
      ),

      now: fixedNow,
      store: resolve(testRoot, 'invalid-commit-store')
    })).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' })
  })

  it('rejects credential bytes before finalization', async () => {
    const repository = await createRepository('credential-repository')

    await writeFile(
      resolve(repository.path, 'provider.txt'),
      `token=${'ghp_abcdefghijklmnopqrstuvwxyz1234567890'}\n`
    )

    git(repository.path, ['add', '--all'])

    git(repository.path, [
      '-c', 'user.name=Test',
      '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '--no-verify', '-m', 'credential sentinel'
    ])

    await expect(importTaskSource({
      definition: await writeDefinition(
        definition(repository.path, git(repository.path, ['rev-parse', 'HEAD'])),
        'credential.json'
      ),

      now: fixedNow,
      store: resolve(testRoot, 'credential-store')
    })).rejects.toMatchObject({ code: 'CREDENTIAL_DETECTED' })

    expect(await readdir(resolve(testRoot, 'credential-store'))).toEqual([])
  })

  it('checks known merged PR ancestry', async () => {
    const repository = await createRepository('pr-repository')
    const valid = definition(repository.path, repository.baseCommit)

    valid.provenance.merged_pull_request = {
      status: 'known',
      number: 12,
      merge_commit: repository.futureCommit
    }

    await expect(importTaskSource({
      definition: await writeDefinition(valid, 'valid-pr.json'),
      now: fixedNow,
      store: resolve(testRoot, 'valid-pr-store')
    })).resolves.toBeDefined()

    const invalid = definition(repository.path, repository.futureCommit)

    invalid.provenance.merged_pull_request = {
      status: 'known',
      number: 13,
      merge_commit: repository.baseCommit
    }

    await expect(importTaskSource({
      definition: await writeDefinition(invalid, 'invalid-pr.json'),
      now: fixedNow,
      store: resolve(testRoot, 'invalid-pr-store')
    })).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' })
  })

  it('rejects source, mode, manifest, and address tampering', async () => {
    const imported = await importFixture()
    const sourcePath = resolve(imported.result.importPath, 'source/src/main.ts')
    const manifestPath = resolve(imported.result.importPath, 'manifest.json')
    const originalManifest = await readFile(manifestPath, 'utf8')

    await chmod(sourcePath, 0o600)
    await writeFile(sourcePath, 'export const answer = 7\n')
    await chmod(sourcePath, 0o400)

    await expect(validateTaskImport(imported.result.importPath)).rejects.toMatchObject({
      code: 'INVALID_IMPORT'
    })

    await chmod(sourcePath, 0o600)
    await writeFile(sourcePath, 'export const answer = 42\n')

    await expect(validateTaskImport(imported.result.importPath)).rejects.toMatchObject({
      code: 'INVALID_IMPORT'
    })

    await chmod(sourcePath, 0o400)
    await chmod(manifestPath, 0o600)

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>

    manifest.task_revision = 'tampered'

    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
    await chmod(manifestPath, 0o400)

    await expect(validateTaskImport(imported.result.importPath)).rejects.toMatchObject({
      code: 'INVALID_IMPORT'
    })

    await chmod(manifestPath, 0o600)
    await writeFile(manifestPath, originalManifest)
    await chmod(manifestPath, 0o400)

    const source = resolve(imported.result.importPath, 'source')

    await chmod(source, 0o700)
    await mkdir(resolve(source, 'empty-extra'), { mode: 0o500 })
    await chmod(source, 0o500)

    await expect(validateTaskImport(imported.result.importPath)).rejects.toMatchObject({
      code: 'INVALID_IMPORT'
    })

    await chmod(source, 0o700)
    await rm(resolve(source, 'empty-extra'), { recursive: true })
    await writeFile(resolve(source, 'extra.tsbuildinfo'), 'harmless', { mode: 0o400 })
    await chmod(source, 0o500)

    await expect(validateTaskImport(imported.result.importPath)).rejects.toMatchObject({
      code: 'INVALID_IMPORT'
    })

    await chmod(source, 0o700)
    await rm(resolve(source, 'extra.tsbuildinfo'))
    await chmod(source, 0o500)

    const wrongAddress = resolve(dirname(imported.result.importPath), '0'.repeat(64))

    await rename(imported.result.importPath, wrongAddress)

    await expect(validateTaskImport(wrongAddress)).rejects.toMatchObject({
      code: 'INVALID_IMPORT'
    })
  })

  it('rejects permissive modes for every managed active-import layer', async () => {
    const cases = [
      {
        name: 'import-root',
        target: (importPath: string) => importPath,
        mode: 0o700
      },
      {
        name: 'source-root',
        target: (importPath: string) => resolve(importPath, 'source'),
        mode: 0o700
      },
      {
        name: 'source-directory',
        target: (importPath: string) => resolve(importPath, 'source/src'),
        mode: 0o700
      },
      {
        name: 'manifest',
        target: (importPath: string) => resolve(importPath, 'manifest.json'),
        mode: 0o600
      }
    ]

    for (const candidate of cases) {
      const imported = await importFixture({ classification: 'public' }, candidate.name)

      await chmod(candidate.target(imported.result.importPath), candidate.mode)

      await expect(validateTaskImport(imported.result.importPath)).rejects.toMatchObject({
        code: 'INVALID_IMPORT'
      })
    }
  }, 20_000)
})

describe('private task import disposal', () => {
  const privateRetention: TaskImportDefinitionV1['retention'] = {
    classification: 'private',
    expires_at: { status: 'default' }
  }

  it('requires owner confirmation and leaves a redacted content-addressed tombstone', async () => {
    const imported = await importFixture(privateRetention)

    await expect(disposeTaskImport(imported.result.importPath, {
      confirmImportDigest: `sha256:${'0'.repeat(64)}`,
      reason: 'owner-request',
      now: fixedNow
    })).rejects.toMatchObject({ code: 'INVALID_LIFECYCLE' })

    const disposed = await disposeTaskImport(imported.result.importPath, {
      confirmImportDigest: imported.result.manifest.import_digest,
      reason: 'owner-request',
      now: fixedNow
    })

    const validated = await validateTaskImport(disposed.importPath)
    const serialized = JSON.stringify(validated)

    expect(validated.kind).toBe('tombstone')
    expect(serialized).not.toContain('FUTURE_SOLUTION_SENTINEL')
    expect(serialized).not.toContain(imported.repository.path)
    expect(serialized).not.toContain('example.invalid')
    expect(await readdir(disposed.importPath)).toHaveLength(1)

    await expect(materializeTaskImport({
      destination: resolve(testRoot, 'disposed-workspace'),
      importPath: disposed.importPath
    })).rejects.toMatchObject({ code: 'INVALID_LIFECYCLE' })

    const tombstoneDirectory = resolve(
      disposed.importPath,
      disposed.tombstone.tombstone_digest.slice('sha256:'.length)
    )

    const record = resolve(tombstoneDirectory, 'record.json')

    await chmod(record, 0o600)

    await expect(validateTaskImport(disposed.importPath)).rejects.toMatchObject({
      code: 'INVALID_IMPORT'
    })
  })

  it('rejects a FIFO tombstone record before attempting to read it', async () => {
    const imported = await importFixture(privateRetention, 'fifo-tombstone')

    const disposed = await disposeTaskImport(imported.result.importPath, {
      confirmImportDigest: imported.result.manifest.import_digest,
      reason: 'owner-request',
      now: fixedNow
    })

    const tombstoneDirectory = resolve(
      disposed.importPath,
      disposed.tombstone.tombstone_digest.slice('sha256:'.length)
    )

    const record = resolve(tombstoneDirectory, 'record.json')

    await chmod(tombstoneDirectory, 0o700)
    await rm(record)
    execFileSync('mkfifo', [record])
    await chmod(record, 0o400)
    await chmod(tombstoneDirectory, 0o500)

    await expect(validateTaskImport(disposed.importPath)).rejects.toMatchObject({
      code: 'INVALID_IMPORT'
    })
  })

  it('enforces expiry, credential action, and public retention', async () => {
    const early = await importFixture(privateRetention, 'early')

    await expect(disposeTaskImport(early.result.importPath, {
      confirmImportDigest: early.result.manifest.import_digest,
      reason: 'retention-expired',
      now: fixedNow
    })).rejects.toMatchObject({ code: 'INVALID_LIFECYCLE' })

    const expired = await importFixture(privateRetention, 'expired')

    await expect(disposeTaskImport(expired.result.importPath, {
      confirmImportDigest: expired.result.manifest.import_digest,
      reason: 'retention-expired',
      now: () => new Date('2026-04-01T00:00:00.000Z')
    })).resolves.toBeDefined()

    const credential = await importFixture(privateRetention, 'credential-disposal')
    const compromisedSource = resolve(credential.result.importPath, 'source/src/main.ts')

    await chmod(compromisedSource, 0o600)

    await writeFile(
      compromisedSource,
      `export const token = '${'ghp_abcdefghijklmnopqrstuvwxyz1234567890'}'\n`
    )

    await chmod(compromisedSource, 0o400)

    await expect(validateTaskImport(credential.result.importPath)).rejects.toMatchObject({
      code: 'INVALID_IMPORT'
    })

    await expect(disposeTaskImport(credential.result.importPath, {
      confirmImportDigest: credential.result.manifest.import_digest,
      reason: 'credential-detected',
      now: fixedNow
    })).rejects.toMatchObject({ code: 'INVALID_LIFECYCLE' })

    await expect(disposeTaskImport(credential.result.importPath, {
      confirmImportDigest: credential.result.manifest.import_digest,
      credentialAction: 'revoked',
      reason: 'credential-detected',
      now: fixedNow
    })).resolves.toBeDefined()

    const publicImport = await importFixture({ classification: 'public' }, 'public-disposal')

    await expect(disposeTaskImport(publicImport.result.importPath, {
      confirmImportDigest: publicImport.result.manifest.import_digest,
      reason: 'owner-request',
      now: fixedNow
    })).rejects.toMatchObject({ code: 'INVALID_LIFECYCLE' })
  }, 20_000)

  it('restores the active import after failures before source deletion', async () => {
    const before = await importFixture(privateRetention, 'before-failure')

    await expect(disposeTaskImport(before.result.importPath, {
      confirmImportDigest: before.result.manifest.import_digest,
      reason: 'owner-request',
      now: fixedNow,
      testHooks: { afterReservation: () => { throw new Error('before delete') } }
    })).rejects.toThrow('before delete')

    await expect(validateTaskImport(before.result.importPath)).resolves.toMatchObject({ kind: 'active' })

    const moved = await importFixture(privateRetention, 'moved-failure')

    await expect(disposeTaskImport(moved.result.importPath, {
      confirmImportDigest: moved.result.manifest.import_digest,
      reason: 'owner-request',
      now: fixedNow,
      testHooks: { afterMove: () => { throw new Error('after move') } }
    })).rejects.toMatchObject({ code: 'INVALID_LIFECYCLE' })

    await expect(validateTaskImport(moved.result.importPath)).resolves.toMatchObject({
      kind: 'active'
    })

    const address = basename(moved.result.importPath)
    const store = dirname(moved.result.importPath)

    await expect(lstat(resolve(store, `.task-import-${address}.lock`))).rejects.toMatchObject({
      code: 'ENOENT'
    })

    await expect(
      lstat(resolve(store, `.task-import-dispose-source-${address}`))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a sealed post-delete recovery and completes it explicitly', async () => {
    const after = await importFixture(privateRetention, 'after-failure')

    await expect(disposeTaskImport(after.result.importPath, {
      confirmImportDigest: after.result.manifest.import_digest,
      reason: 'owner-request',
      now: fixedNow,
      testHooks: { afterDelete: () => { throw new Error('after delete') } }
    })).rejects.toMatchObject({ code: 'INVALID_LIFECYCLE' })

    await expect(lstat(after.result.importPath)).rejects.toMatchObject({ code: 'ENOENT' })

    const address = basename(after.result.importPath)
    const store = dirname(after.result.importPath)
    const recovery = resolve(store, `.task-import-dispose-tombstone-${address}`)
    const reservation = resolve(store, `.task-import-${address}.lock`)

    expect((await lstat(recovery)).mode & 0o777).toBe(0o500)
    expect((await lstat(reservation)).mode & 0o777).toBe(0o600)

    await expect(importTaskSource({
      definition: resolve(testRoot, 'after-failure.json'),
      now: fixedNow,
      store
    })).rejects.toMatchObject({ code: 'IMPORT_CONFLICT' })

    const recovered = await recoverTaskImportDisposal(after.result.importPath, {
      confirmImportDigest: after.result.manifest.import_digest
    })

    expect(recovered.kind).toBe('tombstone')

    await expect(validateTaskImport(after.result.importPath)).resolves.toMatchObject({
      kind: 'tombstone'
    })

    await expect(lstat(recovery)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(reservation)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not report success when final reservation cleanup is interrupted', async () => {
    const imported = await importFixture(privateRetention, 'cleanup-failure')

    await expect(disposeTaskImport(imported.result.importPath, {
      confirmImportDigest: imported.result.manifest.import_digest,
      reason: 'owner-request',
      now: fixedNow,

      testHooks: {
        beforeReservationRelease: () => { throw new Error('cleanup interrupted') }
      }
    })).rejects.toMatchObject({ code: 'INVALID_LIFECYCLE' })

    await expect(validateTaskImport(imported.result.importPath)).rejects.toMatchObject({
      code: 'IMPORT_CONFLICT'
    })

    const recovered = await recoverTaskImportDisposal(imported.result.importPath, {
      confirmImportDigest: imported.result.manifest.import_digest
    })

    expect(recovered.kind).toBe('tombstone')
  })

  it('blocks import, validation, and materialization while disposal owns the address', async () => {
    const imported = await importFixture(privateRetention, 'concurrent-disposal')
    let releaseDisposal: (() => void) | undefined
    let markReserved: (() => void) | undefined

    const reserved = new Promise<void>((resolvePromise) => {
      markReserved = resolvePromise
    })

    const release = new Promise<void>((resolvePromise) => {
      releaseDisposal = resolvePromise
    })

    const disposal = disposeTaskImport(imported.result.importPath, {
      confirmImportDigest: imported.result.manifest.import_digest,
      reason: 'owner-request',
      now: fixedNow,

      testHooks: {
        afterReservation: async () => {
          markReserved?.()

          await release
        }
      }
    })

    await reserved

    await expect(importTaskSource({
      definition: resolve(testRoot, 'concurrent-disposal.json'),
      now: fixedNow,
      store: dirname(imported.result.importPath)
    })).rejects.toMatchObject({ code: 'IMPORT_CONFLICT' })

    await expect(validateTaskImport(imported.result.importPath)).rejects.toMatchObject({
      code: 'IMPORT_CONFLICT'
    })

    await expect(materializeTaskImport({
      destination: resolve(testRoot, 'concurrent-workspace'),
      importPath: imported.result.importPath
    })).rejects.toMatchObject({ code: 'IMPORT_CONFLICT' })

    releaseDisposal?.()
    await expect(disposal).resolves.toBeDefined()
  }, 20_000)
})
