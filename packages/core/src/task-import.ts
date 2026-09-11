import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'

import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import * as v from 'valibot'

import {
  GitCommitSchema,
  IdentifierSchema,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  TimestampSchema
} from '../../schemas/src/primitives.ts'

import { CREDENTIAL_PATTERN_SCANNER_REVISION, scanCredentialBytes, scanCredentialTree } from './secret-scan.ts'

import {
  inspectMaterializedTaskWorkspace,
  inspectTaskSource,
  materializeTaskWorkspace,
  type TaskTreeEntry
} from './task.ts'

const SHA256_PREFIX = 'sha256:'
const DEFAULT_PRIVATE_RETENTION_DAYS = 90
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024
const MAX_SOURCE_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_SOURCE_FILES = 10_000
const ADDRESS_PATTERN = /^[a-f0-9]{64}$/

const IGNORED_IMPORT_SEGMENTS = new Set([
  '.ds_store',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results'
])

const SECRET_IMPORT_NAMES = new Set([
  '.env',
  '.git',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'auth.json',
  'credentials.json',
  'id_rsa',
  'id_ed25519'
])

const SENSITIVE_IMPORT_NAME_PATTERN =
  /^(?:secrets?|credentials?|tokens?)(?:\.(?:env|json|toml|txt|ya?ml))?$/

const SENSITIVE_IMPORT_EXTENSION_PATTERN = /\.(?:pem|key|p12|pfx)$/
const SAFE_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

const UNSAFE_METADATA_LOCATION_PATTERN =
  /(?:[a-z][a-z0-9+.-]*:\/\/|file:\/|(?:^|\s)(?:\/(?:Users|home|private|tmp|var)\/|[A-Za-z]:[\\/]))/i

const AbsolutePathSchema = v.pipe(
  NonEmptyStringSchema,
  v.maxLength(4096),
  v.check(isAbsolute, 'Expected an absolute path')
)

const SafeIdentifierSchema = v.pipe(
  IdentifierSchema,
  v.maxLength(100),
  v.check(isSafeRetainedMetadata, 'Identifier contains unsafe retained metadata')
)

const SafeRevisionSchema = v.pipe(
  NonEmptyStringSchema,
  v.regex(SAFE_REVISION_PATTERN, 'Revision must be a short identifier'),
  v.check(isSafeRetainedMetadata, 'Revision contains unsafe retained metadata')
)

const SafeReasonSchema = v.pipe(
  NonEmptyStringSchema,
  v.maxLength(500),
  v.check((value) => !hasAsciiControl(value), 'Reason contains control characters'),
  v.check(isSafeRetainedMetadata, 'Reason contains unsafe retained metadata'),
  v.check(
    (value) => !UNSAFE_METADATA_LOCATION_PATTERN.test(value),
    'Reason must not contain a URL or absolute path'
  )
)

const MergedPullRequestSchema = v.union([
  v.strictObject({ status: v.literal('not_applicable') }),
  v.strictObject({
    status: v.literal('known'),
    number: PositiveIntegerSchema,
    merge_commit: GitCommitSchema
  })
])

const DefinitionRetentionSchema = v.union([
  v.strictObject({ classification: v.literal('public') }),
  v.strictObject({
    classification: v.literal('private'),

    expires_at: v.union([
      v.strictObject({ status: v.literal('default') }),
      v.strictObject({
        status: v.literal('known'),
        value: TimestampSchema
      })
    ])
  })
])

const ManifestRetentionSchema = v.union([
  v.strictObject({
    classification: v.literal('public'),

    expires_at: v.strictObject({
      status: v.literal('not_applicable'),
      reason: v.literal('Public task source does not expire')
    })
  }),
  v.strictObject({
    classification: v.literal('private'),
    default_days: v.literal(90),
    expires_at: TimestampSchema
  })
])

const TaskImportReservationSchema = v.strictObject({
  document_type: v.literal('task_import_reservation'),
  schema_version: v.literal(1),
  import_digest: Sha256Schema,
  operation: v.picklist(['import', 'validate', 'materialize', 'dispose']),
  owner_pid: PositiveIntegerSchema,
  state: v.picklist(['active', 'recovery_required']),

  phase: v.picklist([
    'not_applicable',
    'reserved',
    'tombstone-staged',
    'moved',
    'deleted',
    'tombstone-installed'
  ])
})

const InventoryEntrySchema = v.strictObject({
  digest: Sha256Schema,
  executable: v.boolean(),
  path: NonEmptyStringSchema,
  size: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_SOURCE_FILE_BYTES))
})

export const TaskImportDefinitionV1Schema = v.strictObject({
  document_type: v.literal('task_import_definition'),
  schema_version: v.literal(1),
  task_id: SafeIdentifierSchema,
  task_revision: SafeRevisionSchema,
  repository_path: AbsolutePathSchema,
  base_commit: GitCommitSchema,

  provenance: v.strictObject({
    repository_id: SafeIdentifierSchema,

    merged_pull_request: v.optional(MergedPullRequestSchema, {
      status: 'not_applicable'
    })
  }),

  online_reachability: v.strictObject({
    status: v.picklist(['eligible', 'ineligible']),
    reason: SafeReasonSchema
  }),

  retention: DefinitionRetentionSchema
})

const TaskImportManifestPreimageV1Schema = v.strictObject({
  document_type: v.literal('task_import'),
  schema_version: v.literal(1),
  created_at: TimestampSchema,
  task_id: SafeIdentifierSchema,
  task_revision: SafeRevisionSchema,

  provenance: v.strictObject({
    repository_id: SafeIdentifierSchema,
    base_commit: GitCommitSchema,
    merged_pull_request: MergedPullRequestSchema
  }),

  source_digest: Sha256Schema,
  materialized_base_commit: GitCommitSchema,

  inventory: v.pipe(
    v.array(InventoryEntrySchema),
    v.minLength(1),
    v.maxLength(MAX_SOURCE_FILES),
    v.check(
      (entries) => entries.reduce((total, entry) => total + entry.size, 0) <= MAX_SOURCE_TOTAL_BYTES,
      'Source inventory exceeds the import size limit'
    )
  ),

  credential_scanner_revision: v.literal(CREDENTIAL_PATTERN_SCANNER_REVISION),

  online_reachability: v.strictObject({
    status: v.picklist(['eligible', 'ineligible']),
    reason: SafeReasonSchema
  }),

  retention: ManifestRetentionSchema
})

export const TaskImportManifestV1Schema = v.strictObject({
  ...TaskImportManifestPreimageV1Schema.entries,
  import_digest: Sha256Schema
})

const TaskImportTombstonePreimageV1Schema = v.strictObject({
  document_type: v.literal('task_import_tombstone'),
  schema_version: v.literal(1),
  task_id: SafeIdentifierSchema,
  task_revision: SafeRevisionSchema,
  repository_id: SafeIdentifierSchema,
  import_digest: Sha256Schema,
  source_digest: Sha256Schema,
  disposed_at: TimestampSchema,
  reason: v.picklist(['owner-request', 'retention-expired', 'credential-detected']),

  credential_action: v.union([
    v.strictObject({ status: v.literal('not_applicable') }),
    v.strictObject({
      status: v.literal('known'),
      value: v.picklist(['rotated', 'revoked'])
    })
  ]),

  owner_attestation: v.literal('confirmed'),
  external_repositories: v.literal('not_managed'),
  backups: v.literal('not_managed')
})

