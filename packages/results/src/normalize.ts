import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

import {
  CompletionRunRecordSchema,
  InitialRunRecordSchema,
  ScoreDocumentSchema,
  type CompletionRunRecord,
  type InitialRunRecord,
  type ScoreDocument
} from '@harness-bench/schemas'

import { scanCredentialBytes, scanCredentialTree, type CredentialPatternFinding } from '@harness-bench/core'
import * as v from 'valibot'
import { ResultError } from './errors.ts'

import {
  NormalizedRunRecordV1Schema,
  ResultTimestampSchema,
  RestrictedRunRecordV1Schema,
  type EvidenceReferenceV1,
  type NormalizedRunRecordV1,
  type RestrictedRunRecordV1
} from './schemas.ts'

import {
  hashStableFile,
  readStableFile,
  serializeRecord,
  sha256,
  withRunResultLock,
  writeContentAddressedRecord
} from './storage.ts'

const HARBOR_VERSION = '0.22.0'
const ATIF_VERSION = 'ATIF-v1.7'
const UNKNOWN_USAGE_REASON = 'Harbor did not report this usage value'
const UNKNOWN_TIMING_REASON = 'Harbor did not report a complete timing pair'

const RawManifestSchema = v.array(v.strictObject({
  digest: v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/)),
  executable: v.boolean(),
  path: v.pipe(v.string(), v.nonEmpty()),
  size: v.pipe(v.number(), v.integer(), v.minValue(0))
}))

interface RawEntry {
  readonly digest: string;
  readonly executable: boolean;
  readonly path: string;
  readonly size: number;
}

interface RawSnapshot {
  readonly entries: readonly RawEntry[];
  readonly signature: string;
}

interface SourceRecords {
  readonly completion: CompletionRunRecord;
  readonly completionDigest: string;
  readonly initial: InitialRunRecord;
  readonly initialDigest: string;
  readonly manifestDigest: string;
  readonly metadataFindings: readonly CredentialPatternFinding[];
  readonly raw: RawSnapshot;
  readonly rawPath: string;
  readonly rawRoot: string;
  readonly signature: string;
}

export interface NormalizeRunOptions {
  readonly runsDirectory?: string;
}

export interface NormalizeRuntime {
  readonly beforeFinalSnapshot?: () => Promise<void>;
  readonly now: () => Date;
}

export interface ResolvedEvidenceReference {
  readonly localPath: string;
  readonly relativePath: string;
  readonly role: EvidenceReferenceV1['role'];
}

export type NormalizeRunResult =
  | {
      readonly kind: 'normalized';
      readonly digest: string;
      readonly record: NormalizedRunRecordV1;
      readonly recordPath: string;
      readonly resolvedReferences: readonly ResolvedEvidenceReference[];
      readonly runDirectory: string;
    }
  | {
      readonly kind: 'restricted';
      readonly digest: string;
      readonly record: RestrictedRunRecordV1;
      readonly recordPath: string;
      readonly runDirectory: string;
    }

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeRelativePath(path: string): boolean {
  return (
    path !== '' &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    path.split('/').every((segment) => !['', '.', '..'].includes(segment))
  )
}

function pathIsInside(parent: string, child: string): boolean {
  const candidate = relative(parent, child)

  return candidate !== '' && !candidate.startsWith('..') && !isAbsolute(candidate)
}

function parseJson(source: Buffer, label: string): unknown {
  try {
    return JSON.parse(source.toString('utf8'))
  } catch (error) {
    throw new ResultError('INVALID_INPUT', `${label} is not valid JSON`, {
      cause: error,
      stage: 'normalization'
    })
  }
}

function parseSourceDocument<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>
>(source: Buffer, label: string, schema: TSchema): v.InferOutput<TSchema> {
  const candidate = parseJson(source, label)
  const parsed = v.safeParse(schema, candidate)

  if (!parsed.success) {
    throw new ResultError(
      'INVALID_INPUT',
      `${label} does not satisfy schema v1`,
      { stage: 'normalization' }
    )
  }

  return parsed.output
}

async function assertMode(
  path: string,
  expected: number,
  label: string
): Promise<void> {
  const metadata = await lstat(path)

  if (
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== expected
  ) {
    throw new ResultError(
      'SOURCE_NOT_SEALED',
      `${label} does not preserve the sealed issue-7 mode`,
      { stage: 'normalization' }
    )
  }
}

