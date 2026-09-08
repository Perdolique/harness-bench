import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { inspectTaskSource, materializeTaskWorkspace, type TaskTreeEntry } from './task.ts'

const execFileAsync = promisify(execFile)
const ARTIFACT_FILES = ['workspace-metadata.json', 'workspace.patch'] as const

const IGNORED_WORKSPACE_NAMES = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results'
])

const RESERVED_PATCH_SEGMENTS = new Set([
  'auth',
  'credentials',
  'logs',
  'sha256-manifest.json',
  'solution',
  'tests-hidden',
  'trusted-base',
  'trusted-tools',
  'verifier'
])

export interface WorkspaceArtifactMetadata {
  readonly base_commit: string;
  readonly patch: {
    readonly digest: string;
    readonly size: number;
  };
  readonly result_tree: readonly TaskTreeEntry[];
  readonly source_digest: string;
  readonly version: 1;
}

export interface CaptureWorkspaceArtifactsOptions {
  readonly artifacts: string;
  readonly baseCommit: string;
  readonly expectedSourceDigest: string;
  readonly source: string;
  readonly workspace: string;
}

export interface VerifyWorkspaceArtifactsOptions {
  readonly artifacts: string;
  readonly destination: string;
  readonly expectedBaseCommit: string;
  readonly expectedSourceDigest: string;
  readonly source: string;
}

function sha256(contents: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
  )

  return {
    ...environment,
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1'
  }
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    env: isolatedGitEnvironment(),
    maxBuffer: 32 * 1024 * 1024
  })

  return stdout
}

async function copyWorkspaceEntry(source: string, destination: string): Promise<void> {
  const metadata = await lstat(source)

  if (metadata.isSymbolicLink()) {
    throw new Error(`Workspace artifacts do not support symbolic links: ${source}`)
  }

  if (metadata.isDirectory()) {
    await mkdir(destination, { recursive: true })

    const children = await readdir(source, { withFileTypes: true })

    children.sort((left, right) => compareText(left.name, right.name))

    for (const child of children) {
      if (
        IGNORED_WORKSPACE_NAMES.has(child.name) ||
        child.name.endsWith('.tsbuildinfo')
      ) {
        continue
      }

      await copyWorkspaceEntry(
        resolve(source, child.name),
        resolve(destination, child.name)
      )
    }

    return
  }

  if (!metadata.isFile()) {
    throw new Error(`Workspace contains an unsupported entry: ${source}`)
  }

  await mkdir(dirname(destination), { recursive: true })

  await cp(source, destination, {
    dereference: false,
    errorOnExist: true
  })
}

async function replaceWorktree(workspace: string, candidate: string): Promise<void> {
  for (const entry of await readdir(workspace, { withFileTypes: true })) {
    if (entry.name === '.git') {
      continue
    }

    await rm(resolve(workspace, entry.name), {
      force: true,
      recursive: true
    })
  }

  for (const entry of await readdir(candidate, { withFileTypes: true })) {
    if (
      IGNORED_WORKSPACE_NAMES.has(entry.name) ||
      entry.name.endsWith('.tsbuildinfo')
    ) {
      continue
    }

    await copyWorkspaceEntry(
      resolve(candidate, entry.name),
      resolve(workspace, entry.name)
    )
  }
}

async function inspectFilteredWorkspace(workspace: string): Promise<{
  readonly digest: string;
  readonly entries: readonly TaskTreeEntry[];
}> {
  const stagingRoot = await mkdtemp('/tmp/harness-bench-tree-')
  const filteredWorkspace = resolve(stagingRoot, 'workspace')

  try {
    await copyWorkspaceEntry(workspace, filteredWorkspace)

    return await inspectTaskSource(filteredWorkspace)
  } finally {
    await rm(stagingRoot, {
      force: true,
      recursive: true
    })
  }
}