export const TaskImportTombstoneV1Schema = v.strictObject({
  ...TaskImportTombstonePreimageV1Schema.entries,
  tombstone_digest: Sha256Schema
})

export type TaskImportDefinitionV1 = v.InferOutput<typeof TaskImportDefinitionV1Schema>
export type TaskImportManifestV1 = v.InferOutput<typeof TaskImportManifestV1Schema>
export type TaskImportTombstoneV1 = v.InferOutput<typeof TaskImportTombstoneV1Schema>

export type TaskImportDisposeReason =
  | 'owner-request'
  | 'retention-expired'
  | 'credential-detected'

export type TaskImportCredentialAction = 'rotated' | 'revoked'

export interface ImportTaskSourceOptions {
  readonly definition: string;
  readonly store: string;
  readonly now?: () => Date;
}

export interface ActiveTaskImportValidation {
  readonly importPath: string;
  readonly kind: 'active';
  readonly manifest: TaskImportManifestV1;
}

export interface TombstoneTaskImportValidation {
  readonly importPath: string;
  readonly kind: 'tombstone';
  readonly tombstone: TaskImportTombstoneV1;
}

export type ValidateTaskImportResult =
  | ActiveTaskImportValidation
  | TombstoneTaskImportValidation

export interface MaterializeTaskImportOptions {
  readonly destination: string;
  readonly importPath: string;
}

export interface DisposeTaskImportTestHooks {
  readonly afterReservation?: () => void | Promise<void>;
  readonly afterMove?: () => void | Promise<void>;
  readonly afterDelete?: () => void | Promise<void>;
  readonly beforeReservationRelease?: () => void | Promise<void>;
}

export interface DisposeTaskImportOptions {
  readonly confirmImportDigest: string;
  readonly reason: TaskImportDisposeReason;
  readonly credentialAction?: TaskImportCredentialAction;
  readonly now?: () => Date;
  readonly testHooks?: DisposeTaskImportTestHooks;
}

export interface RecoverTaskImportDisposalOptions {
  readonly confirmImportDigest: string;
}

export const TASK_IMPORT_ERROR_CODES = [
  'INVALID_DEFINITION',
  'INVALID_REPOSITORY',
  'INELIGIBLE_SOURCE',
  'CREDENTIAL_DETECTED',
  'INVALID_IMPORT',
  'IMPORT_CONFLICT',
  'INVALID_LIFECYCLE'
] as const

export type TaskImportErrorCode = (typeof TASK_IMPORT_ERROR_CODES)[number]

export interface TaskImportErrorOptions {
  readonly cause?: unknown;
}

export class TaskImportError extends Error {
  readonly code: TaskImportErrorCode

  constructor(
    code: TaskImportErrorCode,
    message: string,
    options: TaskImportErrorOptions = {}
  ) {
    super(message, options)

    this.name = 'TaskImportError'
    this.code = code
  }
}

export function isTaskImportError(error: unknown): error is TaskImportError {
  return error instanceof TaskImportError
}

interface GitTreeEntry {
  readonly contents: Buffer;
  readonly entry: TaskTreeEntry;
}

interface TaskImportLocation {
  readonly address: string;
  readonly importPath: string;
  readonly recoveryClaimPath: string;
  readonly reservationPath: string;
  readonly sourceRecoveryPath: string;
  readonly store: string;
  readonly tombstoneRecoveryPath: string;
}

type AddressReservation = Awaited<ReturnType<typeof open>>

type AddressReservationOperation = v.InferOutput<
  typeof TaskImportReservationSchema
>['operation']

type ActiveValidationLevel = 'full' | 'metadata'

type DisposalPhase =
  | 'reserved'
  | 'tombstone-staged'
  | 'moved'
  | 'deleted'
  | 'tombstone-installed'

function hasAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0

    return code < 0x20 || code === 0x7f
  })
}

function isSafeRetainedMetadata(value: string): boolean {
  const findings = scanCredentialBytes(Buffer.from(value), { path: '[metadata]' })

  return findings.length === 0
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256(contents: Uint8Array | string): string {
  return `${SHA256_PREFIX}${createHash('sha256').update(contents).digest('hex')}`
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path)
    .then(() => true)
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false

      throw error
    })
}

function digestDocument(value: object): string {
  return sha256(JSON.stringify(value))
}

function assertSerializedMetadataSafe(
  value: object,
  code: TaskImportErrorCode,
  message: string
): void {
  const serialized = Buffer.from(JSON.stringify(value))
  const findings = scanCredentialBytes(serialized, { path: '[metadata]' })

  if (serialized.byteLength > MAX_METADATA_BYTES || findings.length > 0) {
    throw new TaskImportError(code, message)
  }
}

function safeParse<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  schema: TSchema,
  candidate: unknown,
  code: TaskImportErrorCode,
  message: string
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, candidate)

  if (!result.success) {
    throw new TaskImportError(code, message)
  }

  return result.output
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
  )

  return {
    ...environment,
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1'
  }
}

function runGitBuffer(repository: string, arguments_: readonly string[]): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'git',
      ['--no-pager', ...arguments_],
      {
        cwd: repository,
        encoding: 'buffer',
        env: isolatedGitEnvironment(),
        maxBuffer: MAX_SOURCE_FILE_BYTES
      },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(error)

          return
        }

        resolvePromise(Buffer.from(stdout))
      }
    )
  })
}

async function runGitText(repository: string, arguments_: readonly string[]): Promise<string> {
  const output = await runGitBuffer(repository, arguments_)

  return output.toString('utf8').trim()
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)

  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function hasInvalidImportSegment(segments: readonly string[]): boolean {
  return segments.some(
    (segment) =>
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment !== segment.normalize('NFC')
  )
}

function hasIgnoredImportSegment(segments: readonly string[]): boolean {
  return segments.some(
    (segment) =>
      IGNORED_IMPORT_SEGMENTS.has(segment) || segment.endsWith('.tsbuildinfo')
  )
}

function hasSensitiveImportSegment(segments: readonly string[]): boolean {
  return segments.some(
    (segment) =>
      SECRET_IMPORT_NAMES.has(segment) ||
      SENSITIVE_IMPORT_NAME_PATTERN.test(segment) ||
      SENSITIVE_IMPORT_EXTENSION_PATTERN.test(segment)
  )
}

function assertSafeImportPath(path: string, caseFolded: Set<string>): void {
  const segments = path.split('/')
  const loweredSegments = segments.map((segment) => segment.toLocaleLowerCase('en-US'))

  const unsafeSyntax =
    path === '' || path.startsWith('/') || path.includes('\\') || hasAsciiControl(path)

  if (
    unsafeSyntax ||
    hasInvalidImportSegment(segments) ||
    hasIgnoredImportSegment(loweredSegments) ||
    hasSensitiveImportSegment(loweredSegments)
  ) {
    throw new TaskImportError('INELIGIBLE_SOURCE', 'Git tree contains an unsafe tracked path')
  }

  const folded = path.normalize('NFC').toLocaleLowerCase('en-US')

  if (caseFolded.has(folded)) {
    throw new TaskImportError('INELIGIBLE_SOURCE', 'Git tree contains colliding tracked paths')
  }

  caseFolded.add(folded)

  if (scanCredentialBytes(Buffer.from(path), { path: '[redacted-path]' }).length > 0) {
    throw new TaskImportError('CREDENTIAL_DETECTED', 'Git tree contains a credential-like path')
  }
}