async function resolveRunDirectory(
  runDirectory: string,
  options: NormalizeRunOptions
): Promise<{ readonly runDirectory: string; readonly runsRoot: string }> {
  const requested = resolve(runDirectory)
  let requestedMetadata

  try {
    requestedMetadata = await lstat(requested)
  } catch (error) {
    throw new ResultError('INVALID_INPUT', 'Run directory is unavailable', {
      cause: error,
      stage: 'input'
    })
  }

  if (requestedMetadata.isSymbolicLink() || !requestedMetadata.isDirectory()) {
    throw new ResultError(
      'INVALID_INPUT',
      'Run source must be a real directory, not a symlink',
      { stage: 'input' }
    )
  }

  const physicalRun = await realpath(requested)
  const requestedRoot = resolve(options.runsDirectory ?? dirname(requested))
  const rootMetadata = await lstat(requestedRoot)

  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new ResultError('INVALID_INPUT', 'Runs root must be a real directory', {
      stage: 'input'
    })
  }

  const runsRoot = await realpath(requestedRoot)

  if (dirname(physicalRun) !== runsRoot || !pathIsInside(runsRoot, physicalRun)) {
    throw new ResultError(
      'INVALID_INPUT',
      'Run directory must be a direct child of the runs root',
      { stage: 'input' }
    )
  }

  await assertMode(physicalRun, 0o500, 'Run directory')
  await assertMode(runsRoot, 0o700, 'Runs root')

  return {
    runDirectory: physicalRun,
    runsRoot
  }
}

async function inspectRawTree(root: string): Promise<RawSnapshot> {
  const entries: RawEntry[] = []
  const directories: string[] = []

  async function visit(directory: string): Promise<void> {
    const directoryMetadata = await lstat(directory)

    if (
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory()
    ) {
      throw new ResultError(
        'INTEGRITY_MISMATCH',
        'Raw evidence contains a symlink or special entry',
        { stage: 'normalization' }
      )
    }

    if ((directoryMetadata.mode & 0o777) !== 0o500) {
      throw new ResultError(
        'SOURCE_NOT_SEALED',
        'Raw evidence directory is not sealed',
        { stage: 'normalization' }
      )
    }

    const directoryPath = relative(root, directory).split('\\').join('/')

    directories.push(directoryPath)

    const children = await readdir(directory, { withFileTypes: true })

    children.sort((left, right) => compareText(left.name, right.name))

    for (const child of children) {
      const path = resolve(directory, child.name)
      const relativePath = relative(root, path).split('\\').join('/')
      const metadata = await lstat(path)

      if (
        child.name === 'sha256-manifest.json' ||
        basename(relativePath) === 'sha256-manifest.json'
      ) {
        throw new ResultError(
          'INTEGRITY_MISMATCH',
          'Raw evidence contains a reserved manifest name',
          { stage: 'normalization' }
        )
      }

      if (metadata.isSymbolicLink()) {
        throw new ResultError(
          'INTEGRITY_MISMATCH',
          'Raw evidence contains a symbolic link',
          { stage: 'normalization' }
        )
      }

      if (metadata.isDirectory()) {
        await visit(path)

        continue
      }

      if (!metadata.isFile()) {
        throw new ResultError(
          'INTEGRITY_MISMATCH',
          'Raw evidence contains a special entry',
          { stage: 'normalization' }
        )
      }

      const executable = (metadata.mode & 0o111) !== 0
      const expectedMode = executable ? 0o500 : 0o400

      if ((metadata.mode & 0o777) !== expectedMode) {
        throw new ResultError(
          'SOURCE_NOT_SEALED',
          'Raw evidence file is not sealed',
          { stage: 'normalization' }
        )
      }

      const stableDigest = await hashStableFile(path)

      entries.push({
        digest: stableDigest.digest,
        executable,
        path: relativePath,
        size: stableDigest.size
      })
    }
  }

  await visit(root)
  entries.sort((left, right) => compareText(left.path, right.path))
  directories.sort(compareText)

  return {
    entries,

    signature: sha256(JSON.stringify({
      directories,
      entries
    }))
  }
}

function validateManifest(raw: RawSnapshot, candidate: unknown): void {
  const parsed = v.safeParse(RawManifestSchema, candidate)

  if (!parsed.success) {
    throw new ResultError(
      'INVALID_INPUT',
      'Raw manifest does not satisfy the issue-7 contract',
      { stage: 'normalization' }
    )
  }

  const seen = new Set<string>()

  for (const entry of parsed.output) {
    if (!safeRelativePath(entry.path) || seen.has(entry.path)) {
      throw new ResultError(
        'INTEGRITY_MISMATCH',
        'Raw manifest contains an unsafe or duplicate path',
        { stage: 'normalization' }
      )
    }

    seen.add(entry.path)
  }

  const expected = [...parsed.output].sort((left, right) =>
    compareText(left.path, right.path)
  )

  if (JSON.stringify(expected) !== JSON.stringify(raw.entries)) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Raw manifest does not match the exact filesystem inventory',
      { stage: 'normalization' }
    )
  }
}

