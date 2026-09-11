import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'

import { relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SHA256_PREFIX = 'sha256:'

const FORBIDDEN_SOURCE_NAMES = new Set([
  '.env',
  '.git',
  '.netrc',
  'auth.json',
  'credentials.json'
])

const IGNORED_SOURCE_NAMES = new Set([
  '.DS_Store',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results'
])

export interface TaskTreeEntry {
  readonly digest: string;
  readonly executable: boolean;
  readonly path: string;
  readonly size: number;
}

export interface TaskSourceSnapshot {
  readonly digest: string;
  readonly entries: readonly TaskTreeEntry[];
}

export interface MaterializeTaskWorkspaceOptions {
  readonly destination: string;
  readonly expectedSourceDigest: string;
  readonly source: string;
}

export interface MaterializeTaskWorkspaceResult {
  readonly baseCommit: string;
  readonly sourceDigest: string;
  readonly workspace: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256(contents: Uint8Array | string): string {
  return `${SHA256_PREFIX}${createHash('sha256').update(contents).digest('hex')}`
}

function isolatedGitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
  )

  return {
    ...environment,
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...overrides
  }
}

function assertSafeTaskPath(path: string): void {
  const segments = path.split('/')

  if (
    path === '' ||
    path.startsWith('/') ||
    path.includes('\\') ||
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        segment !== segment.normalize('NFC')
    ) ||
    segments.some((segment) => FORBIDDEN_SOURCE_NAMES.has(segment.toLowerCase()))
  ) {
    throw new Error(`Task source contains an unsafe path: ${JSON.stringify(path)}`)
  }
}

async function walkTaskSource(
  root: string,
  directory: string,
  entries: TaskTreeEntry[]
): Promise<void> {
  const children = await readdir(directory, { withFileTypes: true })

  children.sort((left, right) => compareText(left.name, right.name))

  for (const child of children) {
    if (
      IGNORED_SOURCE_NAMES.has(child.name) ||
      child.name.endsWith('.tsbuildinfo')
    ) {
      continue
    }

    const absolutePath = resolve(directory, child.name)
    const path = relative(root, absolutePath).split('\\').join('/')

    assertSafeTaskPath(path)

    const metadata = await lstat(absolutePath)

    if (metadata.isSymbolicLink()) {
      throw new Error(`Task source must not contain symbolic links: ${path}`)
    }

    if (metadata.isDirectory()) {
      await walkTaskSource(root, absolutePath, entries)

      continue
    }

    if (!metadata.isFile()) {
      throw new Error(`Task source contains an unsupported entry: ${path}`)
    }

    const contents = await readFile(absolutePath)

    entries.push({
      digest: sha256(contents),
      executable: (metadata.mode & 0o111) !== 0,
      path,
      size: contents.byteLength
    })
  }
}

export async function inspectTaskSource(source: string): Promise<TaskSourceSnapshot> {
  const root = await realpath(source)
  const metadata = await stat(root)

  if (!metadata.isDirectory()) {
    throw new Error('Task source must be a directory')
  }

  const entries: TaskTreeEntry[] = []

  await walkTaskSource(root, root, entries)

  if (entries.length === 0) {
    throw new Error('Task source must contain at least one file')
  }

  const digest = sha256(JSON.stringify(entries))

  return {
    digest,
    entries
  }
}

async function runGit(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {}
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    env: isolatedGitEnvironment(environment),
    maxBuffer: 16 * 1024 * 1024
  })

  return stdout.trim()
}

async function assertDestinationAvailable(destination: string): Promise<void> {
  try {
    await lstat(destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }

    throw error
  }

  throw new Error(`Task workspace destination already exists: ${destination}`)
}