async function readCommitTree(repository: string, commit: string): Promise<readonly GitTreeEntry[]> {
  let type: string

  try {
    type = await runGitText(repository, ['cat-file', '-t', commit])
  } catch {
    throw new TaskImportError('INVALID_REPOSITORY', 'Base commit is unavailable')
  }

  if (type !== 'commit') {
    throw new TaskImportError('INVALID_REPOSITORY', 'Base revision is not a commit')
  }

  const raw = await runGitBuffer(repository, ['ls-tree', '-rz', '--full-tree', commit])
  let inventory: string

  try {
    inventory = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    throw new TaskImportError('INELIGIBLE_SOURCE', 'Git tree contains a non-UTF-8 path')
  }

  const records = inventory.slice(0, inventory.endsWith('\0') ? -1 : undefined).split('\0')

  if (records.length > MAX_SOURCE_FILES) {
    throw new TaskImportError('INELIGIBLE_SOURCE', 'Git tree contains too many files')
  }

  const caseFolded = new Set<string>()
  const entries: GitTreeEntry[] = []
  let totalBytes = 0

  for (const record of records) {
    const match = /^(\d{6}) ([^ ]+) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record)

    if (match === null) {
      throw new TaskImportError('INVALID_REPOSITORY', 'Git tree inventory is invalid')
    }

    const [, mode, typeName, objectId, path] = match

    if (
      path === undefined ||
      objectId === undefined ||
      typeName !== 'blob' ||
      (mode !== '100644' && mode !== '100755')
    ) {
      throw new TaskImportError('INELIGIBLE_SOURCE', 'Git tree contains an unsupported entry')
    }

    assertSafeImportPath(path, caseFolded)

    let contents: Buffer

    try {
      contents = await runGitBuffer(repository, ['cat-file', 'blob', objectId])
    } catch {
      throw new TaskImportError('INELIGIBLE_SOURCE', 'Git tree file exceeds the import limit')
    }

    totalBytes += contents.byteLength

    if (
      contents.byteLength > MAX_SOURCE_FILE_BYTES ||
      totalBytes > MAX_SOURCE_TOTAL_BYTES
    ) {
      throw new TaskImportError('INELIGIBLE_SOURCE', 'Git tree exceeds the import size limit')
    }

    if (
      contents
        .subarray(0, 200)
        .toString('utf8')
        .startsWith('version https://git-lfs.github.com/spec/v1\n')
    ) {
      throw new TaskImportError('INELIGIBLE_SOURCE', 'Git LFS pointers are not supported')
    }

    if (scanCredentialBytes(contents, { path: '[redacted-path]' }).length > 0) {
      throw new TaskImportError('CREDENTIAL_DETECTED', 'Git tree contains credential-like bytes')
    }

    entries.push({
      contents,

      entry: {
        digest: sha256(contents),
        executable: mode === '100755',
        path,
        size: contents.byteLength
      }
    })
  }

  entries.sort((left, right) => compareText(left.entry.path, right.entry.path))

  if (entries.length === 0) {
    throw new TaskImportError('INELIGIBLE_SOURCE', 'Git tree must contain at least one regular file')
  }

  return entries
}

async function assertMergedPullRequest(
  repository: string,
  definition: TaskImportDefinitionV1
): Promise<void> {
  const pullRequest = definition.provenance.merged_pull_request

  if (pullRequest.status === 'not_applicable') return

  try {
    if (await runGitText(repository, ['cat-file', '-t', pullRequest.merge_commit]) !== 'commit') {
      throw new Error('not a commit')
    }

    await runGitBuffer(repository, [
      'merge-base',
      '--is-ancestor',
      definition.base_commit,
      pullRequest.merge_commit
    ])
  } catch {
    throw new TaskImportError(
      'INVALID_REPOSITORY',
      'Merged pull request ancestry does not contain the selected base commit'
    )
  }

  if (definition.base_commit === pullRequest.merge_commit) {
    throw new TaskImportError('INVALID_REPOSITORY', 'Base commit must precede the merge commit')
  }
}

async function writeSource(root: string, entries: readonly GitTreeEntry[]): Promise<void> {
  await mkdir(root, {
    recursive: true,
    mode: 0o700
  })

  for (const { contents, entry } of entries) {
    const path = resolve(root, entry.path)

    await mkdir(dirname(path), {
      recursive: true,
      mode: 0o700
    })

    await writeFile(path, contents, {
      flag: 'wx',
      mode: entry.executable ? 0o700 : 0o600
    })
  }
}

async function makeReadOnly(root: string, entries: readonly TaskTreeEntry[]): Promise<void> {
  for (const entry of entries) {
    await chmod(resolve(root, entry.path), entry.executable ? 0o500 : 0o400)
  }

  const directories: string[] = [root]

  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const path = resolve(directory, entry.name)

        directories.push(path)
        await collect(path)
      }
    }
  }

  await collect(root)
  directories.sort((left, right) => right.length - left.length)

  for (const directory of directories) await chmod(directory, 0o500)
}

async function makeWritable(root: string): Promise<void> {
  const metadata = await lstat(root).catch(() => undefined)

  if (metadata === undefined || metadata.isSymbolicLink()) return

  if (metadata.isDirectory()) {
    await chmod(root, 0o700)

    for (const entry of await readdir(root)) await makeWritable(resolve(root, entry))
  } else {
    await chmod(root, 0o600)
  }
}

function normalizedRetention(
  definition: TaskImportDefinitionV1,
  createdAt: string
): v.InferOutput<typeof ManifestRetentionSchema> {
  if (definition.retention.classification === 'public') {
    return {
      classification: 'public',

      expires_at: {
        status: 'not_applicable',
        reason: 'Public task source does not expire'
      }
    }
  }

  const expiry = definition.retention.expires_at.status === 'default'
    ? new Date(new Date(createdAt).getTime() + DEFAULT_PRIVATE_RETENTION_DAYS * DAY_MILLISECONDS)
      .toISOString()
    : definition.retention.expires_at.value

  if (new Date(expiry).getTime() <= new Date(createdAt).getTime()) {
    throw new TaskImportError('INVALID_DEFINITION', 'Private retention expiry must be in the future')
  }

  return {
    classification: 'private',
    default_days: 90,
    expires_at: expiry
  }
}

async function parseJson(path: string, code: TaskImportErrorCode, message: string): Promise<unknown> {
  try {
    const metadata = await lstat(path)

    if (!metadata.isFile() || metadata.size > MAX_METADATA_BYTES) {
      throw new Error('invalid JSON input file')
    }

    const source = await readFile(path, 'utf8')

    return JSON.parse(source) as unknown
  } catch {
    throw new TaskImportError(code, message)
  }
}

