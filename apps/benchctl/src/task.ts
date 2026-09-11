import { parseArgs } from 'node:util'

import {
  disposeTaskImport,
  importTaskSource,
  materializeTaskImport,
  recoverTaskImportDisposal,
  validateTaskImport,
  type TaskImportCredentialAction,
  type TaskImportDisposeReason
} from '@harness-bench/core'

import { CliUsageError } from './cli-contract.ts'
import type { CliIo } from './cli.ts'

function requiredOption(value: string | undefined, name: string): string {
  if (value === undefined || value === '') {
    throw new CliUsageError(`Missing required option: --${name}`)
  }

  return value
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`)
}

function requiredPath(positionals: readonly string[], command: string): string {
  if (positionals.length !== 1 || positionals[0] === undefined) {
    throw new CliUsageError(`task ${command} requires exactly one path argument`)
  }

  return positionals[0]
}

function parseImportArguments(arguments_: readonly string[]): {
  readonly definition: string;
  readonly store: string;
} {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: true,
    options: { store: { type: 'string' } },
    strict: true
  })

  return {
    definition: requiredPath(parsed.positionals, 'import'),
    store: requiredOption(parsed.values.store, 'store')
  }
}

function parseValidateArguments(arguments_: readonly string[]): string {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: true,
    options: {},
    strict: true
  })

  return requiredPath(parsed.positionals, 'validate')
}

function parseMaterializeArguments(arguments_: readonly string[]): {
  readonly destination: string;
  readonly importPath: string;
} {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: true,
    options: { destination: { type: 'string' } },
    strict: true
  })

  return {
    destination: requiredOption(parsed.values.destination, 'destination'),
    importPath: requiredPath(parsed.positionals, 'materialize')
  }
}

function disposeReason(value: string): TaskImportDisposeReason {
  if (
    value === 'owner-request' ||
    value === 'retention-expired' ||
    value === 'credential-detected'
  ) {
    return value
  }

  throw new CliUsageError('Invalid --reason value')
}

function credentialAction(value: string | undefined): TaskImportCredentialAction | undefined {
  if (value === undefined || value === 'rotated' || value === 'revoked') return value

  throw new CliUsageError('Invalid --credential-action value')
}

function parseDisposeArguments(arguments_: readonly string[]): {
  readonly confirmImportDigest: string;
  readonly credentialAction: TaskImportCredentialAction | undefined;
  readonly importPath: string;
  readonly reason: TaskImportDisposeReason;
} {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: true,

    options: {
      'confirm-import-digest': { type: 'string' },
      'credential-action': { type: 'string' },
      reason: { type: 'string' }
    },

    strict: true
  })

  const reason = disposeReason(requiredOption(parsed.values.reason, 'reason'))
  const selectedCredentialAction = credentialAction(parsed.values['credential-action'])

  if (reason === 'credential-detected' && selectedCredentialAction === undefined) {
    throw new CliUsageError(
      'credential-detected requires --credential-action rotated|revoked'
    )
  }

  if (reason !== 'credential-detected' && selectedCredentialAction !== undefined) {
    throw new CliUsageError(
      '--credential-action is only valid with --reason credential-detected'
    )
  }

  return {
    confirmImportDigest: requiredOption(
      parsed.values['confirm-import-digest'],
      'confirm-import-digest'
    ),

    credentialAction: selectedCredentialAction,
    importPath: requiredPath(parsed.positionals, 'dispose'),
    reason
  }
}

function parseRecoverArguments(arguments_: readonly string[]): {
  readonly confirmImportDigest: string;
  readonly importPath: string;
} {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: true,
    options: { 'confirm-import-digest': { type: 'string' } },
    strict: true
  })

  return {
    confirmImportDigest: requiredOption(
      parsed.values['confirm-import-digest'],
      'confirm-import-digest'
    ),

    importPath: requiredPath(parsed.positionals, 'recover')
  }
}

async function importTask(arguments_: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseImportArguments(arguments_)

  const result = await importTaskSource({
    definition: parsed.definition,
    store: parsed.store
  })

  writeJson(io, {
    status: 'imported',
    import_path: result.importPath,
    import_digest: result.manifest.import_digest,
    source_digest: result.manifest.source_digest,
    materialized_base_commit: result.manifest.materialized_base_commit,
    task_id: result.manifest.task_id,
    task_revision: result.manifest.task_revision
  })

  return 0
}

async function validateTask(arguments_: readonly string[], io: CliIo): Promise<number> {
  const importPath = parseValidateArguments(arguments_)
  const result = await validateTaskImport(importPath)

  if (result.kind === 'active') {
    writeJson(io, {
      status: 'active',
      import_path: result.importPath,
      import_digest: result.manifest.import_digest,
      source_digest: result.manifest.source_digest,
      materialized_base_commit: result.manifest.materialized_base_commit,
      task_id: result.manifest.task_id,
      task_revision: result.manifest.task_revision
    })
  } else {
    writeJson(io, {
      status: 'disposed',
      import_path: result.importPath,
      import_digest: result.tombstone.import_digest,
      source_digest: result.tombstone.source_digest,
      tombstone_digest: result.tombstone.tombstone_digest,
      task_id: result.tombstone.task_id,
      task_revision: result.tombstone.task_revision
    })
  }

  return 0
}

async function materializeTask(arguments_: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseMaterializeArguments(arguments_)

  const result = await materializeTaskImport({
    destination: parsed.destination,
    importPath: parsed.importPath
  })

  writeJson(io, {
    status: 'materialized',
    import_digest: result.importDigest,
    source_digest: result.sourceDigest,
    base_commit: result.baseCommit,
    workspace: result.workspace
  })

  return 0
}

async function disposeTask(arguments_: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseDisposeArguments(arguments_)

  const options = parsed.credentialAction === undefined
    ? {
        confirmImportDigest: parsed.confirmImportDigest,
        reason: parsed.reason
      }
    : {
        confirmImportDigest: parsed.confirmImportDigest,
        credentialAction: parsed.credentialAction,
        reason: parsed.reason
      }

  const result = await disposeTaskImport(parsed.importPath, options)

  writeJson(io, {
    status: 'disposed',
    import_path: result.importPath,
    import_digest: result.tombstone.import_digest,
    source_digest: result.tombstone.source_digest,
    tombstone_digest: result.tombstone.tombstone_digest,
    task_id: result.tombstone.task_id,
    task_revision: result.tombstone.task_revision
  })

  return 0
}

async function recoverTask(arguments_: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseRecoverArguments(arguments_)

  const result = await recoverTaskImportDisposal(parsed.importPath, {
    confirmImportDigest: parsed.confirmImportDigest
  })

  if (result.kind === 'active') {
    writeJson(io, {
      status: 'recovered',
      kind: 'active',
      import_path: result.importPath,
      import_digest: result.manifest.import_digest,
      source_digest: result.manifest.source_digest,
      materialized_base_commit: result.manifest.materialized_base_commit,
      task_id: result.manifest.task_id,
      task_revision: result.manifest.task_revision
    })
  } else {
    writeJson(io, {
      status: 'recovered',
      kind: 'disposed',
      import_path: result.importPath,
      import_digest: result.tombstone.import_digest,
      source_digest: result.tombstone.source_digest,
      tombstone_digest: result.tombstone.tombstone_digest,
      task_id: result.tombstone.task_id,
      task_revision: result.tombstone.task_revision
    })
  }

  return 0
}

export async function taskCommand(
  command: string | undefined,
  arguments_: readonly string[],
  io: CliIo
): Promise<number> {
  if (command === 'import') return importTask(arguments_, io)

  if (command === 'validate') return validateTask(arguments_, io)

  if (command === 'materialize') return materializeTask(arguments_, io)

  if (command === 'dispose') return disposeTask(arguments_, io)

  if (command === 'recover') return recoverTask(arguments_, io)

  throw new CliUsageError('Expected task import, validate, materialize, dispose, or recover')
}