function assertSourceRelationships(
  initial: InitialRunRecord,
  completion: CompletionRunRecord,
  initialDigest: string,
  manifestDigest: string
): void {
  const qualityOutcome =
    completion.classification === 'task_success' ||
    completion.classification === 'task_failure'

  if (
    JSON.stringify(initial.identity) !== JSON.stringify(completion.identity) ||
    completion.initial_manifest_digest !== initialDigest ||
    completion.raw_artifact_manifest_digest !== manifestDigest ||
    JSON.stringify(initial.retention) !== JSON.stringify(completion.retention) ||
    completion.collection.collector_revision !== initial.collector.revision ||
    completion.collection.collector_image_digest !== initial.collector.image_digest ||
    completion.verifier.verifier_revision !== initial.verifier.revision ||
    completion.verifier.verifier_image_digest !== initial.verifier.image_digest ||
    JSON.stringify(completion.verifier.network_enforcement_sidecar_digest) !==
      JSON.stringify(initial.verifier.network_enforcement_sidecar_digest) ||
    completion.valid_grade !== qualityOutcome ||
    Date.parse(completion.completed_at) < Date.parse(initial.created_at)
  ) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Run records have incompatible identity, revision, or lifecycle linkage',
      { stage: 'normalization' }
    )
  }

  if (
    initial.retention.classification === 'private' &&
    Date.parse(initial.retention.expires_at) <= Date.parse(initial.created_at)
  ) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Private retention expiry must follow run creation',
      { stage: 'normalization' }
    )
  }
}

async function loadSourceRecords(runDirectory: string): Promise<SourceRecords> {
  const initialPath = resolve(runDirectory, 'initial.json')
  const completionPath = resolve(runDirectory, 'completion.json')
  const manifestPath = resolve(runDirectory, 'raw-manifest.json')

  await Promise.all([
    assertMode(initialPath, 0o400, 'Initial record'),
    assertMode(completionPath, 0o400, 'Completion record'),
    assertMode(manifestPath, 0o400, 'Raw manifest')
  ])

  const [initialSource, completionSource, manifestSource] = await Promise.all([
    readStableFile(initialPath),
    readStableFile(completionPath),
    readStableFile(manifestPath)
  ])

  const initial = parseSourceDocument(
    initialSource,
    'Initial run record',
    InitialRunRecordSchema
  )

  const completion = parseSourceDocument(
    completionSource,
    'Completion run record',
    CompletionRunRecordSchema
  )

  if (initial.runner.name !== 'harbor' || initial.runner.version !== HARBOR_VERSION) {
    throw new ResultError(
      'INCOMPATIBLE_VERSION',
      'Only Harbor 0.22.0 run records are supported',
      { stage: 'normalization' }
    )
  }

  if (basename(runDirectory) !== initial.identity.run_id) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Run directory name does not match the run identity',
      { stage: 'normalization' }
    )
  }

  if (!safeRelativePath(completion.raw_artifact_path)) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Raw artifact path is not a safe relative path',
      { stage: 'normalization' }
    )
  }

  const rawRoot = resolve(runDirectory, completion.raw_artifact_path)

  if (!pathIsInside(runDirectory, rawRoot)) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Raw artifact path escapes the immutable run directory',
      { stage: 'normalization' }
    )
  }

  let physicalRawRoot: string

  try {
    physicalRawRoot = await realpath(rawRoot)
  } catch (error) {
    throw new ResultError('INVALID_INPUT', 'Raw artifact directory is unavailable', {
      cause: error,
      stage: 'normalization'
    })
  }

  if (physicalRawRoot !== rawRoot || !pathIsInside(runDirectory, physicalRawRoot)) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Raw artifact path contains a symlink or escapes the run directory',
      { stage: 'normalization' }
    )
  }

  const raw = await inspectRawTree(physicalRawRoot)
  const manifestCandidate = parseJson(manifestSource, 'Raw manifest')

  validateManifest(raw, manifestCandidate)

  const initialDigest = sha256(initialSource)
  const completionDigest = sha256(completionSource)
  const manifestDigest = sha256(manifestSource)

  const metadataFindings = [
    ...scanCredentialBytes(initialSource, { path: 'initial.json' }),
    ...scanCredentialBytes(completionSource, { path: 'completion.json' }),
    ...scanCredentialBytes(manifestSource, { path: 'raw-manifest.json' })
  ]

  assertSourceRelationships(
    initial,
    completion,
    initialDigest,
    manifestDigest
  )

  return {
    completion,
    completionDigest,
    initial,
    initialDigest,
    manifestDigest,
    metadataFindings,
    raw,
    rawPath: completion.raw_artifact_path,
    rawRoot: physicalRawRoot,

    signature: sha256(JSON.stringify({
      completion: completionDigest,
      initial: initialDigest,
      manifest: manifestDigest,
      raw: raw.signature
    }))
  }
}