async function currentCheckoutRoot(): Promise<string | undefined> {
  try {
    const checkout = await runGitText(process.cwd(), ['rev-parse', '--show-toplevel'])
    const root = await realpath(checkout)

    return root
  } catch {
    return
  }
}

async function sourceCheckoutRoot(repository: string): Promise<string> {
  try {
    const checkout = await runGitText(repository, ['rev-parse', '--show-toplevel'])
    const root = await realpath(checkout)

    return root
  } catch {
    throw new TaskImportError('INVALID_REPOSITORY', 'Source repository worktree is unavailable')
  }
}

async function assertStoreLocation(store: string, sourceCheckout: string): Promise<string> {
  if (!isAbsolute(store)) {
    throw new TaskImportError('INVALID_DEFINITION', 'Import store must be an absolute path')
  }

  const existingMetadata = await lstat(store).catch(() => undefined)

  if (existingMetadata?.isSymbolicLink()) {
    throw new TaskImportError('INVALID_DEFINITION', 'Import store must not be a symbolic link')
  }

  await mkdir(store, {
    recursive: true,
    mode: 0o700
  })

  const root = await realpath(store)
  const metadata = await stat(root)

  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TaskImportError('INVALID_DEFINITION', 'Import store must be a real directory')
  }

  const checkout = await currentCheckoutRoot()

  if (
    isWithin(sourceCheckout, root) ||
    isWithin(root, sourceCheckout) ||
    (checkout !== undefined && isWithin(checkout, root))
  ) {
    throw new TaskImportError(
      'INVALID_DEFINITION',
      'Import store must be outside the source repository and benchmark checkout'
    )
  }

  await chmod(root, 0o700)

  return root
}

async function resolveTaskImportLocation(path: string): Promise<TaskImportLocation> {
  const requestedPath = resolve(path)
  const address = basename(requestedPath)

  if (!ADDRESS_PATTERN.test(address)) {
    throw new TaskImportError('INVALID_IMPORT', 'Task import address is invalid')
  }

  let store: string

  try {
    store = await realpath(dirname(requestedPath))
  } catch {
    throw new TaskImportError('INVALID_IMPORT', 'Task import store is unavailable')
  }

  const importPath = resolve(store, address)

  return {
    address,
    importPath,
    recoveryClaimPath: resolve(store, `.task-import-${address}.recovering`),
    reservationPath: resolve(store, `.task-import-${address}.lock`),
    sourceRecoveryPath: resolve(store, `.task-import-dispose-source-${address}`),
    store,
    tombstoneRecoveryPath: resolve(store, `.task-import-dispose-tombstone-${address}`)
  }
}

function taskImportLocation(store: string, address: string): TaskImportLocation {
  const importPath = resolve(store, address)

  return {
    address,
    importPath,
    recoveryClaimPath: resolve(store, `.task-import-${address}.recovering`),
    reservationPath: resolve(store, `.task-import-${address}.lock`),
    sourceRecoveryPath: resolve(store, `.task-import-dispose-source-${address}`),
    store,
    tombstoneRecoveryPath: resolve(store, `.task-import-dispose-tombstone-${address}`)
  }
}

async function acquireAddressReservation(
  location: TaskImportLocation,
  operation: AddressReservationOperation
): Promise<AddressReservation> {
  let reservation: AddressReservation

  try {
    reservation = await open(location.reservationPath, 'wx', 0o600)
  } catch {
    throw new TaskImportError('IMPORT_CONFLICT', 'Task import address is busy or needs recovery')
  }

  try {
    const record = {
      document_type: 'task_import_reservation',
      schema_version: 1,
      import_digest: `${SHA256_PREFIX}${location.address}`,
      operation,
      owner_pid: process.pid,
      state: 'active',
      phase: operation === 'dispose' ? 'reserved' : 'not_applicable'
    }

    const serialized = `${JSON.stringify(record)}\n`

    await reservation.writeFile(serialized)
    await reservation.sync()

    return reservation
  } catch (error) {
    await reservation.close().catch(() => undefined)
    await rm(location.reservationPath, { force: true }).catch(() => undefined)

    throw new TaskImportError('IMPORT_CONFLICT', 'Task import reservation could not be created', {
      cause: error
    })
  }
}

async function releaseAddressReservation(
  reservation: AddressReservation,
  location: TaskImportLocation
): Promise<void> {
  try {
    await reservation.close()
    await rm(location.reservationPath)
  } catch (error) {
    throw new TaskImportError(
      'IMPORT_CONFLICT',
      'Task import reservation cleanup failed; inspect the stale reservation',
      { cause: error }
    )
  }
}

async function removeAddressReservation(location: TaskImportLocation): Promise<void> {
  try {
    await rm(location.reservationPath)
  } catch (error) {
    throw new TaskImportError(
      'IMPORT_CONFLICT',
      'Task import reservation cleanup failed; run task recover',
      { cause: error }
    )
  }
}

async function closeAddressReservation(reservation: AddressReservation): Promise<void> {
  try {
    await reservation.close()
  } catch (error) {
    throw new TaskImportError(
      'IMPORT_CONFLICT',
      'Task import reservation could not be closed safely',
      { cause: error }
    )
  }
}

async function assertNoRecoveryState(location: TaskImportLocation): Promise<void> {
  const recoveryExists =
    (await pathExists(location.sourceRecoveryPath)) ||
    (await pathExists(location.tombstoneRecoveryPath))

  if (recoveryExists) {
    throw new TaskImportError('IMPORT_CONFLICT', 'Task import address needs recovery')
  }
}

async function withAddressReservation<T>(
  location: TaskImportLocation,
  operationName: AddressReservationOperation,
  operation: () => Promise<T>
): Promise<T> {
  const reservation = await acquireAddressReservation(location, operationName)

  try {
    await assertNoRecoveryState(location)

    const result = await operation()

    return result
  } finally {
    await releaseAddressReservation(reservation, location)
  }
}

