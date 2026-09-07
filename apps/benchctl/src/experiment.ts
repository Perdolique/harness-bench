import { parseArgs, type ParseArgsOptionsConfig } from 'node:util'

import {
  executeExperiment,
  executeRunPlan,
  invalidateExperimentBlock,
  parseInvalidationCause,
  lockExperiment,
  planExperiment,
  readExperimentPlan,
  rerunExperimentBlock,
  saveExperimentPlan,
  type InvalidationCause,
  type ExperimentRuntime
} from '@harness-bench/core'

import { readExperimentState } from '@harness-bench/results'
import { renderExperimentPlan, renderExperimentReport } from '@harness-bench/reporting'
import { CliUsageError } from './cli-contract.ts'
import type { CliIo } from './cli.ts'

const runtime: ExperimentRuntime = {
  now: () => new Date(),
  readState: readExperimentState,
  execute: executeRunPlan
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new CliUsageError(`Missing required option: ${name}`)
  }

  return value
}
function experimentOptions(
  command: string | undefined
): ParseArgsOptionsConfig {
  switch (command) {
    case 'plan':
      return {
        'runs-dir': { type: 'string' },
        'dry-run': { type: 'boolean' }
      }
    case 'rerun-block':
      return {
        block: { type: 'string' },
        revision: { type: 'string' }
      }
    case 'invalidate':
      return {
        block: { type: 'string' },
        cause: { type: 'string' },
        reason: { type: 'string' }
      }
    case 'run':
    case 'resume':
    case 'report':
      return {}
    default:
      throw new CliUsageError(
        'Expected experiment plan, run, resume, report, rerun-block, or invalidate'
      )
  }
}
function invalidationCause(value: unknown): InvalidationCause {
  const selected = required(value, '--cause')

  try {
    return parseInvalidationCause(selected)
  } catch {
    throw new CliUsageError('Invalid --cause value')
  }
}
async function inspectExperiment(path: string): Promise<string> {
  const plan = await readExperimentPlan(path)
  const release = await lockExperiment(plan)

  try {
    const state = await readExperimentState(plan)

    return renderExperimentReport(state)
  } finally {
    await release()
  }
}
export async function experimentCommand(command: string | undefined, args: readonly string[], io: CliIo): Promise<number> {
  const options = experimentOptions(command)

  const parsed = parseArgs({
    args,
    options,
    allowPositionals: true,
    strict: true
  })

  if (parsed.positionals.length !== 1) {
    throw new CliUsageError(
      'Experiment command requires exactly one definition or plan file'
    )
  }

  const path = parsed.positionals[0]!

  if (command === 'plan') {
    const runsDirectory = required(parsed.values['runs-dir'], '--runs-dir')
    const plan = await planExperiment(path, runsDirectory)

    io.stdout(renderExperimentPlan(plan))

    if (!parsed.values['dry-run']) {
      const release = await lockExperiment(plan)

      try {
        const saved = await saveExperimentPlan(plan)

        io.stdout(`Plan: ${JSON.stringify(saved)}\n`)
      } finally { await release() }
    }

    return 0
  }

  if (command === 'run' || command === 'resume') {
    const state = await executeExperiment(path, command === 'resume', runtime)

    io.stdout(renderExperimentReport(state))

    if (state.blocks.some(({ status }) => status !== 'completed')) return 2

    const failed = state.blocks.some(({ runs }) => runs.some(({ result }) => result?.classification === 'task_failure'))

    return failed ? 1 : 0
  }

  if (command === 'report') {
    const report = await inspectExperiment(path)

    io.stdout(report)

    return 0
  }

  if (command === 'rerun-block') {
    const block = required(parsed.values.block, '--block')
    const revision = required(parsed.values.revision, '--revision')
    const saved = await rerunExperimentBlock(path, block, revision, runtime)
    const report = await inspectExperiment(saved)

    io.stdout(report)
    io.stdout(`Plan: ${JSON.stringify(saved)}\n`)

    return 0
  }

  if (command === 'invalidate') {
    const block = required(parsed.values.block, '--block')
    const cause = invalidationCause(parsed.values.cause)
    const reason = required(parsed.values.reason, '--reason')

    await invalidateExperimentBlock(path, block, cause, reason)
    io.stdout('Block invalidated; retained attempts are unchanged\n')

    return 0
  }

  throw new Error('Unreachable experiment command')
}