function findTrialPrefix(raw: RawSnapshot): string | undefined {
  const trials = new Set<string>()

  for (const entry of raw.entries) {
    const match = /^harbor\/job\/([^/]+)\//.exec(entry.path)

    if (match?.[1] !== undefined && match[1] !== '.sources') {
      trials.add(`harbor/job/${match[1]}`)
    }
  }

  if (trials.size > 1) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Harbor output contains more than one trial',
      { stage: 'normalization' }
    )
  }

  return [...trials][0]
}

async function readRawFile(
  records: SourceRecords,
  path: string
): Promise<Buffer | undefined> {
  const entry = records.raw.entries.find((candidate) => candidate.path === path)

  if (entry === undefined) {
    return undefined
  }

  return readStableFile(resolve(records.rawRoot, entry.path))
}

function requireJsonRecord(
  source: Buffer,
  label: string
): Record<string, unknown> {
  const candidate = parseJson(source, label)

  if (!isRecord(candidate)) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      `${label} is not a JSON object`,
      { stage: 'normalization' }
    )
  }

  return candidate
}

function parseTimestamp(value: unknown, label: string): number {
  if (
    typeof value !== 'string' ||
    !v.safeParse(ResultTimestampSchema, value).success
  ) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      `${label} timestamp is malformed`,
      { stage: 'normalization' }
    )
  }

  const milliseconds = Date.parse(value)

  if (Number.isNaN(milliseconds)) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      `${label} timestamp is malformed`,
      { stage: 'normalization' }
    )
  }

  return milliseconds
}

function timing(
  result: Record<string, unknown> | undefined,
  field: 'agent_execution' | 'verifier'
): NormalizedRunRecordV1['timings']['agent_seconds'] {
  const candidate = result?.[field]

  if (candidate === undefined || candidate === null) {
    return {
      status: 'unknown',
      reason: UNKNOWN_TIMING_REASON
    }
  }

  if (!isRecord(candidate)) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Harbor timing evidence has an incompatible shape',
      { stage: 'normalization' }
    )
  }

  const { finished_at: finishedAt, started_at: startedAt } = candidate

  if (startedAt === undefined || startedAt === null || finishedAt === undefined || finishedAt === null) {
    return {
      status: 'unknown',
      reason: UNKNOWN_TIMING_REASON
    }
  }

  const start = parseTimestamp(startedAt, field)
  const finish = parseTimestamp(finishedAt, field)

  if (finish < start) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Harbor timing finishes before it starts',
      { stage: 'normalization' }
    )
  }

  return {
    status: 'known',
    value: Math.ceil((finish - start) / 1_000)
  }
}

function optionalMetric(
  record: Record<string, unknown> | undefined,
  field: string,
  integer: boolean
): number | undefined {
  const candidate = record?.[field]

  if (candidate === undefined || candidate === null) {
    return undefined
  }

  if (
    typeof candidate !== 'number' ||
    !Number.isFinite(candidate) ||
    candidate < 0 ||
    (integer && !Number.isInteger(candidate))
  ) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Harbor usage evidence has an incompatible value',
      { stage: 'normalization' }
    )
  }

  return candidate
}

function knownOrUnknown(
  value: number | undefined
): NormalizedRunRecordV1['usage']['input_tokens'] {
  return value === undefined
    ? {
      status: 'unknown',
      reason: UNKNOWN_USAGE_REASON
    }
    : {
      status: 'known',
      value
    }
}

function validateJsonLines(source: Buffer): void {
  const lines = source.toString('utf8').split('\n').filter((line) => line !== '')

  if (lines.length === 0) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Native rollout JSONL is empty',
      { stage: 'normalization' }
    )
  }

  for (const line of lines) {
    const parsed = parseJson(Buffer.from(line), 'Native rollout JSONL entry')

    if (!isRecord(parsed)) {
      throw new ResultError(
        'INCOMPATIBLE_EVIDENCE',
        'Native rollout JSONL entry is not an object',
        { stage: 'normalization' }
      )
    }
  }
}

function reference(
  records: SourceRecords,
  entryPath: string,
  role: EvidenceReferenceV1['role'],
  format: EvidenceReferenceV1['format']
): EvidenceReferenceV1 {
  const entry = records.raw.entries.find(({ path }) => path === entryPath)

  if (entry === undefined) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Referenced evidence is absent from the raw manifest',
      { stage: 'normalization' }
    )
  }

  return {
    path: `${records.rawPath}/${entry.path}`,
    digest: entry.digest,
    size: entry.size,
    executable: entry.executable,
    format,
    role
  }
}