export async function importTaskSource(
  options: ImportTaskSourceOptions
): Promise<{ readonly importPath: string; readonly manifest: TaskImportManifestV1 }> {
  const definitionCandidate = await parseJson(
    options.definition,
    'INVALID_DEFINITION',
    'Task import definition is invalid'
  )

  const definition = safeParse(
    TaskImportDefinitionV1Schema,
    definitionCandidate,
    'INVALID_DEFINITION',
    'Task import definition is invalid'
  )

  let repository: string

  try {
    repository = await realpath(definition.repository_path)

    if (!(await stat(repository)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new TaskImportError('INVALID_REPOSITORY', 'Source repository is unavailable')
  }

  if (await runGitText(repository, ['rev-parse', '--show-object-format']) !== 'sha1') {
    throw new TaskImportError('INVALID_REPOSITORY', 'Only SHA-1 Git repositories are supported')
  }

  const sourceCheckout = await sourceCheckoutRoot(repository)
  const store = await assertStoreLocation(options.store, sourceCheckout)

  await assertMergedPullRequest(repository, definition)

  let initialTreeObject: string

  try {
    initialTreeObject = await runGitText(repository, [
      'rev-parse',
      `${definition.base_commit}^{tree}`
    ])
  } catch {
    throw new TaskImportError('INVALID_REPOSITORY', 'Base commit is unavailable')
  }

  const initialTree = await readCommitTree(repository, definition.base_commit)
  const createdAt = (options.now ?? (() => new Date()))().toISOString()
  const staging = await mkdtemp(resolve(store, '.task-import-'))
  const source = resolve(staging, 'source')

  try {
    await writeSource(source, initialTree)

    const sourceScan = await scanCredentialTree({ root: source })

    if (sourceScan.credentialFound || sourceScan.invalidEntries.length > 0) {
      throw new TaskImportError('CREDENTIAL_DETECTED', 'Imported source did not pass credential scanning')
    }

    const sourceSnapshot = await inspectTaskSource(source)
    const expectedEntries = initialTree.map(({ entry }) => entry)

    if (JSON.stringify(sourceSnapshot.entries) !== JSON.stringify(expectedEntries)) {
      throw new TaskImportError('INVALID_REPOSITORY', 'Imported source inventory changed while staging')
    }

    const materialized = await materializeTaskWorkspace({
      destination: resolve(staging, 'materialized'),
      expectedSourceDigest: sourceSnapshot.digest,
      source
    })

    const finalTreeObject = await runGitText(repository, [
      'rev-parse',
      `${definition.base_commit}^{tree}`
    ])

    if (finalTreeObject !== initialTreeObject) {
      throw new TaskImportError('INVALID_REPOSITORY', 'Base commit changed while importing')
    }

    const preimage = safeParse(
      TaskImportManifestPreimageV1Schema,
      {
        document_type: 'task_import',
        schema_version: 1,
        created_at: createdAt,
        task_id: definition.task_id,
        task_revision: definition.task_revision,

        provenance: {
          repository_id: definition.provenance.repository_id,
          base_commit: definition.base_commit,
          merged_pull_request: definition.provenance.merged_pull_request
        },

        source_digest: sourceSnapshot.digest,
        materialized_base_commit: materialized.baseCommit,
        inventory: sourceSnapshot.entries,
        credential_scanner_revision: CREDENTIAL_PATTERN_SCANNER_REVISION,
        online_reachability: definition.online_reachability,
        retention: normalizedRetention(definition, createdAt)
      },
      'INVALID_DEFINITION',
      'Task import definition produces an invalid manifest'
    )

    assertSerializedMetadataSafe(
      preimage,
      'INVALID_DEFINITION',
      'Task import definition contains unsafe retained metadata'
    )

    const manifest = safeParse(
      TaskImportManifestV1Schema,
      {
        ...preimage,
        import_digest: digestDocument(preimage)
      },
      'INVALID_IMPORT',
      'Task import manifest is invalid'
    )

    const address = manifest.import_digest.slice(SHA256_PREFIX.length)
    const location = taskImportLocation(store, address)

    await rm(resolve(staging, 'materialized'), {
      force: true,
      recursive: true
    })

    await writeFile(resolve(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o400
    })

    await makeReadOnly(source, manifest.inventory)
    await chmod(resolve(staging, 'manifest.json'), 0o400)
    await chmod(staging, 0o500)

    const installed = await withAddressReservation(location, 'import', async () => {
      try {
        await rename(staging, location.importPath)

        return {
          importPath: location.importPath,
          manifest
        }
      } catch (error) {
        const errorCode = (error as NodeJS.ErrnoException).code

        if (errorCode !== 'EEXIST' && errorCode !== 'ENOTEMPTY') {
          throw error
        }
      }

      const existing = await validateTaskImportUnlocked(location)

      if (existing.kind !== 'active' || existing.manifest.import_digest !== manifest.import_digest) {
        throw new TaskImportError('IMPORT_CONFLICT', 'Import address is already occupied')
      }

      return {
        importPath: location.importPath,
        manifest: existing.manifest
      }
    })

    return installed
  } finally {
    await makeWritable(staging)

    await rm(staging, {
      force: true,
      recursive: true
    })
  }
}

async function validateSourceInventory(
  source: string,
  inventory: readonly TaskTreeEntry[]
): Promise<void> {
  const expectedDirectories = new Set<string>()
  const expectedFiles = new Map(inventory.map((entry) => [entry.path, entry]))

  for (const entry of inventory) {
    const segments = entry.path.split('/').slice(0, -1)

    for (let index = 1; index <= segments.length; index += 1) {
      expectedDirectories.add(segments.slice(0, index).join('/'))
    }
  }

  const actualDirectories: string[] = []
  const actualFiles: string[] = []

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      const relativePath = relative(source, path).split('\\').join('/')
      const metadata = await lstat(path)

      if (metadata.isSymbolicLink()) {
        throw new TaskImportError('INVALID_IMPORT', 'Imported source entry type is invalid')
      }

      if (metadata.isDirectory()) {
        if ((metadata.mode & 0o777) !== 0o500) {
          throw new TaskImportError(
            'INVALID_IMPORT',
            'Imported source directory mode is invalid'
          )
        }

        actualDirectories.push(relativePath)
        await visit(path)

        continue
      }

      if (!metadata.isFile()) {
        throw new TaskImportError('INVALID_IMPORT', 'Imported source entry type is invalid')
      }

      const expected = expectedFiles.get(relativePath)

      if (expected === undefined) {
        throw new TaskImportError('INVALID_IMPORT', 'Imported source file inventory is invalid')
      }

      const expectedMode = expected.executable ? 0o500 : 0o400

      if ((metadata.mode & 0o777) !== expectedMode) {
        throw new TaskImportError(
          'INVALID_IMPORT',
          'Imported source file mode is invalid'
        )
      }

      actualFiles.push(relativePath)
    }
  }

  await visit(source)
  actualDirectories.sort(compareText)
  actualFiles.sort(compareText)

  const expectedDirectoryList = [...expectedDirectories].sort(compareText)
  const expectedFileList = [...expectedFiles.keys()].sort(compareText)

  if (
    JSON.stringify(actualDirectories) !== JSON.stringify(expectedDirectoryList) ||
    JSON.stringify(actualFiles) !== JSON.stringify(expectedFileList)
  ) {
    throw new TaskImportError(
      'INVALID_IMPORT',
      'Imported source filesystem inventory is invalid'
    )
  }
}