function serializeMetadata(metadata: WorkspaceArtifactMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`
}

function parsePatchPaths(patch: string): readonly string[] {
  const paths = new Set<string>()

  for (const line of patch.split('\n')) {
    const match = /^(?:---|\+\+\+) (?:[ab]\/)?(.+)$/.exec(line)

    if (match === null || match[1] === '/dev/null') {
      continue
    }

    paths.add(match[1] ?? '')
  }

  return [...paths]
}

function assertSafePatchPath(path: string): void {
  const segments = path.split('/')

  if (
    path === '' ||
    path.startsWith('/') ||
    path.includes('\\') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    segments.some((segment) => RESERVED_PATCH_SEGMENTS.has(segment.toLowerCase()))
  ) {
    throw new Error(`Patch contains an unsafe path: ${JSON.stringify(path)}`)
  }
}

function parseMetadata(source: string): WorkspaceArtifactMetadata {
  const candidate = JSON.parse(source) as Partial<WorkspaceArtifactMetadata>

  if (
    candidate.version !== 1 ||
    typeof candidate.base_commit !== 'string' ||
    typeof candidate.source_digest !== 'string' ||
    candidate.patch === undefined ||
    typeof candidate.patch.digest !== 'string' ||
    typeof candidate.patch.size !== 'number' ||
    !Array.isArray(candidate.result_tree)
  ) {
    throw new Error('Workspace metadata does not satisfy version 1')
  }

  return candidate as WorkspaceArtifactMetadata
}

async function assertArtifactInventory(artifacts: string): Promise<void> {
  const root = await lstat(artifacts)

  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error('Artifact root must be a real directory')
  }

  const entries = await readdir(artifacts, { withFileTypes: true })
  const names = entries.map(({ name }) => name).sort(compareText)

  if (JSON.stringify(names) !== JSON.stringify(ARTIFACT_FILES)) {
    throw new Error(
      `Artifact inventory must contain exactly ${ARTIFACT_FILES.join(' and ')}`
    )
  }

  for (const entry of entries) {
    const metadata = await lstat(resolve(artifacts, entry.name))

    if (!entry.isFile() || entry.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error(`Artifact must be a regular file: ${entry.name}`)
    }
  }
}

export async function captureWorkspaceArtifacts(
  options: CaptureWorkspaceArtifactsOptions
): Promise<WorkspaceArtifactMetadata> {
  const stagingRoot = await mkdtemp('/tmp/harness-bench-capture-')
  const trustedWorkspace = resolve(stagingRoot, 'workspace')
  const firstCandidate = resolve(stagingRoot, 'candidate-first')
  const secondCandidate = resolve(stagingRoot, 'candidate-second')

  try {
    await copyWorkspaceEntry(options.workspace, firstCandidate)
    await copyWorkspaceEntry(options.workspace, secondCandidate)

    const before = await inspectTaskSource(firstCandidate)
    const after = await inspectTaskSource(secondCandidate)

    if (before.digest !== after.digest) {
      throw new Error('Workspace changed while trusted capture was scanning it')
    }

    const materialized = await materializeTaskWorkspace({
      destination: trustedWorkspace,
      expectedSourceDigest: options.expectedSourceDigest,
      source: options.source
    })

    if (materialized.baseCommit !== options.baseCommit) {
      throw new Error('Trusted base commit does not match the declared base commit')
    }

    await replaceWorktree(trustedWorkspace, secondCandidate)
    await runGit(trustedWorkspace, ['add', '--all'])

    const patch = await runGit(trustedWorkspace, [
      'diff',
      '--cached',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv'
    ])

    const resultSnapshot = await inspectTaskSource(secondCandidate)

    const metadata: WorkspaceArtifactMetadata = {
      base_commit: options.baseCommit,

      patch: {
        digest: sha256(patch),
        size: Buffer.byteLength(patch)
      },

      result_tree: resultSnapshot.entries,
      source_digest: options.expectedSourceDigest,
      version: 1
    }

    await mkdir(options.artifacts, { recursive: false })

    await writeFile(resolve(options.artifacts, 'workspace.patch'), patch, {
      flag: 'wx'
    })

    await writeFile(
      resolve(options.artifacts, 'workspace-metadata.json'),
      serializeMetadata(metadata),
      { flag: 'wx' }
    )

    return metadata
  } finally {
    await rm(stagingRoot, {
      force: true,
      recursive: true
    })
  }
}

export async function verifyWorkspaceArtifacts(
  options: VerifyWorkspaceArtifactsOptions
): Promise<WorkspaceArtifactMetadata> {
  await assertArtifactInventory(options.artifacts)

  const patchBuffer = await readFile(resolve(options.artifacts, 'workspace.patch'))
  const patch = patchBuffer.toString('utf8')

  const metadata = parseMetadata(
    await readFile(resolve(options.artifacts, 'workspace-metadata.json'), 'utf8')
  )

  if (
    metadata.base_commit !== options.expectedBaseCommit ||
    metadata.source_digest !== options.expectedSourceDigest
  ) {
    throw new Error('Workspace metadata does not match the immutable task base')
  }

  if (
    metadata.patch.digest !== sha256(patchBuffer) ||
    metadata.patch.size !== patchBuffer.byteLength
  ) {
    throw new Error('Workspace patch hash or size does not match its metadata')
  }

  for (const path of parsePatchPaths(patch)) {
    assertSafePatchPath(path)
  }

  const declaredPaths = new Set<string>()

  for (const entry of metadata.result_tree) {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') {
      throw new Error('Workspace metadata contains an invalid tree entry')
    }

    assertSafePatchPath(entry.path)

    if (declaredPaths.has(entry.path)) {
      throw new Error('Workspace metadata contains a duplicate tree path')
    }

    declaredPaths.add(entry.path)
  }

  for (const path of declaredPaths) {
    let parent = dirname(path)

    while (parent !== '.') {
      if (declaredPaths.has(parent)) throw new Error('Workspace metadata contains overlapping tree paths')

      parent = dirname(parent)
    }
  }

  const destination = resolve(options.destination)

  const materialized = await materializeTaskWorkspace({
    destination,
    expectedSourceDigest: options.expectedSourceDigest,
    source: options.source
  })

  if (materialized.baseCommit !== options.expectedBaseCommit) {
    await rm(destination, {
      force: true,
      recursive: true
    })

    throw new Error('Materialized task base commit does not match metadata')
  }

  try {
    if (patch.length > 0) {
      const patchPath = resolve(options.artifacts, 'workspace.patch')

      await runGit(destination, ['apply', '--check', '--binary', patchPath])
      await runGit(destination, ['apply', '--binary', patchPath])
    }

    const changedPaths = (
      await runGit(destination, [
        'diff',
        '--name-only',
        '--no-renames',
        '-z',
        'HEAD',
        '--'
      ])
    )
      .split('\0')
      .filter(Boolean)

    for (const path of changedPaths) {
      assertSafePatchPath(path)
    }

    const actual = await inspectFilteredWorkspace(destination)

    if (JSON.stringify(actual.entries) !== JSON.stringify(metadata.result_tree)) {
      throw new Error('Replayed workspace tree does not match trusted metadata')
    }

    return metadata
  } catch (error) {
    await rm(destination, {
      force: true,
      recursive: true
    })

    throw error
  }
}

/** Validates Harbor's implicit logs transfer and the complete declared collector inventory before replay. */
export async function assertHarborArtifactInventory(root: string): Promise<void> {
  const files = new Set(['manifest.json', 'trusted-collector/workspace-metadata.json', 'trusted-collector/workspace.patch'])
  const directories = new Set(['logs', 'logs/artifacts', 'trusted-collector'])
  const seen = new Set<string>()

  async function visit(directory: string, prefix: string): Promise<void> {
    const metadata = await lstat(directory)

    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Harbor artifact directory must be real')

    for (const child of await readdir(directory)) {
      const path = prefix === '' ? child : `${prefix}/${child}`
      const fullPath = resolve(directory, child)
      const entry = await lstat(fullPath)

      if (entry.isDirectory() && !entry.isSymbolicLink() && directories.has(path)) {
        await visit(fullPath, path)
      } else if (entry.isFile() && entry.nlink === 1 && files.has(path)) {
        seen.add(path)
      } else throw new Error('Harbor staged an unsafe or undeclared artifact entry')
    }
  }

  await visit(root, '')

  if (seen.size !== files.size) throw new Error('Harbor artifact inventory is incomplete')
}
