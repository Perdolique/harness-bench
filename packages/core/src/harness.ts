import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { HarnessDocumentSchema, type HarnessDocument } from '@harness-bench/schemas'
import * as v from 'valibot'
import { validateWithPinnedCodex } from './codex.ts'
import { HarnessError } from './errors.ts'

import {
  readHarnessSource,
  snapshotsMatch,
  validateHarnessSourceContent,
  validateHarnessEntryPath,
  type CapturedSourceEntry,
  type HarnessSourceSnapshot
} from './source.ts'

import type {
  CaptureHarnessBundleOptions,
  CaptureHarnessBundleResult,
  HarnessBundleDiff,
  HarnessEntry,
  HarnessEntryDifference,
  HarnessEntryKind,
  HarnessIdentityDifference,
  MaterializeHarnessBundleOptions,
  MaterializeHarnessBundleResult,
  ValidateHarnessBundleResult
} from './types.ts'

const SHA256_PREFIX = 'sha256:'
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/

interface LoadedHarnessBundle {
  readonly bundlePath: string;
  readonly contentsByPath: ReadonlyMap<string, Buffer>;
  readonly manifest: HarnessDocument;
}

interface LoadBundleOptions {
  readonly requireAddressName: boolean;
  readonly requireEffectiveConfig: boolean;
  readonly requireImmutable: boolean;
}

interface BundleInventory {
  readonly directories: readonly string[];
  readonly files: readonly string[];
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1
  }

  if (left > right) {
    return 1
  }

  return 0
}

function hasAsciiControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)

    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }

  return false
}

function sha256(contents: Uint8Array | string): string {
  const hex = createHash('sha256').update(contents).digest('hex')

  return `${SHA256_PREFIX}${hex}`
}

function manifestPreimage(
  harnessId: string,
  revision: string,
  entries: readonly HarnessEntry[]
): string {
  const preimage = {
    document_type: 'harness',
    schema_version: 1,
    harness_id: harnessId,
    revision,
    entries
  }

  return JSON.stringify(preimage)
}

function buildManifest(
  options: CaptureHarnessBundleOptions,
  snapshot: HarnessSourceSnapshot
): HarnessDocument {
  const entries = snapshot.entries.map(({ digest, kind, path }) => ({
    kind,
    path,
    digest
  }))

  const digest = sha256(manifestPreimage(options.harnessId, options.revision, entries))

  const candidate = {
    document_type: 'harness',
    schema_version: 1,
    harness_id: options.harnessId,
    revision: options.revision,
    digest,
    entries
  }

  const result = v.safeParse(HarnessDocumentSchema, candidate)

  if (!result.success) {
    throw new HarnessError(
      'INVALID_SOURCE',
      'Harness identity or entries do not satisfy schema v1',
      { cause: new Error(JSON.stringify(result.issues)) }
    )
  }

  return result.output
}

function serializeManifest(manifest: HarnessDocument): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

function assertSafeManifestPath(path: string): void {
  const segments = path.split('/')

  if (
    path === '' ||
    path.startsWith('/') ||
    path.includes('\\') ||
    hasAsciiControl(path) ||
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..'
    ) ||
    segments.some((segment) => segment !== segment.normalize('NFC'))
  ) {
    const displayPath = JSON.stringify(path)

    throw new HarnessError(
      'INVALID_BUNDLE',
      `Bundle manifest contains an unsafe path: ${displayPath}`,
      { path }
    )
  }
}

function expectedKind(path: string): HarnessEntryKind | undefined {
  if (path === 'AGENTS.md' || path === 'AGENTS.override.md') {
    return 'agents_md'
  }

  if (path === 'config.toml') {
    return 'codex_config'
  }

  if (path === 'mcp-tools.json') {
    return 'mcp_tools'
  }

  if (/^skills\/[^/]+\/.+/.test(path)) {
    return 'skill'
  }

  if (/^rules\/[^/]+\.rules$/.test(path)) {
    return 'policy'
  }
}

function expectedDirectories(entries: readonly HarnessEntry[]): string[] {
  const directories = new Set<string>()

  for (const entry of entries) {
    const segments = entry.path.split('/')

    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'))
    }
  }

  return [...directories].sort(compareText)
}