async function normalizedScore(
  records: SourceRecords,
  trialPrefix: string | undefined
): Promise<NormalizedRunRecordV1['score']> {
  if (!records.completion.valid_grade) {
    return {
      status: 'unavailable',
      reason: 'Execution outcome has no valid quality grade'
    }
  }

  if (trialPrefix === undefined) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'A valid grade requires one Harbor trial',
      { stage: 'normalization' }
    )
  }

  const scoreSource = await readRawFile(
    records,
    `${trialPrefix}/verifier/score.json`
  )

  if (scoreSource === undefined) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'A valid grade requires a structured score',
      { stage: 'normalization' }
    )
  }

  const score = parseSourceDocument(
    scoreSource,
    'Structured score',
    ScoreDocumentSchema
  )

  const expectedClassification =
    score.gates.direct_behavior_pass &&
    score.gates.regression_pass &&
    score.gates.verifier_integrity_pass
      ? 'task_success'
      : 'task_failure'

  if (
    !score.valid_grade ||
    score.run_id !== records.initial.identity.run_id ||
    score.scoring_revision !== records.initial.scoring_revision ||
    records.completion.score_id.status !== 'known' ||
    score.score_id !== records.completion.score_id.value ||
    records.completion.verifier.result_digest.status !== 'known' ||
    score.verifier_result_digest !== records.completion.verifier.result_digest.value ||
    expectedClassification !== records.completion.classification
  ) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Structured score does not match the completed run',
      { stage: 'normalization' }
    )
  }

  await validateReward(records, trialPrefix, score)

  return {
    status: 'known',
    document: score
  }
}

async function validateReward(
  records: SourceRecords,
  trialPrefix: string,
  score: ScoreDocument
): Promise<void> {
  const rewardSource = await readRawFile(
    records,
    `${trialPrefix}/verifier/reward.json`
  )

  if (rewardSource === undefined) {
    if (score.harbor_reward.status === 'retained_upstream') {
      throw new ResultError(
        'INCOMPATIBLE_EVIDENCE',
        'Structured score refers to a missing Harbor reward',
        { stage: 'normalization' }
      )
    }

    return
  }

  const reward = requireJsonRecord(rewardSource, 'Harbor reward')

  for (const value of Object.values(reward)) {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      throw new ResultError(
        'INCOMPATIBLE_EVIDENCE',
        'Harbor reward contains a non-numeric facet',
        { stage: 'normalization' }
      )
    }
  }

  const ordered = (record: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(record).sort(([left], [right]) => compareText(left, right))
    )

  if (
    score.harbor_reward.status !== 'retained_upstream' ||
    JSON.stringify(ordered(reward)) !==
      JSON.stringify(ordered(score.harbor_reward.numeric_values))
  ) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Harbor reward does not match the structured score',
      { stage: 'normalization' }
    )
  }
}

async function parseAtif(
  records: SourceRecords,
  atifPath: string | undefined
): Promise<Record<string, unknown> | undefined> {
  if (atifPath === undefined) {
    return undefined
  }

  const source = await readRawFile(records, atifPath)

  if (source === undefined) {
    return undefined
  }

  const atif = requireJsonRecord(source, 'ATIF trajectory')

  if (atif.schema_version !== ATIF_VERSION) {
    throw new ResultError(
      'INCOMPATIBLE_VERSION',
      'Only ATIF-v1.7 trajectories are supported',
      { stage: 'normalization' }
    )
  }

  const agent = atif.agent

  if (
    !isRecord(agent) ||
    agent.name !== records.initial.agent.product ||
    agent.version !== records.initial.agent.cli_version ||
    agent.model_name !== records.initial.agent.requested_model
  ) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'ATIF agent identity does not match the immutable run identity',
      { stage: 'normalization' }
    )
  }

  return atif
}

function crossCheckAtif(
  atif: Record<string, unknown> | undefined,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  cost: number | undefined
): void {
  if (atif === undefined) {
    return
  }

  const finalMetrics = atif.final_metrics

  if (finalMetrics === undefined || finalMetrics === null) {
    return
  }

  if (!isRecord(finalMetrics)) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'ATIF final metrics have an incompatible shape',
      { stage: 'normalization' }
    )
  }

  const comparisons = [
    ['total_prompt_tokens', inputTokens, true],
    ['total_completion_tokens', outputTokens, true],
    ['total_cost_usd', cost, false]
  ] as const

  for (const [field, harborValue, integer] of comparisons) {
    const atifValue = optionalMetric(finalMetrics, field, integer)

    if (atifValue !== undefined && atifValue !== harborValue) {
      throw new ResultError(
        'INCOMPATIBLE_EVIDENCE',
        'ATIF totals do not match the Harbor trial result',
        { stage: 'normalization' }
      )
    }
  }
}

