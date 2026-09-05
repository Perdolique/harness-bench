import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { HarnessError } from './errors.ts'
import type { HarnessEntryKind } from './types.ts'

const TOP_LEVEL_ENTRIES = new Set([
  'AGENTS.md',
  'AGENTS.override.md',
  'config.toml',
  'mcp-tools.json',
  'rules',
  'skills'
])

const FORBIDDEN_DIRECTORY_NAMES = new Set([
  '.cache',
  '.git',
  '.hg',
  '.svn',
  '__pycache__',
  'archived_sessions',
  'cache',
  'caches',
  'history',
  'log',
  'logs',
  'node_modules',
  'rollouts',
  'session',
  'sessions'
])

const FORBIDDEN_FILE_NAMES = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'auth.json',
  'credentials.json',
  'credentials.toml',
  'history.jsonl',
  'id_ed25519',
  'id_rsa',
  'secrets.json',
  'secrets.toml',
  'session_index.json',
  'token.json'
])

const FORBIDDEN_SECRET_EXTENSIONS = new Set(['.key', '.p12', '.pem', '.pfx'])

const SECRET_CONTENT_PATTERNS = [
  {
    id: 'private-key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
  },
  {
    id: 'authorization-header',
    pattern: /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/i
  },
  {
    id: 'provider-token',

    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{20,})\b/
  },
  {
    id: 'credential-assignment',

    pattern:
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|[^\s"',}\]\r\n]{8,})/i
  }
] as const

const FORBIDDEN_CONFIG_KEYS = new Set([
  'access_token',
  'api_key',
  'bearer_token',
  'client_secret',
  'env_http_headers',
  'env_key',
  'experimental_bearer_token',
  'http_headers',
  'mcp_servers',
  'notify',
  'password',
  'query_params',
  'refresh_token'
])

const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/

const CREDENTIAL_ARGUMENT_PATTERN =
  /^(?:--)?(?:api[-_]?key|access[-_]?token|authorization|bearer|client[-_]?secret|header|password|refresh[-_]?token|secret|token)(?:=|$)/i

const CREDENTIAL_NAME_PATTERN =
  /^(?:api[-_]?key|access[-_]?token|authorization|bearer|client[-_]?secret|password|refresh[-_]?token|secret|token)$/i

const CODEX_STATE_DATABASE_PATTERN =
  /^(?:goals|history|logs|memories|queue|state|thread_history)_\d+\.sqlite(?:-(?:shm|wal))?$/

export interface CapturedSourceEntry {
  readonly contents: Buffer;
  readonly digest: string;
  readonly kind: HarnessEntryKind;
  readonly path: string;
}

export interface HarnessSourceSnapshot {
  readonly entries: readonly CapturedSourceEntry[];
}

interface DiscoveredSourceEntry {
  readonly absolutePath: string;
  readonly kind: HarnessEntryKind;
  readonly path: string;
}

interface McpServerBase {
  readonly name: string;
  readonly transport: string;
}

function digest(contents: Uint8Array): string {
  const hex = createHash('sha256').update(contents).digest('hex')

  return `sha256:${hex}`
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function canonicalRelativePath(root: string, absolutePath: string): string {
  const path = relative(root, absolutePath)

  assertCanonicalPath(path)

  return path
}

function assertCanonicalPath(path: string): void {
  const segments = path.split('/')

  if (
    path === '' ||
    path.startsWith('/') ||
    path.includes('\\') ||
    hasAsciiControl(path) ||
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..'
    )
  ) {
    const displayPath = JSON.stringify(path)

    throw new HarnessError(
      'FORBIDDEN_PATH',
      `Unsafe harness path: ${displayPath}`,
      { path }
    )
  }

  for (const segment of segments) {
    if (segment !== segment.normalize('NFC')) {
      throw new HarnessError(
        'FORBIDDEN_PATH',
        `Harness path is not NFC-normalized: ${path}`,
        { path }
      )
    }
  }
}