function assertCanonicalManifest(manifest: HarnessDocument): void {
  const sorted = [...manifest.entries].sort((left, right) => {
    const pathOrder = compareText(left.path, right.path)

    return pathOrder === 0 ? compareText(left.kind, right.kind) : pathOrder
  })

  if (JSON.stringify(sorted) !== JSON.stringify(manifest.entries)) {
    throw new HarnessError(
      'INVALID_BUNDLE',
      'Bundle manifest entries are not in canonical order'
    )
  }

  const foldedPaths = new Map<string, string>()
  const declaredPaths = new Set(manifest.entries.map(({ path }) => path))

  for (const entry of manifest.entries) {
    assertSafeManifestPath(entry.path)
    validateHarnessEntryPath(entry.path)

    const kind = expectedKind(entry.path)

    if (kind !== entry.kind) {
      throw new HarnessError(
        'INVALID_BUNDLE',
        `Bundle entry kind does not match its path: ${entry.path}`,
        { path: entry.path }
      )
    }

    const folded = entry.path.toLowerCase()
    const existing = foldedPaths.get(folded)

    if (existing !== undefined && existing !== entry.path) {
      throw new HarnessError(
        'INVALID_BUNDLE',
        `Bundle paths collide under case folding: ${existing}, ${entry.path}`,
        { path: entry.path }
      )
    }

    foldedPaths.set(folded, entry.path)
  }

  const skillNames = new Set(
    manifest.entries
      .filter(({ path }) => path.startsWith('skills/'))
      .map(({ path }) => path.split('/')[1])
  )

  for (const skillName of skillNames) {
    if (
      skillName === undefined ||
      !declaredPaths.has(`skills/${skillName}/SKILL.md`)
    ) {
      throw new HarnessError(
        'INVALID_BUNDLE',
        `Bundle skill is missing its SKILL.md entrypoint: ${skillName ?? '<unknown>'}`
      )
    }
  }

  for (const required of ['config.toml', 'mcp-tools.json']) {
    if (!declaredPaths.has(required)) {
      throw new HarnessError(
        'INVALID_BUNDLE',
        `Bundle manifest is missing a required entry: ${required}`,
        { path: required }
      )
    }
  }

  const computedDigest = sha256(
    manifestPreimage(
      manifest.harness_id,
      manifest.revision,
      manifest.entries
    )
  )

  if (computedDigest !== manifest.digest) {
    throw new HarnessError(
      'INVALID_BUNDLE',
      'Bundle manifest digest does not match its canonical contents'
    )
  }
}

function assertExactMode(mode: number, expected: number, path: string): void {
  const actual = mode & 0o777

  if (actual !== expected) {
    const actualText = actual.toString(8)
    const expectedText = expected.toString(8)

    throw new HarnessError(
      'INVALID_BUNDLE',
      `Immutable bundle path has mode ${actualText} instead of ${expectedText}: ${path}`,
      { path }
    )
  }
}

async function inspectBundleInventory(
  contentRoot: string,
  requireImmutable: boolean
): Promise<BundleInventory> {
  const files: string[] = []
  const directories: string[] = []

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })

    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name)
      const path = relative(contentRoot, absolutePath)
      const metadata = await lstat(absolutePath)

      assertSafeManifestPath(path)

      if (metadata.isSymbolicLink()) {
        throw new HarnessError(
          'INVALID_BUNDLE',
          `Bundle symlink is forbidden: ${path}`,
          { path }
        )
      }

      if (metadata.isDirectory()) {
        if (requireImmutable) {
          assertExactMode(metadata.mode, 0o555, path)
        }

        directories.push(path)
        await visit(absolutePath)

        continue
      }

      if (!metadata.isFile()) {
        throw new HarnessError(
          'INVALID_BUNDLE',
          `Bundle contains a non-regular file: ${path}`,
          { path }
        )
      }

      if (requireImmutable) {
        assertExactMode(metadata.mode, 0o444, path)
      }

      files.push(path)
    }
  }

  await visit(contentRoot)
  files.sort(compareText)
  directories.sort(compareText)

  return {
    directories,
    files
  }
}