async function validateActiveImport(
  importPath: string,
  expectedAddress: string,
  level: ActiveValidationLevel
): Promise<ActiveTaskImportValidation> {
  const manifestPath = resolve(importPath, 'manifest.json')

  const [rootMetadata, manifestMetadata] = await Promise.all([
    lstat(importPath),
    lstat(manifestPath)
  ])

  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    !manifestMetadata.isFile() ||
    manifestMetadata.isSymbolicLink()
  ) {
    throw new TaskImportError('INVALID_IMPORT', 'Task import storage type is invalid')
  }

  const manifestCandidate = await parseJson(
    manifestPath,
    'INVALID_IMPORT',
    'Task import manifest is invalid'
  )

  const manifest = safeParse(
    TaskImportManifestV1Schema,
    manifestCandidate,
    'INVALID_IMPORT',
    'Task import manifest is invalid'
  )

  const { import_digest: importDigest, ...preimage } = manifest

  if (
    digestDocument(preimage) !== importDigest ||
    expectedAddress !== importDigest.slice(SHA256_PREFIX.length)
  ) {
    throw new TaskImportError('INVALID_IMPORT', 'Task import content address is invalid')
  }

  assertSerializedMetadataSafe(
    manifest,
    'INVALID_IMPORT',
    'Task import manifest contains unsafe retained metadata'
  )

  if (
    manifest.retention.classification === 'private' &&
    new Date(manifest.retention.expires_at).getTime() <=
      new Date(manifest.created_at).getTime()
  ) {
    throw new TaskImportError('INVALID_IMPORT', 'Task import retention is invalid')
  }

  if (level === 'metadata') {
    return {
      importPath,
      kind: 'active',
      manifest
    }
  }

  const entries = (await readdir(importPath)).sort(compareText)

  if (JSON.stringify(entries) !== JSON.stringify(['manifest.json', 'source'])) {
    throw new TaskImportError('INVALID_IMPORT', 'Active task import has unexpected entries')
  }

  const source = resolve(importPath, 'source')
  const sourceMetadata = await lstat(source)

  if (
    !sourceMetadata.isDirectory() ||
    sourceMetadata.isSymbolicLink() ||
    (rootMetadata.mode & 0o777) !== 0o500 ||
    (sourceMetadata.mode & 0o777) !== 0o500 ||
    (manifestMetadata.mode & 0o777) !== 0o400
  ) {
    throw new TaskImportError('INVALID_IMPORT', 'Task import storage mode is invalid')
  }

  const [snapshot, scan] = await Promise.all([
    inspectTaskSource(source).catch(() => undefined),
    scanCredentialTree({ root: source }).catch(() => undefined)
  ])

  if (
    snapshot === undefined ||
    scan === undefined ||
    scan.credentialFound ||
    scan.invalidEntries.length > 0 ||
    snapshot.digest !== manifest.source_digest ||
    JSON.stringify(snapshot.entries) !== JSON.stringify(manifest.inventory)
  ) {
    throw new TaskImportError('INVALID_IMPORT', 'Imported source failed integrity validation')
  }

  await validateSourceInventory(source, manifest.inventory)

  const temporaryRoot = await mkdtemp('/tmp/harness-bench-task-import-validation-')

  try {
    const materialized = await materializeTaskWorkspace({
      destination: resolve(temporaryRoot, 'workspace'),
      expectedSourceDigest: manifest.source_digest,
      source
    })

    const inspection = await inspectMaterializedTaskWorkspace(materialized.workspace)

    if (
      materialized.baseCommit !== manifest.materialized_base_commit ||
      inspection.commitCount !== 1 ||
      JSON.stringify(inspection.refs) !== JSON.stringify(['refs/heads/main']) ||
      inspection.status !== '' ||
      inspection.remotes.length !== 0 ||
      inspection.hooks.length !== 0 ||
      inspection.alternates.length !== 0 ||
      inspection.unreachable !== ''
    ) {
      throw new TaskImportError('INVALID_IMPORT', 'Imported source materialization is not isolated')
    }
  } finally {
    await rm(temporaryRoot, {
      force: true,
      recursive: true
    })
  }

  return {
    importPath,
    kind: 'active',
    manifest
  }
}

async function validateTombstone(
  importPath: string,
  expectedAddress: string
): Promise<TombstoneTaskImportValidation> {
  const entries = await readdir(importPath, { withFileTypes: true })

  if (entries.length !== 1 || !entries[0]?.isDirectory()) {
    throw new TaskImportError('INVALID_IMPORT', 'Task import tombstone layout is invalid')
  }

  const tombstoneDirectory = resolve(importPath, entries[0].name)
  const nestedEntries = await readdir(tombstoneDirectory)

  if (JSON.stringify(nestedEntries) !== JSON.stringify(['record.json'])) {
    throw new TaskImportError('INVALID_IMPORT', 'Task import tombstone layout is invalid')
  }

  const [rootMetadata, tombstoneMetadata, recordMetadata] = await Promise.all([
    lstat(importPath),
    lstat(tombstoneDirectory),
    lstat(resolve(tombstoneDirectory, 'record.json'))
  ])

  if (
    !rootMetadata.isDirectory() ||
    !tombstoneMetadata.isDirectory() ||
    !recordMetadata.isFile() ||
    rootMetadata.isSymbolicLink() ||
    tombstoneMetadata.isSymbolicLink() ||
    recordMetadata.isSymbolicLink() ||
    (rootMetadata.mode & 0o777) !== 0o500 ||
    (tombstoneMetadata.mode & 0o777) !== 0o500 ||
    (recordMetadata.mode & 0o777) !== 0o400
  ) {
    throw new TaskImportError('INVALID_IMPORT', 'Task import tombstone mode is invalid')
  }

  const recordPath = resolve(tombstoneDirectory, 'record.json')

  const tombstoneCandidate = await parseJson(
    recordPath,
    'INVALID_IMPORT',
    'Task import tombstone is invalid'
  )

  const tombstone = safeParse(
    TaskImportTombstoneV1Schema,
    tombstoneCandidate,
    'INVALID_IMPORT',
    'Task import tombstone is invalid'
  )

  const { tombstone_digest: tombstoneDigest, ...preimage } = tombstone

  if (
    digestDocument(preimage) !== tombstoneDigest ||
    entries[0].name !== tombstoneDigest.slice(SHA256_PREFIX.length) ||
    expectedAddress !== tombstone.import_digest.slice(SHA256_PREFIX.length)
  ) {
    throw new TaskImportError('INVALID_IMPORT', 'Task import tombstone address is invalid')
  }

  assertSerializedMetadataSafe(
    tombstone,
    'INVALID_IMPORT',
    'Task import tombstone contains unsafe retained metadata'
  )

  if (
    (tombstone.reason === 'credential-detected') !==
    (tombstone.credential_action.status === 'known')
  ) {
    throw new TaskImportError(
      'INVALID_IMPORT',
      'Task import tombstone attestation is invalid'
    )
  }

  return {
    importPath,
    kind: 'tombstone',
    tombstone
  }
}

async function validateTaskImportUnlocked(
  location: TaskImportLocation
): Promise<ValidateTaskImportResult> {
  try {
    const metadata = await lstat(location.importPath)

    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('not a real directory')
    }
  } catch (error) {
    if (isTaskImportError(error)) throw error

    throw new TaskImportError('INVALID_IMPORT', 'Task import is unavailable')
  }

  const entries = await readdir(location.importPath)

  return entries.includes('manifest.json')
    ? validateActiveImport(location.importPath, location.address, 'full')
    : validateTombstone(location.importPath, location.address)
}

export async function validateTaskImport(path: string): Promise<ValidateTaskImportResult> {
  const location = await resolveTaskImportLocation(path)

  return withAddressReservation(location, 'validate', () => validateTaskImportUnlocked(location))
}