function assertAllowedPathName(path: string, directory: boolean): void {
  const name = basename(path).toLowerCase()

  const secretCheck = SECRET_CONTENT_PATTERNS.find(({ pattern }) =>
    pattern.test(path)
  )

  if (secretCheck !== undefined) {
    throw new HarnessError(
      'SECRET_DETECTED',
      `Secret-like harness path detected [${secretCheck.id}]`
    )
  }

  if (directory && FORBIDDEN_DIRECTORY_NAMES.has(name)) {
    throw new HarnessError(
      'FORBIDDEN_PATH',
      `Forbidden harness directory [known-state-path]: ${path}`,
      { path }
    )
  }

  const extensionIndex = name.lastIndexOf('.')
  const extension = extensionIndex === -1 ? '' : name.slice(extensionIndex)

  const secretLikeName =
    FORBIDDEN_FILE_NAMES.has(name) ||
    name.startsWith('.env.') ||
    FORBIDDEN_SECRET_EXTENSIONS.has(extension) ||
    CODEX_STATE_DATABASE_PATTERN.test(name)

  if (!directory && secretLikeName) {
    throw new HarnessError(
      'SECRET_DETECTED',
      `Forbidden harness file [secret-like-path]: ${path}`,
      { path }
    )
  }
}

export function validateHarnessEntryPath(path: string): void {
  assertCanonicalPath(path)

  const segments = path.split('/')

  for (let index = 1; index < segments.length; index += 1) {
    const directory = segments.slice(0, index).join('/')

    assertAllowedPathName(directory, true)
  }

  assertAllowedPathName(path, false)
}

async function assertDirectory(path: string, displayPath: string): Promise<void> {
  let metadata

  try {
    metadata = await lstat(path)
  } catch (error) {
    throw new HarnessError(
      'INVALID_SOURCE',
      `Required harness directory is unavailable: ${displayPath}`,
      {
        cause: error,
        path: displayPath
      }
    )
  }

  if (metadata.isSymbolicLink()) {
    throw new HarnessError(
      'FORBIDDEN_PATH',
      `Harness symlink is forbidden: ${displayPath}`,
      { path: displayPath }
    )
  }

  if (!metadata.isDirectory()) {
    throw new HarnessError(
      'INVALID_SOURCE',
      `Expected a harness directory: ${displayPath}`,
      { path: displayPath }
    )
  }
}

async function assertRegularFile(
  path: string,
  displayPath: string
): Promise<void> {
  let metadata

  try {
    metadata = await lstat(path)
  } catch (error) {
    throw new HarnessError(
      'INVALID_SOURCE',
      `Required harness file is unavailable: ${displayPath}`,
      {
        cause: error,
        path: displayPath
      }
    )
  }

  if (metadata.isSymbolicLink()) {
    throw new HarnessError(
      'FORBIDDEN_PATH',
      `Harness symlink is forbidden: ${displayPath}`,
      { path: displayPath }
    )
  }

  if (!metadata.isFile()) {
    throw new HarnessError(
      'INVALID_SOURCE',
      `Expected a regular harness file: ${displayPath}`,
      { path: displayPath }
    )
  }
}

async function walkSkillDirectory(
  root: string,
  directory: string,
  discovered: DiscoveredSourceEntry[]
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })

  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name)
    const path = canonicalRelativePath(root, absolutePath)
    const metadata = await lstat(absolutePath)

    if (metadata.isSymbolicLink()) {
      throw new HarnessError(
        'FORBIDDEN_PATH',
        `Harness symlink is forbidden: ${path}`,
        { path }
      )
    }

    if (metadata.isDirectory()) {
      assertAllowedPathName(path, true)
      await walkSkillDirectory(root, absolutePath, discovered)

      continue
    }

    if (!metadata.isFile()) {
      throw new HarnessError(
        'INVALID_SOURCE',
        `Expected a regular harness file: ${path}`,
        { path }
      )
    }

    validateHarnessEntryPath(path)

    discovered.push({
      absolutePath,
      kind: 'skill',
      path
    })
  }
}

async function discoverSkills(
  root: string,
  skillsDirectory: string,
  discovered: DiscoveredSourceEntry[]
): Promise<void> {
  await assertDirectory(skillsDirectory, 'skills')

  const skills = await readdir(skillsDirectory, { withFileTypes: true })

  for (const skill of skills) {
    const skillDirectory = resolve(skillsDirectory, skill.name)
    const skillPath = canonicalRelativePath(root, skillDirectory)

    assertAllowedPathName(skillPath, true)
    await assertDirectory(skillDirectory, skillPath)

    const skillEntrypoint = resolve(skillDirectory, 'SKILL.md')
    const entrypointPath = canonicalRelativePath(root, skillEntrypoint)

    await assertRegularFile(skillEntrypoint, entrypointPath)
    await walkSkillDirectory(root, skillDirectory, discovered)
  }
}