async function readBundleFile(path: string, displayPath: string): Promise<Buffer> {
  let handle

  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)

    const before = await handle.stat()
    const contents = await handle.readFile()
    const after = await handle.stat()
    const pathMetadata = await lstat(path)

    const invalidFileType =
      !before.isFile() ||
      !after.isFile() ||
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isFile()

    const openedFileChanged =
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs

    const pathRebound =
      after.dev !== pathMetadata.dev || after.ino !== pathMetadata.ino

    if (invalidFileType || openedFileChanged || pathRebound) {
      throw new HarnessError(
        'INVALID_BUNDLE',
        `Bundle changed while reading: ${displayPath}`,
        { path: displayPath }
      )
    }

    return contents
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error
    }

    throw new HarnessError(
      'INVALID_BUNDLE',
      `Bundle file is unavailable: ${displayPath}`,
      {
        cause: error,
        path: displayPath
      }
    )
  } finally {
    await handle?.close()
  }
}

async function loadBundle(
  bundle: string,
  options: LoadBundleOptions
): Promise<LoadedHarnessBundle> {
  const bundlePath = resolve(bundle)
  let rootMetadata

  try {
    rootMetadata = await lstat(bundlePath)
  } catch (error) {
    throw new HarnessError('INVALID_BUNDLE', 'Bundle directory is unavailable', {
      cause: error,
      path: bundlePath
    })
  }

  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new HarnessError(
      'INVALID_BUNDLE',
      'Bundle root must be a real directory',
      { path: bundlePath }
    )
  }

  if (options.requireImmutable) {
    assertExactMode(rootMetadata.mode, 0o555, '.')
  }

  const rootEntries = (await readdir(bundlePath)).sort(compareText)

  if (JSON.stringify(rootEntries) !== JSON.stringify(['content', 'manifest.json'])) {
    throw new HarnessError(
      'INVALID_BUNDLE',
      'Bundle root inventory must contain only content and manifest.json'
    )
  }

  const manifestPath = resolve(bundlePath, 'manifest.json')
  const contentRoot = resolve(bundlePath, 'content')
  const manifestMetadata = await lstat(manifestPath)
  const contentMetadata = await lstat(contentRoot)

  if (manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile()) {
    throw new HarnessError(
      'INVALID_BUNDLE',
      'Bundle manifest must be a regular file',
      { path: 'manifest.json' }
    )
  }

  if (contentMetadata.isSymbolicLink() || !contentMetadata.isDirectory()) {
    throw new HarnessError(
      'INVALID_BUNDLE',
      'Bundle content must be a real directory',
      { path: 'content' }
    )
  }

  if (options.requireImmutable) {
    assertExactMode(manifestMetadata.mode, 0o444, 'manifest.json')
    assertExactMode(contentMetadata.mode, 0o555, 'content')
  }

  let manifestDocument: unknown

  try {
    const manifestContents = await readBundleFile(manifestPath, 'manifest.json')

    manifestDocument = JSON.parse(manifestContents.toString('utf8'))
  } catch (error) {
    throw new HarnessError('INVALID_BUNDLE', 'Bundle manifest is invalid JSON', {
      cause: error,
      path: 'manifest.json'
    })
  }

  const parsed = v.safeParse(HarnessDocumentSchema, manifestDocument)

  if (!parsed.success) {
    throw new HarnessError(
      'INVALID_BUNDLE',
      'Bundle manifest does not satisfy schema v1',
      {
        cause: new Error(JSON.stringify(parsed.issues)),
        path: 'manifest.json'
      }
    )
  }

  const manifest = parsed.output

  assertCanonicalManifest(manifest)

  if (options.requireAddressName) {
    const address = manifest.digest.slice(SHA256_PREFIX.length)

    if (!SHA256_HEX_PATTERN.test(address) || basename(bundlePath) !== address) {
      throw new HarnessError(
        'INVALID_BUNDLE',
        'Bundle directory name does not match its content address',
        { path: bundlePath }
      )
    }
  }

  const inventory = await inspectBundleInventory(
    contentRoot,
    options.requireImmutable
  )

  const expectedFiles = manifest.entries.map(({ path }) => path)
  const directories = expectedDirectories(manifest.entries)

  if (JSON.stringify(inventory.files) !== JSON.stringify(expectedFiles)) {
    throw new HarnessError(
      'INVALID_BUNDLE',
      'Bundle content inventory does not match the manifest'
    )
  }

  if (JSON.stringify(inventory.directories) !== JSON.stringify(directories)) {
    throw new HarnessError(
      'INVALID_BUNDLE',
      'Bundle directory inventory does not match the manifest'
    )
  }

  const contentsByPath = new Map<string, Buffer>()
  const capturedEntries: CapturedSourceEntry[] = []

  for (const entry of manifest.entries) {
    const contents = await readBundleFile(
      resolve(contentRoot, entry.path),
      entry.path
    )

    if (sha256(contents) !== entry.digest) {
      throw new HarnessError(
        'INVALID_BUNDLE',
        `Bundle entry digest mismatch: ${entry.path}`,
        { path: entry.path }
      )
    }

    contentsByPath.set(entry.path, contents)

    capturedEntries.push({
      contents,
      digest: entry.digest,
      kind: entry.kind,
      path: entry.path
    })
  }

  validateHarnessSourceContent({ entries: capturedEntries })

  if (options.requireEffectiveConfig) {
    await validateWithPinnedCodex(configContents({ entries: capturedEntries }))
  }

  return {
    bundlePath,
    contentsByPath,
    manifest
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)

    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false
    }

    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