function assertTrustedCollectionEvidence(
  records: SourceRecords,
  trialPrefix: string
): void {
  const proofs = [
    [
      records.completion.collection.quiescence,
      `${trialPrefix}/trial.log`
    ],
    [
      records.completion.collection.collection,
      `${trialPrefix}/artifacts/trusted-collector/workspace-metadata.json`
    ],
    [
      records.completion.collection.exact_manifest,
      `${trialPrefix}/artifacts/manifest.json`
    ],
    [
      records.completion.collection.hashes,
      `${trialPrefix}/artifacts/trusted-collector/workspace.patch`
    ]
  ] as const

  for (const [proof, path] of proofs) {
    const entry = records.raw.entries.find((candidate) => candidate.path === path)
    const evidenceDigest = proof.evidence_digest

    if (
      entry === undefined ||
      proof.status !== 'passed' ||
      evidenceDigest.status !== 'known' ||
      evidenceDigest.value !== entry.digest
    ) {
      throw new ResultError(
        'INCOMPATIBLE_EVIDENCE',
        'Trusted collection proof does not match retained raw evidence',
        { stage: 'normalization' }
      )
    }
  }
}

async function parseEvidence(records: SourceRecords): Promise<Pick<
  NormalizedRunRecordV1,
  | 'evidence_availability'
  | 'references'
  | 'score'
  | 'timings'
  | 'usage'
>> {
  const qualityOutcome = records.completion.valid_grade
  const trialPrefix = findTrialPrefix(records.raw)
  const allPaths = records.raw.entries.map(({ path }) => path)

  const nativeSessionPrefix = trialPrefix === undefined
    ? undefined
    : `${trialPrefix}/agent/sessions/`

  const nativeRollouts = allPaths.filter((path) =>
    nativeSessionPrefix !== undefined &&
    path.startsWith(nativeSessionPrefix) &&
    /^\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/.test(
      path.slice(nativeSessionPrefix.length)
    )
  )

  const atifPaths = allPaths.filter((path) =>
    trialPrefix !== undefined && path === `${trialPrefix}/agent/trajectory.json`
  )

  const mergedPaths = allPaths.filter((path) =>
    trialPrefix !== undefined && path === `${trialPrefix}/agent/codex.txt`
  )

  if (atifPaths.length > 1 || mergedPaths.length > 1) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Harbor trial contains duplicate trajectory evidence',
      { stage: 'normalization' }
    )
  }

  if (
    qualityOutcome &&
    (nativeRollouts.length === 0 || atifPaths.length !== 1 || mergedPaths.length !== 1)
  ) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Task outcomes require native, ATIF, and merged Codex evidence',
      { stage: 'normalization' }
    )
  }

  if (qualityOutcome && trialPrefix !== undefined) {
    assertTrustedCollectionEvidence(records, trialPrefix)
  }

  for (const path of nativeRollouts) {
    const source = await readRawFile(records, path)

    if (source !== undefined) {
      validateJsonLines(source)
    }
  }

  const atifPath = atifPaths[0]
  const atif = await parseAtif(records, atifPath)

  const resultPath = trialPrefix === undefined
    ? undefined
    : `${trialPrefix}/result.json`

  const resultSource = resultPath === undefined
    ? undefined
    : await readRawFile(records, resultPath)

  const result = resultSource === undefined
    ? undefined
    : requireJsonRecord(resultSource, 'Harbor trial result')

  if (
    qualityOutcome &&
    (result === undefined || result.verifier_environment_mode !== 'separate')
  ) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Task outcome lacks a separate Harbor verifier result',
      { stage: 'normalization' }
    )
  }

  const agentResult = result?.agent_result

  if (
    agentResult !== undefined &&
    agentResult !== null &&
    !isRecord(agentResult)
  ) {
    throw new ResultError(
      'INCOMPATIBLE_EVIDENCE',
      'Harbor agent usage has an incompatible shape',
      { stage: 'normalization' }
    )
  }

  const usageRecord = isRecord(agentResult) ? agentResult : undefined
  const inputTokens = optionalMetric(usageRecord, 'n_input_tokens', true)
  const outputTokens = optionalMetric(usageRecord, 'n_output_tokens', true)
  const cost = optionalMetric(usageRecord, 'cost_usd', false)

  crossCheckAtif(atif, inputTokens, outputTokens, cost)

  const references: EvidenceReferenceV1[] = []

  for (const path of nativeRollouts) {
    references.push(reference(records, path, 'native_rollout', 'codex-native-jsonl'))
  }

  if (atifPath !== undefined) {
    references.push(reference(records, atifPath, 'atif_trajectory', ATIF_VERSION))
  }

  if (mergedPaths[0] !== undefined) {
    references.push(
      reference(records, mergedPaths[0], 'merged_agent_output', 'merged-text')
    )
  }

  const optionalReferences = trialPrefix === undefined
    ? []
    : [
        [`${trialPrefix}/artifacts/manifest.json`, 'artifact_manifest', 'harbor-artifact-manifest'],
        [`${trialPrefix}/result.json`, 'harbor_trial_result', 'harbor-trial-result-0.22.0'],
        [`${trialPrefix}/trial.log`, 'harbor_trial_log', 'harbor-trial-log'],
        [`${trialPrefix}/verifier/score.json`, 'structured_score', 'score-v1'],
        [`${trialPrefix}/verifier/reward.json`, 'upstream_reward', 'harbor-reward-json'],
        [`${trialPrefix}/verifier/verifier-result.json`, 'verifier_result', 'verifier-result-json'],
        [`${trialPrefix}/artifacts/trusted-collector/workspace.patch`, 'collected_patch', 'git-binary-patch'],
        [`${trialPrefix}/artifacts/trusted-collector/workspace-metadata.json`, 'collector_metadata', 'collector-metadata-v1']
      ] as const

  const runReferences = [
    ['harbor/job/result.json', 'harbor_job_result', 'harbor-job-result-0.22.0'],
    ['runner/harbor.stdout.log', 'runner_stdout', 'merged-text'],
    ['runner/harbor.stderr.log', 'runner_stderr', 'merged-text'],
    ['runner/process-control.json', 'runner_process_control', 'runner-process-control-v1']
  ] as const

  for (const [path, role, format] of [...runReferences, ...optionalReferences]) {
    if (records.raw.entries.some((entry) => entry.path === path)) {
      references.push(reference(records, path, role, format))
    }
  }

  references.sort((left, right) =>
    compareText(`${left.role}:${left.path}`, `${right.role}:${right.path}`)
  )

  return {
    evidence_availability: {
      native_rollout: nativeRollouts.length > 0 ? 'available' : 'unavailable',
      atif_trajectory: atifPath === undefined ? 'unavailable' : 'available',
      merged_agent_output: mergedPaths.length === 0 ? 'unavailable' : 'available'
    },

    references,
    score: await normalizedScore(records, trialPrefix),

    timings: {
      total_seconds: records.completion.timings.total_seconds,
      agent_seconds: timing(result, 'agent_execution'),
      verifier_seconds: timing(result, 'verifier')
    },

    usage: {
      input_tokens: knownOrUnknown(inputTokens),
      output_tokens: knownOrUnknown(outputTokens),

      subscription_money: {
        status: 'not_applicable',
        reason: 'Subscription money is not derived from token usage'
      },

      upstream_api_price_estimate: cost === undefined
        ? {
        status: 'unknown',
        reason: 'Harbor did not report a price estimate'
      }
        : {
            status: 'known',
            value: cost,
            currency: 'USD',
            provenance: 'Harbor 0.22.0 Codex ATIF metrics backed by upstream LiteLLM API-price estimation'
          }
    }
  }
}