async function copyTaskSnapshot(
  source: string,
  destination: string,
  entries: readonly TaskTreeEntry[]
): Promise<void> {
  await mkdir(destination, { recursive: true })

  for (const entry of entries) {
    const sourcePath = resolve(source, entry.path)
    const destinationPath = resolve(destination, entry.path)
    const metadata = await lstat(sourcePath)

    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Task source changed while materializing: ${entry.path}`)
    }

    const contents = await readFile(sourcePath)
    const executable = (metadata.mode & 0o111) !== 0

    if (
      sha256(contents) !== entry.digest ||
      contents.byteLength !== entry.size ||
      executable !== entry.executable
    ) {
      throw new Error(`Task source changed while materializing: ${entry.path}`)
    }

    await mkdir(resolve(destinationPath, '..'), { recursive: true })

    await writeFile(destinationPath, contents, {
      flag: 'wx'
    })

    await chmod(destinationPath, entry.executable ? 0o755 : 0o644)
  }
}

export async function materializeTaskWorkspace(
  options: MaterializeTaskWorkspaceOptions
): Promise<MaterializeTaskWorkspaceResult> {
  const source = await realpath(options.source)
  const sourceSnapshot = await inspectTaskSource(source)

  if (sourceSnapshot.digest !== options.expectedSourceDigest) {
    throw new Error(
      `Task source digest mismatch: expected ${options.expectedSourceDigest}, received ${sourceSnapshot.digest}`
    )
  }

  const destination = resolve(options.destination)

  await assertDestinationAvailable(destination)
  await mkdir(resolve(destination, '..'), { recursive: true })

  const stagingRoot = await mkdtemp(resolve(destination, '..', '.task-workspace-'))
  const stagingWorkspace = resolve(stagingRoot, 'workspace')

  try {
    await copyTaskSnapshot(source, stagingWorkspace, sourceSnapshot.entries)

    const [currentSourceSnapshot, copiedSnapshot] = await Promise.all([
      inspectTaskSource(source),
      inspectTaskSource(stagingWorkspace)
    ])

    if (
      currentSourceSnapshot.digest !== sourceSnapshot.digest ||
      copiedSnapshot.digest !== sourceSnapshot.digest
    ) {
      throw new Error('Task source changed while materializing')
    }

    await runGit(stagingWorkspace, [
      'init',
      '--quiet',
      '--template=',
      '--initial-branch=main'
    ])

    await runGit(stagingWorkspace, ['add', '--all'])

    const commitEnvironment = {
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_AUTHOR_EMAIL: 'benchmark@example.invalid',
      GIT_AUTHOR_NAME: 'Harness Bench',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_EMAIL: 'benchmark@example.invalid',
      GIT_COMMITTER_NAME: 'Harness Bench'
    }

    await runGit(
      stagingWorkspace,
      ['commit', '--quiet', '--no-gpg-sign', '-m', 'chore: materialize task base'],
      commitEnvironment
    )

    const status = await runGit(stagingWorkspace, ['status', '--short'])

    if (status !== '') {
      throw new Error('Materialized task workspace is not clean after its base commit')
    }

    const baseCommit = await runGit(stagingWorkspace, ['rev-parse', 'HEAD'])

    await rename(stagingWorkspace, destination)

    return {
      baseCommit,
      sourceDigest: sourceSnapshot.digest,
      workspace: destination
    }
  } finally {
    await rm(stagingRoot, {
      force: true,
      recursive: true
    })
  }
}

export async function inspectMaterializedTaskWorkspace(
  workspace: string
): Promise<{
  readonly alternates: readonly string[];
  readonly baseCommit: string;
  readonly commitCount: number;
  readonly hooks: readonly string[];
  readonly refs: readonly string[];
  readonly remotes: readonly string[];
  readonly status: string;
  readonly unreachable: string;
}> {
  const gitDirectory = resolve(workspace, '.git')
  const hooksDirectory = resolve(gitDirectory, 'hooks')
  const alternatesPath = resolve(gitDirectory, 'objects', 'info', 'alternates')
  const hooks = await readdir(hooksDirectory).catch(() => [])

  const alternates = await readFile(alternatesPath, 'utf8')
    .then((contents) => contents.split('\n').filter(Boolean))
    .catch(() => [])

  const baseCommit = await runGit(workspace, ['rev-parse', 'HEAD'])
  const commitCount = Number(await runGit(workspace, ['rev-list', '--count', '--all']))

  const refs = (await runGit(workspace, ['for-each-ref', '--format=%(refname)']))
    .split('\n')
    .filter(Boolean)

  const remotes = (await runGit(workspace, ['remote'])).split('\n').filter(Boolean)
  const status = await runGit(workspace, ['status', '--short'])
  const unreachable = await runGit(workspace, ['fsck', '--unreachable', '--no-reflogs'])

  return {
    alternates,
    baseCommit,
    commitCount,
    hooks,
    refs,
    remotes,
    status,
    unreachable
  }
}