async function discoverRules(
  root: string,
  rulesDirectory: string,
  discovered: DiscoveredSourceEntry[]
): Promise<void> {
  await assertDirectory(rulesDirectory, 'rules')

  const rules = await readdir(rulesDirectory, { withFileTypes: true })

  for (const rule of rules) {
    const absolutePath = resolve(rulesDirectory, rule.name)
    const path = canonicalRelativePath(root, absolutePath)

    await assertRegularFile(absolutePath, path)

    if (!rule.name.endsWith('.rules')) {
      throw new HarnessError(
        'INVALID_SOURCE',
        `Only flat *.rules policy files are supported: ${path}`,
        { path }
      )
    }

    validateHarnessEntryPath(path)

    discovered.push({
      absolutePath,
      kind: 'policy',
      path
    })
  }
}

function assertNoPathCollisions(entries: readonly DiscoveredSourceEntry[]): void {
  const paths = new Map<string, string>()

  for (const entry of entries) {
    const folded = entry.path.toLowerCase()
    const existing = paths.get(folded)

    if (existing !== undefined && existing !== entry.path) {
      throw new HarnessError(
        'FORBIDDEN_PATH',
        `Harness paths collide under case folding: ${existing}, ${entry.path}`,
        { path: entry.path }
      )
    }

    paths.set(folded, entry.path)
  }
}

async function discoverSource(root: string): Promise<DiscoveredSourceEntry[]> {
  await assertDirectory(root, '.')

  const topLevel = await readdir(root, { withFileTypes: true })
  const names = new Set(topLevel.map(({ name }) => name))

  for (const entry of topLevel) {
    const absolutePath = resolve(root, entry.name)
    const metadata = await lstat(absolutePath)

    if (metadata.isSymbolicLink()) {
      throw new HarnessError(
        'FORBIDDEN_PATH',
        `Harness symlink is forbidden: ${entry.name}`,
        { path: entry.name }
      )
    }

    assertAllowedPathName(entry.name, metadata.isDirectory())

    if (!TOP_LEVEL_ENTRIES.has(entry.name)) {
      throw new HarnessError(
        'INVALID_SOURCE',
        `Unsupported top-level harness entry: ${entry.name}`,
        { path: entry.name }
      )
    }
  }

  for (const required of ['config.toml', 'mcp-tools.json']) {
    if (!names.has(required)) {
      throw new HarnessError(
        'INVALID_SOURCE',
        `Required harness file is missing: ${required}`,
        { path: required }
      )
    }
  }

  const discovered: DiscoveredSourceEntry[] = []

  for (const file of ['AGENTS.md', 'AGENTS.override.md'] as const) {
    if (names.has(file)) {
      const absolutePath = resolve(root, file)

      await assertRegularFile(absolutePath, file)

      discovered.push({
        absolutePath,
        kind: 'agents_md',
        path: file
      })
    }
  }

  for (const [file, kind] of [
    ['config.toml', 'codex_config'],
    ['mcp-tools.json', 'mcp_tools']
  ] as const) {
    const absolutePath = resolve(root, file)

    await assertRegularFile(absolutePath, file)

    discovered.push({
      absolutePath,
      kind,
      path: file
    })
  }

  if (names.has('skills')) {
    await discoverSkills(root, resolve(root, 'skills'), discovered)
  }

  if (names.has('rules')) {
    await discoverRules(root, resolve(root, 'rules'), discovered)
  }

  assertNoPathCollisions(discovered)

  discovered.sort((left, right) => {
    const pathOrder = compareText(left.path, right.path)

    return pathOrder === 0 ? compareText(left.kind, right.kind) : pathOrder
  })

  return discovered
}

function assertNoSecretContent(entry: CapturedSourceEntry): void {
  const source = entry.contents.toString('utf8')

  for (const check of SECRET_CONTENT_PATTERNS) {
    if (check.pattern.test(source)) {
      throw new HarnessError(
        'SECRET_DETECTED',
        `Secret-like content detected [${check.id}]: ${entry.path}`,
        { path: entry.path }
      )
    }
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string
): void {
  const extra = Object.keys(value).find((key) => !allowed.has(key))

  if (extra !== undefined) {
    throw new HarnessError(
      'INVALID_CONFIG',
      `Unsupported MCP field at ${path}: ${extra}`,
      { path: 'mcp-tools.json' }
    )
  }
}

function parseMcpServerBase(
  value: Record<string, unknown>,
  index: number
): McpServerBase {
  if (typeof value.name !== 'string' || !IDENTIFIER_PATTERN.test(value.name)) {
    throw new HarnessError(
      'INVALID_CONFIG',
      `MCP server ${index} has an invalid name`,
      { path: 'mcp-tools.json' }
    )
  }

  if (typeof value.transport !== 'string') {
    throw new HarnessError(
      'INVALID_CONFIG',
      `MCP server ${index} has an invalid transport`,
      { path: 'mcp-tools.json' }
    )
  }

  return {
    name: value.name,
    transport: value.transport
  }
}

function isSafeMcpArguments(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (argument) =>
        typeof argument === 'string' && !hasAsciiControl(argument)
    )
  )
}