async function writeStagedBundle(
  stage: string,
  manifest: HarnessDocument,
  snapshot: HarnessSourceSnapshot
): Promise<void> {
  const contentRoot = resolve(stage, 'content')

  await mkdir(contentRoot, {
    recursive: true,
    mode: 0o700
  })

  await writeFile(resolve(stage, 'manifest.json'), serializeManifest(manifest), {
    mode: 0o600
  })

  for (const entry of snapshot.entries) {
    const destination = resolve(contentRoot, entry.path)

    await mkdir(dirname(destination), {
      recursive: true,
      mode: 0o700
    })

    await writeFile(destination, entry.contents, { mode: 0o600 })
  }
}

async function makeBundleImmutable(root: string): Promise<void> {
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })

    for (const entry of entries) {
      const path = resolve(directory, entry.name)

      if (entry.isDirectory()) {
        await visit(path)
        await chmod(path, 0o555)
      } else {
        await chmod(path, 0o444)
      }
    }
  }

  await visit(root)
  await chmod(root, 0o555)
}

async function removeBundleTree(root: string): Promise<void> {
  if (!(await pathExists(root))) {
    return
  }

  async function makeWritable(path: string): Promise<void> {
    const metadata = await lstat(path)

    if (metadata.isDirectory()) {
      await chmod(path, 0o700)

      const entries = await readdir(path)

      for (const entry of entries) {
        await makeWritable(resolve(path, entry))
      }
    } else {
      await chmod(path, 0o600)
    }
  }

  await makeWritable(root)

  await rm(root, {
    force: true,
    recursive: true
  })
}

async function makeMaterializedDirectoriesPrivate(root: string): Promise<void> {
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isDirectory()) {
        await visit(resolve(directory, entry.name))
      }
    }

    await chmod(directory, 0o700)
  }

  await visit(root)
}

function configContents(snapshot: HarnessSourceSnapshot): Buffer {
  const entry = snapshot.entries.find(({ path }) => path === 'config.toml')

  if (entry === undefined) {
    throw new HarnessError(
      'INVALID_SOURCE',
      'Harness source is missing config.toml',
      { path: 'config.toml' }
    )
  }

  return entry.contents
}

function storeIsInsideSource(source: string, store: string): boolean {
  const path = relative(source, store)

  return path === '' || (!path.startsWith('..') && !path.startsWith('/'))
}

async function resolvePhysicalPath(path: string): Promise<string> {
  let candidate = resolve(path)
  const missingSegments: string[] = []

  while (true) {
    try {
      const physicalRoot = await realpath(candidate)
      const physicalPath = resolve(physicalRoot, ...missingSegments)

      return physicalPath
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error
      }

      const parent = dirname(candidate)

      if (parent === candidate) {
        throw error
      }

      missingSegments.unshift(basename(candidate))

      candidate = parent
    }
  }
}