function baseRecord(records: SourceRecords): Pick<
  NormalizedRunRecordV1,
  'identities' | 'revisions' | 'source_digests'
> {
  return {
    identities: {
      benchmark_repo_commit: records.initial.benchmark_repo_commit,
      run: records.initial.identity,
      stack: records.initial.stack,
      suite: records.initial.suite,
      task: records.initial.task,
      harness: records.initial.harness,
      experiment: records.initial.experiment,
      agent: records.initial.agent,
      network_policy_digest: records.initial.network_policy_digest,

      effective_permissions_digest:
        records.initial.effective_permissions_digest,

      mcp_tools_digest: records.initial.mcp_tools_digest,
      host: records.initial.host
    },

    revisions: {
      runner_name: 'harbor',
      runner_version: HARBOR_VERSION,
      runner_config_digest: records.initial.runner.config_digest,
      collector_revision: records.initial.collector.revision,
      collector_image_digest: records.initial.collector.image_digest,
      verifier_revision: records.initial.verifier.revision,
      verifier_image_digest: records.initial.verifier.image_digest,

      verifier_network_enforcement_sidecar_digest:
        records.initial.verifier.network_enforcement_sidecar_digest,

      scoring_revision: records.initial.scoring_revision
    },

    source_digests: {
      initial_record: records.initialDigest,
      completion_record: records.completionDigest,
      raw_manifest: records.manifestDigest
    }
  }
}

function timestamp(now: Date): string {
  if (Number.isNaN(now.getTime())) {
    throw new ResultError('INVALID_INPUT', 'Normalization clock is invalid', {
      stage: 'normalization'
    })
  }

  return now.toISOString()
}

async function assertFinalSnapshot(
  runDirectory: string,
  before: SourceRecords,
  runtime: NormalizeRuntime
): Promise<void> {
  await runtime.beforeFinalSnapshot?.()

  const after = await loadSourceRecords(runDirectory)

  if (after.signature !== before.signature) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Run source changed during normalization',
      { stage: 'normalization' }
    )
  }
}

type RestrictionFinding =
  RestrictedRunRecordV1['restriction']['findings'][number]

