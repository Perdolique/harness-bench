import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { LIMITS } from './constants.ts'

export interface TreeEntry {
  readonly mode: '100644' | '100755' | '120000';
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly type: 'file' | 'symlink';
}

export interface TreeManifest {
  readonly entries: readonly TreeEntry[];
  readonly pathCount: number;
  readonly schemaVersion: 'spike-1';
  readonly totalBytes: number;
}

export interface ScanLimits {
  readonly maximumBytes: number;
  readonly maximumPaths: number;
}

export interface CaptureOptions {
  readonly beforeSecondScan?: () => Promise<void>;
  readonly limits?: ScanLimits;
  readonly outputPath: string;
  readonly stableDelayMs?: number;
  readonly trustedBasePath: string;
  readonly workspacePath: string;
}

const defaultLimits: ScanLimits = {
  maximumBytes: LIMITS.maximumBytes,
  maximumPaths: LIMITS.maximumPaths
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function normalizeRelativePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/')
}

function isWithinRoot(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`

  return candidate === root || candidate.startsWith(prefix)
}

async function scanDirectory(
  root: string,
  directory: string,
  entries: TreeEntry[],
  counters: { pathCount: number; totalBytes: number },
  limits: ScanLimits
): Promise<void> {
  const directoryEntries = await readdir(directory, { withFileTypes: true })

  directoryEntries.sort((left, right) => left.name.localeCompare(right.name))

  for (const directoryEntry of directoryEntries) {
    if (directoryEntry.name === '.git') {
      continue
    }

    const absolutePath = join(directory, directoryEntry.name)
    const path = normalizeRelativePath(root, absolutePath)
    const metadata = await lstat(absolutePath)

    counters.pathCount += 1

    if (counters.pathCount > limits.maximumPaths) {
      throw new Error(`Workspace exceeds ${limits.maximumPaths} paths`)
    }

    if (metadata.isDirectory()) {
      await scanDirectory(root, absolutePath, entries, counters, limits)

      continue
    }

    if (metadata.isSymbolicLink()) {
      const target = await readlink(absolutePath)

      if (isAbsolute(target)) {
        throw new Error(`Symlink ${path} has an absolute target`)
      }

      const resolvedTarget = resolve(dirname(absolutePath), target)

      if (!isWithinRoot(root, resolvedTarget)) {
        throw new Error(`Symlink ${path} escapes the workspace`)
      }

      const targetSize = Buffer.byteLength(target)

      counters.totalBytes += targetSize

      entries.push({
        mode: '120000',
        path,
        sha256: sha256(target),
        size: targetSize,
        type: 'symlink'
      })
    } else if (metadata.isFile()) {
      const content = await readFile(absolutePath)

      counters.totalBytes += content.byteLength

      entries.push({
        mode: (metadata.mode & 0o111) === 0 ? '100644' : '100755',
        path,
        sha256: sha256(content),
        size: content.byteLength,
        type: 'file'
      })
    } else {
      throw new Error(`Unsupported workspace entry type at ${path}`)
    }

    if (counters.totalBytes > limits.maximumBytes) {
      throw new Error(`Workspace exceeds ${limits.maximumBytes} bytes`)
    }
  }
}

export async function scanWorkspace(
  workspacePath: string,
  limits: ScanLimits = defaultLimits
): Promise<TreeManifest> {
  const root = resolve(workspacePath)
  const metadata = await lstat(root)

  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Workspace root must be a real directory')
  }

  const entries: TreeEntry[] = []

  const counters = {
    pathCount: 0,
    totalBytes: 0
  }

  await scanDirectory(root, root, entries, counters, limits)
  entries.sort((left, right) => left.path.localeCompare(right.path))

  return {
    entries,
    pathCount: counters.pathCount,
    schemaVersion: 'spike-1',
    totalBytes: counters.totalBytes
  }
}

function stableManifestJson(manifest: TreeManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

function trustedGitEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: home,
    PATH: process.env.PATH
  }
}

function runTrustedGit(
  checkoutPath: string,
  home: string,
  args: readonly string[]
): string {
  const commonArgs = [
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.safecrlf=false',
    '-C',
    checkoutPath
  ]

  return execFileSync('git', [...commonArgs, ...args], {
    encoding: 'utf8',
    env: trustedGitEnvironment(home),
    maxBuffer: 16 * 1024 * 1024
  })
}

async function replaceCheckoutWorktree(
  checkoutPath: string,
  workspacePath: string
): Promise<void> {
  const checkoutEntries = await readdir(checkoutPath)

  for (const name of checkoutEntries) {
    if (name !== '.git') {
      await rm(join(checkoutPath, name), {
        force: true,
        recursive: true
      })
    }
  }

  const workspaceEntries = await readdir(workspacePath)

  for (const name of workspaceEntries) {
    if (name !== '.git') {
      await cp(join(workspacePath, name), join(checkoutPath, name), {
        dereference: false,
        preserveTimestamps: true,
        recursive: true,
        verbatimSymlinks: true
      })
    }
  }
}

function manifestsMatch(left: TreeManifest, right: TreeManifest): boolean {
  return stableManifestJson(left) === stableManifestJson(right)
}

export async function createTrustedCapture(
  options: CaptureOptions
): Promise<TreeManifest> {
  const limits = options.limits ?? defaultLimits
  const firstManifest = await scanWorkspace(options.workspacePath, limits)
  const stableDelayMs = options.stableDelayMs ?? 500

  if (stableDelayMs > 0) {
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, stableDelayMs)
    )
  }

  await options.beforeSecondScan?.()

  const secondManifest = await scanWorkspace(options.workspacePath, limits)

  if (!manifestsMatch(firstManifest, secondManifest)) {
    throw new Error('Workspace changed during the stability window')
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'harness-bench-capture-'))
  const checkoutPath = join(temporaryRoot, 'checkout')
  const gitHome = join(temporaryRoot, 'git-home')

  try {
    await mkdir(gitHome, { recursive: true })

    await cp(options.trustedBasePath, checkoutPath, {
      dereference: false,
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true
    })

    await lstat(join(checkoutPath, '.git'))
    await replaceCheckoutWorktree(checkoutPath, options.workspacePath)

    const checkoutManifest = await scanWorkspace(checkoutPath, limits)

    if (!manifestsMatch(secondManifest, checkoutManifest)) {
      throw new Error('Trusted checkout does not match the captured workspace')
    }

    runTrustedGit(checkoutPath, gitHome, ['add', '--all'])

    const patch = runTrustedGit(checkoutPath, gitHome, [
      'diff',
      '--cached',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv'
    ])

    await mkdir(options.outputPath, { recursive: true })

    const manifestJson = stableManifestJson(secondManifest)

    await writeFile(join(options.outputPath, 'change.patch'), patch, 'utf8')

    await writeFile(
      join(options.outputPath, 'tree-manifest.json'),
      manifestJson,
      'utf8'
    )

    const captureRecord = {
      pathCount: secondManifest.pathCount,
      schemaVersion: 'spike-1',
      totalBytes: secondManifest.totalBytes,
      treeManifestSha256: sha256(manifestJson)
    }

    await writeFile(
      join(options.outputPath, 'capture.json'),
      `${JSON.stringify(captureRecord, null, 2)}\n`,
      'utf8'
    )

    await chmod(join(options.outputPath, 'change.patch'), 0o444)
    await chmod(join(options.outputPath, 'tree-manifest.json'), 0o444)
    await chmod(join(options.outputPath, 'capture.json'), 0o444)

    return secondManifest
  } finally {
    await rm(temporaryRoot, {
      force: true,
      recursive: true
    })
  }
}