export async function materializeTaskImport(
  options: MaterializeTaskImportOptions
): Promise<{
  readonly baseCommit: string;
  readonly importDigest: string;
  readonly sourceDigest: string;
  readonly workspace: string;
}> {
  const location = await resolveTaskImportLocation(options.importPath)

  return withAddressReservation(location, 'materialize', async () => {
    const validated = await validateTaskImportUnlocked(location)

    if (validated.kind !== 'active') {
      throw new TaskImportError('INVALID_LIFECYCLE', 'Disposed task imports cannot be materialized')
    }

    const result = await materializeTaskWorkspace({
      destination: options.destination,
      expectedSourceDigest: validated.manifest.source_digest,
      source: resolve(validated.importPath, 'source')
    })

    if (result.baseCommit !== validated.manifest.materialized_base_commit) {
      await rm(result.workspace, {
        force: true,
        recursive: true
      })

      throw new TaskImportError('INVALID_IMPORT', 'Materialized task base commit is invalid')
    }

    return {
      baseCommit: result.baseCommit,
      importDigest: validated.manifest.import_digest,
      sourceDigest: result.sourceDigest,
      workspace: result.workspace
    }
  })
}

function buildTaskImportTombstone(
  manifest: TaskImportManifestV1,
  options: DisposeTaskImportOptions,
  disposedAt: string
): TaskImportTombstoneV1 {
  const credentialAction = options.credentialAction === undefined
    ? { status: 'not_applicable' as const }
    : {
        status: 'known' as const,
        value: options.credentialAction
      }

  const preimage = safeParse(
    TaskImportTombstonePreimageV1Schema,
    {
      document_type: 'task_import_tombstone',
      schema_version: 1,
      task_id: manifest.task_id,
      task_revision: manifest.task_revision,
      repository_id: manifest.provenance.repository_id,
      import_digest: manifest.import_digest,
      source_digest: manifest.source_digest,
      disposed_at: disposedAt,
      reason: options.reason,
      credential_action: credentialAction,
      owner_attestation: 'confirmed',
      external_repositories: 'not_managed',
      backups: 'not_managed'
    },
    'INVALID_LIFECYCLE',
    'Task import tombstone is invalid'
  )

  assertSerializedMetadataSafe(
    preimage,
    'INVALID_LIFECYCLE',
    'Task import tombstone contains unsafe retained metadata'
  )

  return safeParse(
    TaskImportTombstoneV1Schema,
    {
      ...preimage,
      tombstone_digest: digestDocument(preimage)
    },
    'INVALID_LIFECYCLE',
    'Task import tombstone is invalid'
  )
}

function assertDisposalRequest(
  manifest: TaskImportManifestV1,
  options: DisposeTaskImportOptions,
  disposedAt: string
): void {
  if (manifest.retention.classification !== 'private') {
    throw new TaskImportError('INVALID_LIFECYCLE', 'Public task imports cannot be disposed')
  }

  if (options.confirmImportDigest !== manifest.import_digest) {
    throw new TaskImportError('INVALID_LIFECYCLE', 'Import digest confirmation does not match')
  }

  if (options.reason === 'credential-detected' && options.credentialAction === undefined) {
    throw new TaskImportError('INVALID_LIFECYCLE', 'Credential disposal requires rotation or revocation')
  }

  if (options.reason !== 'credential-detected' && options.credentialAction !== undefined) {
    throw new TaskImportError(
      'INVALID_LIFECYCLE',
      'Credential action is not valid for this disposal reason'
    )
  }

  if (
    options.reason === 'retention-expired' &&
    new Date(disposedAt).getTime() < new Date(manifest.retention.expires_at).getTime()
  ) {
    throw new TaskImportError('INVALID_LIFECYCLE', 'Task import retention has not expired')
  }
}

async function sealTombstoneRecovery(
  location: TaskImportLocation,
  tombstone: TaskImportTombstoneV1
): Promise<void> {
  const tombstoneAddress = tombstone.tombstone_digest.slice(SHA256_PREFIX.length)
  const tombstoneDirectory = resolve(location.tombstoneRecoveryPath, tombstoneAddress)

  await mkdir(tombstoneDirectory, {
    recursive: true,
    mode: 0o700
  })

  const serialized = `${JSON.stringify(tombstone, null, 2)}\n`

  await writeFile(resolve(tombstoneDirectory, 'record.json'), serialized, {
    flag: 'wx',
    mode: 0o600
  })

  await chmod(resolve(tombstoneDirectory, 'record.json'), 0o400)
  await chmod(tombstoneDirectory, 0o500)
  await chmod(location.tombstoneRecoveryPath, 0o500)
  await validateTombstone(location.tombstoneRecoveryPath, location.address)
}

async function restrictRemaining(path: string): Promise<void> {
  const metadata = await lstat(path).catch(() => undefined)

  if (metadata === undefined || metadata.isSymbolicLink()) return

  if (metadata.isDirectory()) {
    await chmod(path, 0o700)

    for (const entry of await readdir(path)) {
      await restrictRemaining(resolve(path, entry))
    }

    await chmod(path, 0o500)

    return
  }

  await chmod(path, 0o400)
}

async function removeRecoveryPath(path: string): Promise<void> {
  if (!(await pathExists(path))) return

  await makeWritable(path)

  await rm(path, {
    force: true,
    recursive: true
  })
}

async function installRecoveredTombstone(
  location: TaskImportLocation
): Promise<TombstoneTaskImportValidation> {
  const recovered = await validateTombstone(
    location.tombstoneRecoveryPath,
    location.address
  )

  if (await pathExists(location.importPath)) {
    const existing = await validateTombstone(location.importPath, location.address)

    if (existing.tombstone.tombstone_digest !== recovered.tombstone.tombstone_digest) {
      throw new TaskImportError('IMPORT_CONFLICT', 'Recovery target has a different tombstone')
    }

    await removeRecoveryPath(location.tombstoneRecoveryPath)

    return existing
  }

  await mkdir(location.importPath, { mode: 0o700 })
  await chmod(location.tombstoneRecoveryPath, 0o700)

  const tombstoneAddress = recovered.tombstone.tombstone_digest.slice(SHA256_PREFIX.length)
  const recoveredLeaf = resolve(location.tombstoneRecoveryPath, tombstoneAddress)
  const installedLeaf = resolve(location.importPath, tombstoneAddress)

  await chmod(recoveredLeaf, 0o700)
  await rename(recoveredLeaf, installedLeaf)
  await chmod(installedLeaf, 0o500)
  await chmod(location.importPath, 0o500)
  await removeRecoveryPath(location.tombstoneRecoveryPath)

  return validateTombstone(location.importPath, location.address)
}

async function restoreActiveImport(
  location: TaskImportLocation
): Promise<ActiveTaskImportValidation> {
  if (await pathExists(location.importPath)) {
    throw new TaskImportError('IMPORT_CONFLICT', 'Active import recovery target is occupied')
  }

  const staged = await validateActiveImport(
    location.sourceRecoveryPath,
    location.address,
    'metadata'
  )

  await makeReadOnly(resolve(location.sourceRecoveryPath, 'source'), staged.manifest.inventory)
  await chmod(resolve(location.sourceRecoveryPath, 'manifest.json'), 0o400)
  await chmod(location.sourceRecoveryPath, 0o500)
  await rename(location.sourceRecoveryPath, location.importPath)

  const restored = await validateActiveImport(location.importPath, location.address, 'full')

  await removeRecoveryPath(location.tombstoneRecoveryPath)

  return restored
}