async function storeRestriction(
  resolved: { readonly runDirectory: string; readonly runsRoot: string },
  records: SourceRecords,
  createdAt: string,
  category: RestrictedRunRecordV1['restriction']['category'],
  findings: readonly RestrictionFinding[]
): Promise<NormalizeRunResult> {
  const restriction = v.parse(RestrictedRunRecordV1Schema, {
    document_type: 'restricted_run',
    schema_version: 1,
    normalization_revision: '1',
    record_type: 'restriction',
    created_at: createdAt,
    identity: records.initial.identity,
    source_digests: baseRecord(records).source_digests,

    restriction: {
      category,
      publication: 'blocked',
      rotation_or_revocation: 'pending',
      disposition: 'pending',
      findings
    }
  })

  const stored = await writeContentAddressedRecord(
    resolved.runsRoot,
    records.initial.identity.run_id,
    'restrictions',
    restriction
  )

  return {
    kind: 'restricted',
    ...stored,
    runDirectory: resolved.runDirectory
  }
}

async function normalizeResolvedRunWithRuntime(
  resolved: { readonly runDirectory: string; readonly runsRoot: string },
  runtime: NormalizeRuntime
): Promise<NormalizeRunResult> {
  const records = await loadSourceRecords(resolved.runDirectory)
  const quarantined = records.rawPath.startsWith('quarantine/')

  const scan = quarantined
    ? undefined
    : await scanCredentialTree({ root: records.rawRoot })

  if (scan !== undefined && scan.invalidEntries.length > 0) {
    throw new ResultError(
      'INTEGRITY_MISMATCH',
      'Raw evidence contains a symlink or special entry',
      { stage: 'normalization' }
    )
  }

  const rawFindings = scan?.findings.map((finding) => ({
    category: finding.category,
    path: `${records.rawPath}/${finding.path}`
  })) ?? []

  const credentialFindings = [
    ...records.metadataFindings,
    ...rawFindings
  ]

  if (quarantined || credentialFindings.length > 0) {
    await assertFinalSnapshot(resolved.runDirectory, records, runtime)

    if (quarantined) {
      const pathFindings = scanCredentialBytes(Buffer.from(records.rawPath), {
        path: '[redacted-path]'
      })

      const quarantinePath = pathFindings.length > 0
        ? '[redacted-path]'
        : records.rawPath

      return storeRestriction(
        resolved,
        records,
        timestamp(runtime.now()),
        'raw_quarantined',
        [{
          category: 'source_quarantined',
          path: quarantinePath
        }]
      )
    }

    return storeRestriction(
      resolved,
      records,
      timestamp(runtime.now()),
      'credential_detected',
      credentialFindings
    )
  }

  const evidence = await parseEvidence(records)

  await assertFinalSnapshot(resolved.runDirectory, records, runtime)

  const base = baseRecord(records)

  const normalized = v.parse(NormalizedRunRecordV1Schema, {
    document_type: 'normalized_run',
    schema_version: 1,
    normalization_revision: '1',
    record_type: 'normalized',
    created_at: timestamp(runtime.now()),
    ...base,

    outcome: {
      classification: records.completion.classification,
      termination: records.completion.termination,
      valid_grade: records.completion.valid_grade
    },

    ...evidence,
    retention: records.initial.retention,
    merged_output_semantics: 'irreversibly_merged_stdout_stderr'
  })

  const normalizedFindings = scanCredentialBytes(serializeRecord(normalized), {
    path: 'derived/normalized-record.json'
  })

  if (normalizedFindings.length > 0) {
    return storeRestriction(
      resolved,
      records,
      normalized.created_at,
      'credential_detected',
      normalizedFindings
    )
  }

  const stored = await writeContentAddressedRecord(
    resolved.runsRoot,
    records.initial.identity.run_id,
    'normalized',
    normalized
  )

  return {
    kind: 'normalized',
    ...stored,

    resolvedReferences: normalized.references.map((item) => ({
      localPath: resolve(resolved.runDirectory, item.path),
      relativePath: item.path,
      role: item.role
    })),

    runDirectory: resolved.runDirectory
  }
}

export async function normalizeRunWithRuntime(
  runDirectory: string,
  options: NormalizeRunOptions,
  runtime: NormalizeRuntime
): Promise<NormalizeRunResult> {
  const resolved = await resolveRunDirectory(runDirectory, options)
  const runId = basename(resolved.runDirectory)

  return withRunResultLock(
    resolved.runsRoot,
    runId,
    () => normalizeResolvedRunWithRuntime(resolved, runtime)
  )
}

export async function normalizeRun(
  runDirectory: string,
  options: NormalizeRunOptions = {}
): Promise<NormalizeRunResult> {
  return normalizeRunWithRuntime(runDirectory, options, {
    now: () => new Date()
  })
}
