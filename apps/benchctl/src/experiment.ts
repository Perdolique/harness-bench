import { parseArgs } from 'node:util'

import {
  executeExperiment,
  executeRunPlan,
  invalidateExperimentBlock,
  parseInvalidationCause,
  lockExperiment,
  planExperiment,
  readExperimentPlan,
  rerunExperimentBlock,
  RunError,
  saveExperimentPlan,
  type ExperimentRuntime
} from '@harness-bench/core'

import { readExperimentState } from '@harness-bench/results'
import { renderExperimentPlan, renderExperimentReport } from '@harness-bench/reporting'
import type { CliIo } from './cli.ts'

const runtime: ExperimentRuntime = {
  now: () => new Date(),
  readState: readExperimentState,
  execute: executeRunPlan
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new RunError('INVALID_DOCUMENT', `Missing ${name}`)

  return value
}
export async function experimentCommand(command: string | undefined, args: readonly string[], io: CliIo): Promise<number> {
  const options = command === 'plan'
    ? {
      'runs-dir': { type: 'string' as const },
      'dry-run': { type: 'boolean' as const }
    }
    : command === 'rerun-block'
      ? {
        block: { type: 'string' as const },
        revision: { type: 'string' as const }
      }
      : command === 'invalidate'
        ? {
          block: { type: 'string' as const },
          cause: { type: 'string' as const },
          reason: { type: 'string' as const }
        }
        : {}

  const parsed = parseArgs({
    args,
    options,
    allowPositionals: true,
    strict: true
  })

  if (parsed.positionals.length !== 1) throw new RunError('INVALID_DOCUMENT', 'Experiment command requires exactly one definition or plan file')

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
    const plan = await readExperimentPlan(path)
    const state = await readExperimentState(plan)

    io.stdout(renderExperimentReport(state))

    return 0
  }

  if (command === 'rerun-block') {
    const block = required(parsed.values.block, '--block')
    const revision = required(parsed.values.revision, '--revision')
    const saved = await rerunExperimentBlock(path, block, revision, runtime)
    const plan = await readExperimentPlan(saved)
    const state = await readExperimentState(plan)

    io.stdout(renderExperimentReport(state))
    io.stdout(`Plan: ${JSON.stringify(saved)}\n`)

    return 0
  }

  if (command === 'invalidate') {
    const block = required(parsed.values.block, '--block')
    const cause = parseInvalidationCause(parsed.values.cause)
    const reason = required(parsed.values.reason, '--reason')

    await invalidateExperimentBlock(path, block, cause, reason)
    io.stdout('Block invalidated; retained attempts are unchanged\n')

    return 0
  }

  throw new RunError('INVALID_DOCUMENT', 'Expected experiment plan, run, resume, report, rerun-block, or invalidate')
}