function assertStdioServer(
  value: Record<string, unknown>,
  index: number
): void {
  assertExactKeys(
    value,
    new Set(['args', 'command', 'name', 'transport']),
    `mcp_servers[${index}]`
  )

  if (
    typeof value.command !== 'string' ||
    value.command.length === 0 ||
    hasAsciiControl(value.command)
  ) {
    throw new HarnessError(
      'INVALID_CONFIG',
      `MCP stdio server ${index} has an invalid command`,
      { path: 'mcp-tools.json' }
    )
  }

  const arguments_ = value.args ?? []

  if (!isSafeMcpArguments(arguments_)) {
    throw new HarnessError(
      'INVALID_CONFIG',
      `MCP stdio server ${index} has invalid args`,
      { path: 'mcp-tools.json' }
    )
  }

  if (
    arguments_.some(
      (argument) =>
        CREDENTIAL_ARGUMENT_PATTERN.test(argument) ||
        /\b(?:bearer|basic)\s+\S+/i.test(argument)
    )
  ) {
    throw new HarnessError(
      'SECRET_DETECTED',
      `Credential-bearing MCP argument detected: mcp_servers[${index}]`,
      { path: 'mcp-tools.json' }
    )
  }
}

function assertRemoteServer(
  value: Record<string, unknown>,
  index: number
): void {
  assertExactKeys(
    value,
    new Set(['name', 'transport', 'url']),
    `mcp_servers[${index}]`
  )

  if (typeof value.url !== 'string') {
    throw new HarnessError(
      'INVALID_CONFIG',
      `MCP remote server ${index} has an invalid URL`,
      { path: 'mcp-tools.json' }
    )
  }

  let url

  try {
    url = new URL(value.url)
  } catch (error) {
    throw new HarnessError(
      'INVALID_CONFIG',
      `MCP remote server ${index} has an invalid URL`,
      {
        cause: error,
        path: 'mcp-tools.json'
      }
    )
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new HarnessError(
      'SECRET_DETECTED',
      `Credential-bearing or unsupported MCP URL: mcp_servers[${index}]`,
      { path: 'mcp-tools.json' }
    )
  }
}

function validateMcpTools(contents: Buffer): void {
  let document: unknown

  try {
    document = JSON.parse(contents.toString('utf8'))
  } catch (error) {
    throw new HarnessError('INVALID_CONFIG', 'mcp-tools.json is invalid JSON', {
      cause: error,
      path: 'mcp-tools.json'
    })
  }

  if (!isRecord(document)) {
    throw new HarnessError(
      'INVALID_CONFIG',
      'mcp-tools.json must contain an object',
      { path: 'mcp-tools.json' }
    )
  }

  assertExactKeys(document, new Set(['mcp_servers']), 'mcp-tools.json')

  if (!Array.isArray(document.mcp_servers)) {
    throw new HarnessError(
      'INVALID_CONFIG',
      'mcp-tools.json must contain an mcp_servers array',
      { path: 'mcp-tools.json' }
    )
  }

  const names = new Set<string>()

  for (const [index, value] of document.mcp_servers.entries()) {
    if (!isRecord(value)) {
      throw new HarnessError(
        'INVALID_CONFIG',
        `MCP server ${index} must be an object`,
        { path: 'mcp-tools.json' }
      )
    }

    const server = parseMcpServerBase(value, index)

    if (names.has(server.name)) {
      throw new HarnessError(
        'INVALID_CONFIG',
        `Duplicate MCP server name: ${server.name}`,
        { path: 'mcp-tools.json' }
      )
    }

    names.add(server.name)

    if (server.transport === 'stdio') {
      assertStdioServer(value, index)
    } else if (
      server.transport === 'sse' ||
      server.transport === 'streamable-http'
    ) {
      assertRemoteServer(value, index)
    } else {
      throw new HarnessError(
        'INVALID_CONFIG',
        `Unsupported MCP transport: ${server.transport}`,
        { path: 'mcp-tools.json' }
      )
    }
  }
}