/** Captures one validated harness source as a content-addressed bundle. */
export async function captureHarnessBundle(
  options: CaptureHarnessBundleOptions
): Promise<CaptureHarnessBundleResult> {
  const source = resolve(options.source)
  const store = resolve(options.store)
  const firstSnapshot = await readHarnessSource(source)
  let physicalSource: string
  let physicalStore: string

  try {
    physicalSource = await realpath(source)
    physicalStore = await resolvePhysicalPath(store)
  } catch (error) {
    throw new HarnessError(
      'INVALID_SOURCE',
      'Harness source or store path could not be resolved safely',
      { cause: error }
    )
  }

  if (storeIsInsideSource(physicalSource, physicalStore)) {
    throw new HarnessError(
      'INVALID_SOURCE',
      'Harness store must not be inside the captured source',
      { path: store }
    )
  }

  validateHarnessSourceContent(firstSnapshot)
  await validateWithPinnedCodex(configContents(firstSnapshot))

  const secondSnapshot = await readHarnessSource(source)

  validateHarnessSourceContent(secondSnapshot)

  if (!snapshotsMatch(firstSnapshot, secondSnapshot)) {
    throw new HarnessError(
      'SOURCE_CHANGED',
      'Harness source changed during capture'
    )
  }

  const manifest = buildManifest(options, firstSnapshot)
  const address = manifest.digest.slice(SHA256_PREFIX.length)
  const bundlePath = resolve(store, address)

  await mkdir(store, {
    recursive: true,
    mode: 0o700
  })

  const storeMetadata = await lstat(store)

  if (storeMetadata.isSymbolicLink() || !storeMetadata.isDirectory()) {
    throw new HarnessError(
      'INVALID_SOURCE',
      'Harness store must be a real directory',
      { path: store }
    )
  }

  if ((storeMetadata.mode & 0o777) !== 0o700) {
    throw new HarnessError(
      'INVALID_SOURCE',
      'Harness store must have mode 0700',
      { path: store }
    )
  }

  if (await pathExists(bundlePath)) {
    const existing = await loadBundle(bundlePath, {
      requireAddressName: true,
      requireEffectiveConfig: true,
      requireImmutable: true
    })

    if (serializeManifest(existing.manifest) !== serializeManifest(manifest)) {
      throw new HarnessError(
        'INVALID_BUNDLE',
        'Existing content-addressed bundle has conflicting metadata',
        { path: bundlePath }
      )
    }

    return {
      bundlePath,
      manifest: existing.manifest
    }
  }

  const stage = await mkdtemp(resolve(store, '.harness-staging-'))

  try {
    await writeStagedBundle(stage, manifest, firstSnapshot)

    await loadBundle(stage, {
      requireAddressName: false,
      requireEffectiveConfig: false,
      requireImmutable: false
    })

    await makeBundleImmutable(stage)

    try {
      await rename(stage, bundlePath)
    } catch (error) {
      if (!(await pathExists(bundlePath))) {
        throw error
      }

      const existing = await loadBundle(bundlePath, {
        requireAddressName: true,
        requireEffectiveConfig: true,
        requireImmutable: true
      })

      if (serializeManifest(existing.manifest) !== serializeManifest(manifest)) {
        throw new HarnessError(
          'INVALID_BUNDLE',
          'Concurrent bundle finalization produced conflicting metadata',
          {
            cause: error,
            path: bundlePath
          }
        )
      }
    }
  } finally {
    await removeBundleTree(stage)
  }

  const validated = await loadBundle(bundlePath, {
    requireAddressName: true,
    requireEffectiveConfig: false,
    requireImmutable: true
  })

  return {
    bundlePath,
    manifest: validated.manifest
  }
}

/** Validates a complete immutable bundle without invoking an agent or provider. */
export async function validateHarnessBundle(
  bundle: string
): Promise<ValidateHarnessBundleResult> {
  const loaded = await loadBundle(bundle, {
    requireAddressName: true,
    requireEffectiveConfig: true,
    requireImmutable: true
  })

  return {
    bundlePath: loaded.bundlePath,
    manifest: loaded.manifest
  }
}

function materializedPath(root: string, entry: HarnessEntry): string {
  if (entry.kind === 'agents_md' || entry.kind === 'codex_config') {
    return resolve(root, 'codex-home', entry.path)
  }

  if (entry.kind === 'skill') {
    return resolve(root, 'home', '.agents', entry.path)
  }

  if (entry.kind === 'policy') {
    return resolve(root, 'codex-home', entry.path)
  }

  return resolve(root, 'mcp-tools.json')
}

