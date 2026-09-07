#!/usr/bin/env node

import { experimentCommand } from './experiment.ts'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { renderSingleRunReport } from '@harness-bench/reporting'

import {
  captureHarnessBundle,
  diffHarnessBundles,
  isHarnessError,
  isRunError,
  materializeHarnessBundle,
  resolveRunPlan,
  executeRunPlan,
  validateHarnessBundle,
  type HarnessBundleDiff
} from '@harness-bench/core'

import {
  disposeRun,
  exportSanitizedResult,
  isResultError,
  normalizeRun,
  readNormalizedRunRecord,
  type CredentialAction,
  type DisposeDisposition,
  type DisposeReason,
  type DisposeRunOptions
} from '@harness-bench/results'

import { CLI_SYNOPSIS, CliUsageError } from './cli-contract.ts'

export interface CliIo {
  readonly stderr: (value: string) => void;
  readonly stdout: (value: string) => void;
}

const processIo: CliIo = {
  stderr: (value) => process.stderr.write(value),
  stdout: (value) => process.stdout.write(value)
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`)
}

function requiredOption(
  value: string | undefined,
  name: string
): string {
  if (value === undefined || value === '') {
    throw new CliUsageError(`Missing required option: --${name}`)
  }

  return value
}

function requiredOptions(
  value: string[] | undefined,
  name: string
): readonly string[] {
  if (
    value === undefined ||
    value.length === 0 ||
    value.some((entry) => entry === '')
  ) {
    throw new CliUsageError(`Missing required option: --${name}`)
  }

  return value
}

function runExitCode(classification: string): number {
  if (classification === 'task_success') {
    return 0
  }

  if (classification === 'task_failure') {
    return 1
  }

  return 2
}

function shortDigest(digest: string): string {
  const prefixLength = 'sha256:'.length
  const short = digest.slice(prefixLength, prefixLength + 12)

  return short
}

function escapeDisplayText(value: string): string {
  const serialized = JSON.stringify(value)
  const escaped = serialized.slice(1, -1)

  return escaped
}

function renderDiff(diff: HarnessBundleDiff): string {
  const leftId = escapeDisplayText(diff.left.harness_id)
  const leftRevision = escapeDisplayText(diff.left.revision)
  const rightId = escapeDisplayText(diff.right.harness_id)
  const rightRevision = escapeDisplayText(diff.right.revision)

  const lines = [
    `left  ${leftId}@${leftRevision} ${diff.left.digest}`,
    `right ${rightId}@${rightRevision} ${diff.right.digest}`
  ]

  for (const difference of diff.identityDifferences) {
    const left = escapeDisplayText(difference.left)
    const right = escapeDisplayText(difference.right)

    lines.push(
      `~ identity ${difference.field} ${left} -> ${right}`
    )
  }

  for (const difference of diff.entryDifferences) {
    if (difference.kind === 'added') {
      const path = escapeDisplayText(difference.entry.path)
      const digest = shortDigest(difference.entry.digest)

      lines.push(
        `+ ${difference.entry.kind} ${path} ${digest}`
      )
    } else if (difference.kind === 'removed') {
      const path = escapeDisplayText(difference.entry.path)
      const digest = shortDigest(difference.entry.digest)

      lines.push(
        `- ${difference.entry.kind} ${path} ${digest}`
      )
    } else {
      const path = escapeDisplayText(difference.path)
      const leftDigest = shortDigest(difference.left.digest)
      const rightDigest = shortDigest(difference.right.digest)

      lines.push(
        `~ ${difference.right.kind} ${path} ${leftDigest} -> ${rightDigest}`
      )
    }
  }

  if (!diff.different) {
    lines.push('identical')
  }

  return `${lines.join('\n')}\n`
}

async function capture(arguments_: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: false,

    options: {
      id: { type: 'string' },
      revision: { type: 'string' },
      source: { type: 'string' },
      store: { type: 'string' }
    },

    strict: true
  })

  const result = await captureHarnessBundle({
    harnessId: requiredOption(parsed.values.id, 'id'),
    revision: requiredOption(parsed.values.revision, 'revision'),
    source: requiredOption(parsed.values.source, 'source'),
    store: requiredOption(parsed.values.store, 'store')
  })

  writeJson(io, {
    bundle_path: result.bundlePath,
    digest: result.manifest.digest,
    harness_id: result.manifest.harness_id,
    revision: result.manifest.revision
  })

  return 0
}

async function validate(arguments_: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: true,
    strict: true
  })

  if (parsed.positionals.length !== 1) {
    throw new CliUsageError('validate requires exactly one BUNDLE argument')
  }

  const bundle = parsed.positionals[0]

  if (bundle === undefined) {
    throw new CliUsageError('validate requires a BUNDLE argument')
  }

  const result = await validateHarnessBundle(bundle)

  writeJson(io, {
    bundle_path: result.bundlePath,
    digest: result.manifest.digest,
    entry_count: result.manifest.entries.length,
    harness_id: result.manifest.harness_id,
    revision: result.manifest.revision
  })

  return 0
}

async function materialize(
  arguments_: readonly string[],
  io: CliIo
): Promise<number> {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: true,
    options: { destination: { type: 'string' } },
    strict: true
  })

  if (parsed.positionals.length !== 1) {
    throw new CliUsageError('materialize requires exactly one BUNDLE argument')
  }

  const bundle = parsed.positionals[0]

  if (bundle === undefined) {
    throw new CliUsageError('materialize requires a BUNDLE argument')
  }

  const result = await materializeHarnessBundle({
    bundle,
    destination: requiredOption(parsed.values.destination, 'destination')
  })

  writeJson(io, {
    bundle_digest: result.bundleDigest,
    codex_home: result.codexHome,
    home: result.home,
    mcp_tools_path: result.mcpToolsPath,
    root: result.root,
    workspace: result.workspace
  })

  return 0
}

async function diff(arguments_: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: true,
    strict: true
  })

  if (parsed.positionals.length !== 2) {
    throw new CliUsageError('diff requires LEFT and RIGHT bundle arguments')
  }

  const left = parsed.positionals[0]
  const right = parsed.positionals[1]

  if (left === undefined || right === undefined) {
    throw new CliUsageError('diff requires LEFT and RIGHT bundle arguments')
  }

  const result = await diffHarnessBundles(left, right)

  io.stdout(renderDiff(result))

  return result.different ? 1 : 0
}

async function run(arguments_: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: false,

    options: {
      'dry-run': {
        type: 'boolean',
        default: false
      },

      experiment: { type: 'string' },
      'harness-bundle': { type: 'string' },

      'harness-document': {
        type: 'string',
        multiple: true
      },

      'run-id': { type: 'string' },
      'runs-dir': { type: 'string' },

      stack: {
        type: 'string',
        multiple: true
      },

      suite: { type: 'string' },

      task: {
        type: 'string',
        multiple: true
      },

      'task-package': { type: 'string' },
      'task-source': { type: 'string' }
    },

    strict: true
  })

  const plan = await resolveRunPlan({
    experiment: requiredOption(parsed.values.experiment, 'experiment'),

    harnessBundle: requiredOption(
      parsed.values['harness-bundle'],
      'harness-bundle'
    ),

    harnessDocuments: requiredOptions(
      parsed.values['harness-document'],
      'harness-document'
    ),

    runId: requiredOption(parsed.values['run-id'], 'run-id'),
    runsDirectory: requiredOption(parsed.values['runs-dir'], 'runs-dir'),
    stackDocuments: requiredOptions(parsed.values.stack, 'stack'),
    suite: requiredOption(parsed.values.suite, 'suite'),
    taskDocuments: requiredOptions(parsed.values.task, 'task'),
    taskPackage: requiredOption(parsed.values['task-package'], 'task-package'),
    taskSource: requiredOption(parsed.values['task-source'], 'task-source')
  })

  if (parsed.values['dry-run']) {
    writeJson(io, {
      dry_run: true,
      plan,
      status: 'resolved'
    })

    return 0
  }

  io.stderr('RUNNING: Harbor execution started\n')

  const result = await executeRunPlan(plan)

  io.stderr(`COMPLETED: ${result.classification}\n`)
  writeJson(io, result)

  return runExitCode(result.classification)
}

async function normalizeResult(
  arguments_: readonly string[],
  io: CliIo
): Promise<number> {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: true,
    strict: true
  })

  if (parsed.positionals.length !== 1 || parsed.positionals[0] === undefined) {
    throw new CliUsageError('results normalize requires exactly one RUN_DIR')
  }

  const result = await normalizeRun(parsed.positionals[0])

  const runId = result.kind === 'normalized'
    ? result.record.identities.run.run_id
    : result.record.identity.run_id

  writeJson(io, {
    status: result.kind,
    run_id: runId,
    digest: result.digest,
    record_path: result.recordPath,

    ...(result.kind === 'restricted'
      ? {
          publication: 'blocked',

          owner_actions: {
            rotation_or_revocation: 'pending',
            disposition: 'pending'
          }
        }
      : {})
  })

  return result.kind === 'normalized' ? 0 : 2
}

async function reportResult(arguments_: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: true,
    strict: true
  })

  if (parsed.positionals.length !== 1 || parsed.positionals[0] === undefined) {
    throw new CliUsageError('results report requires exactly one NORMALIZED_RECORD')
  }

  const source = await readNormalizedRunRecord(parsed.positionals[0])
  const report = renderSingleRunReport(source)

  io.stdout(report)

  return 0
}

async function exportResult(
  arguments_: readonly string[],
  io: CliIo
): Promise<number> {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: true,
    strict: true
  })

  if (parsed.positionals.length !== 1 || parsed.positionals[0] === undefined) {
    throw new CliUsageError(
      'results export requires exactly one NORMALIZED_RECORD'
    )
  }

  const result = await exportSanitizedResult(parsed.positionals[0])

  writeJson(io, {
    status: 'exported',
    digest: result.digest,
    record_path: result.recordPath,
    publication_authorized: false
  })

  return 0
}

function disposeReason(value: string): DisposeReason {
  if (
    value === 'retention-expired' ||
    value === 'owner-request' ||
    value === 'credential-detected'
  ) {
    return value
  }

  throw new CliUsageError('Invalid --reason value')
}

function disposeDisposition(value: string): DisposeDisposition {
  if (value === 'delete' || value === 'incident-retain') {
    return value
  }

  throw new CliUsageError('Invalid --disposition value')
}

function credentialAction(
  value: string | undefined
): CredentialAction | undefined {
  if (value === undefined || value === 'rotated' || value === 'revoked') {
    return value
  }

  throw new CliUsageError('Invalid --credential-action value')
}

function validateDisposeCliOptions(
  reason: DisposeReason,
  disposition: DisposeDisposition,
  selectedCredentialAction: CredentialAction | undefined,
  incidentExpiresAt: string | undefined
): void {
  const credentialDisposition = reason === 'credential-detected'
  const incidentRetention = disposition === 'incident-retain'

  if (credentialDisposition && selectedCredentialAction === undefined) {
    throw new CliUsageError(
      'credential-detected requires --credential-action rotated|revoked'
    )
  }

  if (!credentialDisposition && selectedCredentialAction !== undefined) {
    throw new CliUsageError(
      '--credential-action is only valid with --reason credential-detected'
    )
  }

  if (incidentRetention && !credentialDisposition) {
    throw new CliUsageError(
      'incident-retain is only valid with --reason credential-detected'
    )
  }

  if (incidentRetention && incidentExpiresAt === undefined) {
    throw new CliUsageError(
      'incident-retain requires --incident-expires-at ISO_TIMESTAMP'
    )
  }

  if (!incidentRetention && incidentExpiresAt !== undefined) {
    throw new CliUsageError(
      '--incident-expires-at is only valid with --disposition incident-retain'
    )
  }
}

async function disposeResult(
  arguments_: readonly string[],
  io: CliIo
): Promise<number> {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: true,

    options: {
      'confirm-run-id': { type: 'string' },
      'credential-action': { type: 'string' },
      disposition: { type: 'string' },
      'incident-expires-at': { type: 'string' },
      reason: { type: 'string' }
    },

    strict: true
  })

  if (parsed.positionals.length !== 1 || parsed.positionals[0] === undefined) {
    throw new CliUsageError('results dispose requires exactly one RUN_DIR')
  }

  const selectedCredentialAction = credentialAction(
    parsed.values['credential-action']
  )

  const selectedReason = disposeReason(
    requiredOption(parsed.values.reason, 'reason')
  )

  const selectedDisposition = disposeDisposition(
    requiredOption(parsed.values.disposition, 'disposition')
  )

  const incidentExpiresAt = parsed.values['incident-expires-at']

  validateDisposeCliOptions(
    selectedReason,
    selectedDisposition,
    selectedCredentialAction,
    incidentExpiresAt
  )

  const confirmRunId = requiredOption(
    parsed.values['confirm-run-id'],
    'confirm-run-id'
  )

  let disposeOptions: DisposeRunOptions

  if (selectedCredentialAction !== undefined && incidentExpiresAt !== undefined) {
    disposeOptions = {
      confirmRunId,
      credentialAction: selectedCredentialAction,
      disposition: selectedDisposition,
      incidentExpiresAt,
      reason: selectedReason
    }
  } else if (selectedCredentialAction !== undefined) {
    disposeOptions = {
      confirmRunId,
      credentialAction: selectedCredentialAction,
      disposition: selectedDisposition,
      reason: selectedReason
    }
  } else if (incidentExpiresAt !== undefined) {
    disposeOptions = {
      confirmRunId,
      disposition: selectedDisposition,
      incidentExpiresAt,
      reason: selectedReason
    }
  } else {
    disposeOptions = {
      confirmRunId,
      disposition: selectedDisposition,
      reason: selectedReason
    }
  }

  const result = await disposeRun(parsed.positionals[0], disposeOptions)

  writeJson(io, {
    status: result.record.disposition === 'delete'
      ? 'deleted'
      : 'incident-retained',

    run_id: result.record.identity.run_id,
    digest: result.digest,
    record_path: result.recordPath
  })

  return 0
}

async function dispatch(arguments_: readonly string[], io: CliIo): Promise<number> {
  const normalizedArguments =
    arguments_[0] === '--' ? arguments_.slice(1) : arguments_

  if (
    normalizedArguments.includes('--help') ||
    normalizedArguments.includes('-h')
  ) {
    io.stdout(CLI_SYNOPSIS)

    return 0
  }

  const [group, command, ...rest] = normalizedArguments

  if (group === 'experiment') return experimentCommand(command, rest, io)

  if (group === 'run') {
    return run(normalizedArguments.slice(1), io)
  }

  if (group === 'results') {
    if (command === 'report') {
      return reportResult(rest, io)
    }

    if (command === 'normalize') {
      return normalizeResult(rest, io)
    }

    if (command === 'export') {
      return exportResult(rest, io)
    }

    if (command === 'dispose') {
      return disposeResult(rest, io)
    }

    throw new CliUsageError('Expected normalize, report, export, or dispose')
  }

  if (group !== 'harness') {
    throw new CliUsageError(
      'Expected experiment, run, harness, or results command group'
    )
  }

  if (command === 'capture') {
    return capture(rest, io)
  }

  if (command === 'validate') {
    return validate(rest, io)
  }

  if (command === 'materialize') {
    return materialize(rest, io)
  }

  if (command === 'diff') {
    return diff(rest, io)
  }

  throw new CliUsageError('Expected capture, validate, materialize, or diff')
}

function isParseArgsError(
  error: unknown
): error is Error & { readonly code: string } {
  if (!(error instanceof Error) || !('code' in error)) {
    return false
  }

  return (
    typeof error.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS_')
  )
}

export async function runCli(
  arguments_: readonly string[],
  io: CliIo = processIo
): Promise<number> {
  try {
    return await dispatch(arguments_, io)
  } catch (error) {
    if (isRunError(error)) {
      io.stderr(`${error.code}: ${error.message}\n`)
    } else if (isResultError(error)) {
      io.stderr(`${error.code}: ${error.message}\n`)
    } else if (isHarnessError(error)) {
      io.stderr(`${error.code}: ${error.message}\n`)
    } else if (isParseArgsError(error)) {
      io.stderr(`USAGE_ERROR: Invalid command arguments\n${CLI_SYNOPSIS}`)
    } else if (error instanceof CliUsageError) {
      io.stderr(`USAGE_ERROR: ${error.message}\n${CLI_SYNOPSIS}`)
    } else {
      io.stderr(`UNEXPECTED_ERROR: command failed\n`)
    }

    return 2
  }
}

const invokedPath = process.argv[1]

if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  process.exitCode = await runCli(process.argv.slice(2))
}