async function markReservationRecovery(
  location: TaskImportLocation,
  phase: DisposalPhase
): Promise<void> {
  const record = {
    document_type: 'task_import_reservation',
    schema_version: 1,
    import_digest: `${SHA256_PREFIX}${location.address}`,
    operation: 'dispose',
    owner_pid: process.pid,
    state: 'recovery_required',
    phase
  }

  const checked = safeParse(
    TaskImportReservationSchema,
    record,
    'IMPORT_CONFLICT',
    'Task import recovery reservation is invalid'
  )

  await writeFile(location.reservationPath, `${JSON.stringify(checked)}\n`, { mode: 0o600 })
  await chmod(location.reservationPath, 0o600)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function readRecoveryReservation(
  location: TaskImportLocation
): Promise<v.InferOutput<typeof TaskImportReservationSchema>> {
  const metadata = await lstat(location.reservationPath).catch(() => undefined)

  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new TaskImportError('INVALID_LIFECYCLE', 'Task import has no valid recovery reservation')
  }

  const candidate = await parseJson(
    location.reservationPath,
    'INVALID_LIFECYCLE',
    'Task import recovery reservation is invalid'
  )

  const record = safeParse(
    TaskImportReservationSchema,
    candidate,
    'INVALID_LIFECYCLE',
    'Task import recovery reservation is invalid'
  )

  if (
    record.import_digest !== `${SHA256_PREFIX}${location.address}` ||
    record.operation !== 'dispose'
  ) {
    throw new TaskImportError('INVALID_LIFECYCLE', 'Task import recovery reservation does not match')
  }

  if (record.state === 'active' && processIsAlive(record.owner_pid)) {
    throw new TaskImportError('IMPORT_CONFLICT', 'Task import disposal is still active')
  }

  return record
}

export async function disposeTaskImport(
  path: string,
  options: DisposeTaskImportOptions
): Promise<{ readonly importPath: string; readonly tombstone: TaskImportTombstoneV1 }> {
  const location = await resolveTaskImportLocation(path)
  const reservation = await acquireAddressReservation(location, 'dispose')
  let phase: DisposalPhase = 'reserved'
  let reservationClosed = false

  async function closeReservation(): Promise<void> {
    if (reservationClosed) return

    await closeAddressReservation(reservation)

    reservationClosed = true
  }

  async function clearReservation(): Promise<void> {
    await closeReservation()
    await removeAddressReservation(location)
  }

  try {
    await assertNoRecoveryState(location)

    const validated = options.reason === 'credential-detected'
      ? await validateActiveImport(location.importPath, location.address, 'metadata')
      : await validateTaskImportUnlocked(location)

    if (validated.kind !== 'active') {
      throw new TaskImportError('INVALID_LIFECYCLE', 'Task import is already disposed')
    }

    const disposedAt = (options.now ?? (() => new Date()))().toISOString()

    assertDisposalRequest(validated.manifest, options, disposedAt)

    const tombstone = buildTaskImportTombstone(validated.manifest, options, disposedAt)

    await sealTombstoneRecovery(location, tombstone)

    phase = 'tombstone-staged'

    await options.testHooks?.afterReservation?.()
    await rename(location.importPath, location.sourceRecoveryPath)

    phase = 'moved'

    await options.testHooks?.afterMove?.()
    await makeWritable(location.sourceRecoveryPath)
    await rm(location.sourceRecoveryPath, { recursive: true })

    phase = 'deleted'

    await options.testHooks?.afterDelete?.()

    const installed = await installRecoveredTombstone(location)

    phase = 'tombstone-installed'

    await options.testHooks?.beforeReservationRelease?.()
    await clearReservation()

    return {
      importPath: installed.importPath,
      tombstone: installed.tombstone
    }
  } catch (error) {
    if (phase === 'reserved') {
      await clearReservation()

      throw error
    }

    if (phase === 'tombstone-staged') {
      await removeRecoveryPath(location.tombstoneRecoveryPath)
      await clearReservation()

      throw error
    }

    if (phase === 'moved') {
      try {
        await restoreActiveImport(location)
        await clearReservation()
      } catch (recoveryError) {
        await restrictRemaining(location.importPath).catch(() => undefined)
        await restrictRemaining(location.sourceRecoveryPath).catch(() => undefined)
        await restrictRemaining(location.tombstoneRecoveryPath).catch(() => undefined)
        await markReservationRecovery(location, phase).catch(() => undefined)
        await closeReservation().catch(() => undefined)

        throw new TaskImportError(
          'INVALID_LIFECYCLE',
          'Task import disposal did not restore safely; run task recover',
          { cause: recoveryError }
        )
      }

      throw new TaskImportError(
        'INVALID_LIFECYCLE',
        'Task import disposal stopped before deletion; the active import was restored',
        { cause: error }
      )
    }

    await restrictRemaining(location.importPath).catch(() => undefined)
    await restrictRemaining(location.tombstoneRecoveryPath).catch(() => undefined)
    await markReservationRecovery(location, phase).catch(() => undefined)
    await closeReservation().catch(() => undefined)

    throw new TaskImportError(
      'INVALID_LIFECYCLE',
      'Task import disposal did not complete safely; run task recover',
      { cause: error }
    )
  }
}

export async function recoverTaskImportDisposal(
  path: string,
  options: RecoverTaskImportDisposalOptions
): Promise<ValidateTaskImportResult> {
  const location = await resolveTaskImportLocation(path)

  if (options.confirmImportDigest !== `${SHA256_PREFIX}${location.address}`) {
    throw new TaskImportError('INVALID_LIFECYCLE', 'Import digest confirmation does not match')
  }

  let recoveryClaim: AddressReservation

  try {
    recoveryClaim = await open(location.recoveryClaimPath, 'wx', 0o600)
  } catch {
    throw new TaskImportError('IMPORT_CONFLICT', 'Task import recovery is already in progress')
  }

  try {
    await readRecoveryReservation(location)

    const sourceRecoveryExists = await pathExists(location.sourceRecoveryPath)
    const tombstoneRecoveryExists = await pathExists(location.tombstoneRecoveryPath)
    const importExists = await pathExists(location.importPath)
    let recovered: ValidateTaskImportResult

    if (sourceRecoveryExists) {
      if (importExists) {
        throw new TaskImportError('IMPORT_CONFLICT', 'Task import recovery has conflicting source state')
      }

      recovered = await restoreActiveImport(location)
    } else if (importExists) {
      recovered = await validateTaskImportUnlocked(location)

      if (recovered.kind === 'active') {
        await removeRecoveryPath(location.tombstoneRecoveryPath)
      } else if (tombstoneRecoveryExists) {
        const staged = await validateTombstone(location.tombstoneRecoveryPath, location.address)

        if (staged.tombstone.tombstone_digest !== recovered.tombstone.tombstone_digest) {
          throw new TaskImportError('IMPORT_CONFLICT', 'Task import recovery tombstones differ')
        }

        await removeRecoveryPath(location.tombstoneRecoveryPath)
      }
    } else if (tombstoneRecoveryExists) {
      recovered = await installRecoveredTombstone(location)
    } else {
      throw new TaskImportError('INVALID_LIFECYCLE', 'Task import recovery state is incomplete')
    }

    await removeAddressReservation(location)

    return recovered
  } finally {
    await recoveryClaim.close()
    await rm(location.recoveryClaimPath)
  }
}