/** Creates one fresh, non-auth agent home and workspace from a valid bundle. */
export async function materializeHarnessBundle(
  options: MaterializeHarnessBundleOptions
): Promise<MaterializeHarnessBundleResult> {
  const loaded = await loadBundle(options.bundle, {
    requireAddressName: true,
    requireEffectiveConfig: true,
    requireImmutable: true
  })

  const root = resolve(options.destination)
  const codexHome = resolve(root, 'codex-home')
  const home = resolve(root, 'home')
  const skills = resolve(home, '.agents', 'skills')
  const rules = resolve(codexHome, 'rules')
  const workspace = resolve(root, 'workspace')
  const mcpToolsPath = resolve(root, 'mcp-tools.json')
  let ownsRoot = false

  try {
    await mkdir(root, { mode: 0o700 })

    ownsRoot = true

    for (const directory of [codexHome, skills, rules, workspace]) {
      await mkdir(directory, {
        recursive: true,
        mode: 0o700
      })

      await chmod(directory, 0o700)
    }

    for (const entry of loaded.manifest.entries) {
      const contents = loaded.contentsByPath.get(entry.path)

      if (contents === undefined) {
        throw new HarnessError(
          'INVALID_BUNDLE',
          `Validated bundle content is unavailable: ${entry.path}`,
          { path: entry.path }
        )
      }

      const destination = materializedPath(root, entry)
      const mode = entry.kind === 'skill' ? 0o500 : 0o600

      await mkdir(dirname(destination), {
        recursive: true,
        mode: 0o700
      })

      await writeFile(destination, contents, { mode })
      await chmod(destination, mode)
    }

    await makeMaterializedDirectoriesPrivate(root)
  } catch (error) {
    if (ownsRoot) {
      await rm(root, {
        force: true,
        recursive: true
      })
    }

    if (!ownsRoot && isNodeError(error) && error.code === 'EEXIST') {
      throw new HarnessError(
        'DESTINATION_EXISTS',
        'Harness materialization destination already exists',
        { path: root }
      )
    }

    throw error
  }

  return {
    bundleDigest: loaded.manifest.digest,
    codexHome,
    home,
    mcpToolsPath,
    root,
    workspace
  }
}

/** Compares two validated harness identities without exposing their contents. */
export async function diffHarnessBundles(
  leftBundle: string,
  rightBundle: string
): Promise<HarnessBundleDiff> {
  const [leftLoaded, rightLoaded] = await Promise.all([
    loadBundle(leftBundle, {
      requireAddressName: true,
      requireEffectiveConfig: true,
      requireImmutable: true
    }),
    loadBundle(rightBundle, {
      requireAddressName: true,
      requireEffectiveConfig: true,
      requireImmutable: true
    })
  ])

  const left = leftLoaded.manifest
  const right = rightLoaded.manifest
  const identityDifferences: HarnessIdentityDifference[] = []

  if (left.harness_id !== right.harness_id) {
    identityDifferences.push({
      field: 'harness_id',
      left: left.harness_id,
      right: right.harness_id
    })
  }

  if (left.revision !== right.revision) {
    identityDifferences.push({
      field: 'revision',
      left: left.revision,
      right: right.revision
    })
  }

  const leftEntries = new Map(left.entries.map((entry) => [entry.path, entry]))
  const rightEntries = new Map(right.entries.map((entry) => [entry.path, entry]))

  const paths = [...new Set([...leftEntries.keys(), ...rightEntries.keys()])].sort(
    compareText
  )

  const entryDifferences: HarnessEntryDifference[] = []

  for (const path of paths) {
    const leftEntry = leftEntries.get(path)
    const rightEntry = rightEntries.get(path)

    if (leftEntry === undefined && rightEntry !== undefined) {
      entryDifferences.push({
        entry: rightEntry,
        kind: 'added'
      })
    } else if (leftEntry !== undefined && rightEntry === undefined) {
      entryDifferences.push({
        entry: leftEntry,
        kind: 'removed'
      })
    } else if (
      leftEntry !== undefined &&
      rightEntry !== undefined &&
      (leftEntry.digest !== rightEntry.digest || leftEntry.kind !== rightEntry.kind)
    ) {
      entryDifferences.push({
        kind: 'modified',
        left: leftEntry,
        path,
        right: rightEntry
      })
    }
  }

  const different =
    identityDifferences.length !== 0 || entryDifferences.length !== 0

  return {
    different,
    entryDifferences,
    identityDifferences,
    left,
    right
  }
}
