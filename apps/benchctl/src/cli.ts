#!/usr/bin/env node

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import {
  captureHarnessBundle,
  diffHarnessBundles,
  isHarnessError,
  materializeHarnessBundle,
  validateHarnessBundle,
  type HarnessBundleDiff
} from '@harness-bench/core'

const USAGE = `Usage:
  benchctl harness capture --source DIR --store DIR --id ID --revision REV
  benchctl harness validate BUNDLE
  benchctl harness materialize BUNDLE --destination DIR
  benchctl harness diff LEFT RIGHT
`

class CliUsageError extends Error {}

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

async function dispatch(arguments_: readonly string[], io: CliIo): Promise<number> {
  const normalizedArguments =
    arguments_[0] === '--' ? arguments_.slice(1) : arguments_

  if (
    normalizedArguments.includes('--help') ||
    normalizedArguments.includes('-h')
  ) {
    io.stdout(USAGE)

    return 0
  }

  const [group, command, ...rest] = normalizedArguments

  if (group !== 'harness') {
    throw new CliUsageError('Expected the harness command group')
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
    if (isHarnessError(error)) {
      io.stderr(`${error.code}: ${error.message}\n`)
    } else if (error instanceof CliUsageError || isParseArgsError(error)) {
      io.stderr(`USAGE_ERROR: ${error.message}\n${USAGE}`)
    } else {
      io.stderr(`UNEXPECTED_ERROR: harness command failed\n`)
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