function assertSafeConfigUrl(value: string, path: readonly string[]): void {
  let url: URL

  try {
    url = new URL(value)
  } catch {
    return
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return
  }

  const credentialQuery = [...url.searchParams.keys()].some((key) =>
    CREDENTIAL_NAME_PATTERN.test(key)
  )

  if (url.username === '' && url.password === '' && !credentialQuery) {
    return
  }

  const displayPath = path.join('.')

  throw new HarnessError(
    'SECRET_DETECTED',
    `Credential-bearing Codex URL detected: ${displayPath}`,
    { path: 'config.toml' }
  )
}

function assertSafeConfigValue(value: unknown, path: readonly string[]): void {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      assertSafeConfigValue(child, [...path, String(index)])
    }

    return
  }

  if (typeof value === 'string') {
    assertSafeConfigUrl(value, path)

    return
  }

  if (!isRecord(value)) {
    return
  }

  for (const [key, child] of Object.entries(value)) {
    const keyPath = [...path, key]
    const normalizedKey = key.toLowerCase().replaceAll('-', '_')
    const topLevelPluginState = path.length === 0 && normalizedKey === 'plugins'
    const topLevelProjectState = path.length === 0 && normalizedKey === 'projects'

    const fileReference = /(?:^|_)(?:dir|directory|file|path)$/.test(
      normalizedKey
    )

    if (
      topLevelPluginState ||
      topLevelProjectState ||
      FORBIDDEN_CONFIG_KEYS.has(normalizedKey) ||
      fileReference
    ) {
      const displayPath = keyPath.join('.')

      throw new HarnessError(
        'INVALID_CONFIG',
        `Unsupported ambient or credential-bearing Codex setting: ${displayPath}`,
        { path: 'config.toml' }
      )
    }

    assertSafeConfigValue(child, keyPath)
  }
}

function validateCodexConfig(contents: Buffer): void {
  let document: unknown

  try {
    document = parseToml(contents.toString('utf8'))
  } catch (error) {
    throw new HarnessError('INVALID_CONFIG', 'config.toml is invalid TOML', {
      cause: error,
      path: 'config.toml'
    })
  }

  assertSafeConfigValue(document, [])
}

export async function readHarnessSource(
  source: string
): Promise<HarnessSourceSnapshot> {
  const root = resolve(source)
  const discovered = await discoverSource(root)
  const entries: CapturedSourceEntry[] = []

  for (const entry of discovered) {
    let handle

    try {
      handle = await open(
        entry.absolutePath,
        constants.O_RDONLY | constants.O_NOFOLLOW
      )

      const before = await handle.stat()
      const contents = await handle.readFile()
      const after = await handle.stat()
      const pathMetadata = await lstat(entry.absolutePath)

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
          'SOURCE_CHANGED',
          `Harness source changed while reading: ${entry.path}`,
          { path: entry.path }
        )
      }

      entries.push({
        contents,
        digest: digest(contents),
        kind: entry.kind,
        path: entry.path
      })
    } catch (error) {
      if (error instanceof HarnessError) {
        throw error
      }

      throw new HarnessError(
        'SOURCE_CHANGED',
        `Harness source changed while reading: ${entry.path}`,
        {
          cause: error,
          path: entry.path
        }
      )
    } finally {
      await handle?.close()
    }
  }

  return { entries }
}

export function validateHarnessSourceContent(
  snapshot: HarnessSourceSnapshot
): void {
  for (const entry of snapshot.entries) {
    assertNoSecretContent(entry)
  }

  const config = snapshot.entries.find(({ path }) => path === 'config.toml')

  const mcpTools = snapshot.entries.find(
    ({ path }) => path === 'mcp-tools.json'
  )

  if (config === undefined || mcpTools === undefined) {
    throw new HarnessError(
      'INVALID_SOURCE',
      'Harness source is missing required configuration files'
    )
  }

  validateCodexConfig(config.contents)
  validateMcpTools(mcpTools.contents)
}

export function snapshotsMatch(
  left: HarnessSourceSnapshot,
  right: HarnessSourceSnapshot
): boolean {
  if (left.entries.length !== right.entries.length) {
    return false
  }

  return left.entries.every((entry, index) => {
    const other = right.entries[index]

    return (
      other !== undefined &&
      entry.path === other.path &&
      entry.kind === other.kind &&
      entry.digest === other.digest
    )
  })
}
