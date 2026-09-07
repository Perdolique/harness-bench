import { parseArgs } from 'node:util'
import { runDoctor } from '@harness-bench/core'
import { renderDoctorReport } from '@harness-bench/reporting'
import { CliUsageError } from './cli-contract.ts'
import type { CliIo } from './cli.ts'

export async function doctorCommand(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,

    options: {
      'output-dir': { type: 'string' },
      purpose: { type: 'string' }
    }
  })

  const definition = parsed.positionals[0]
  const output = parsed.values['output-dir']
  const purpose = parsed.values.purpose ?? 'quality'

  if (parsed.positionals.length !== 1 || definition === undefined || output === undefined || !['smoke', 'quality'].includes(purpose)) {
    throw new CliUsageError('Expected doctor DEFINITION --output-dir ABSOLUTE_NEW_DIR [--purpose smoke|quality]')
  }

  const report = await runDoctor({
    definition,
    outputDirectory: output,
    purpose: purpose as 'smoke' | 'quality'
  })

  io.stdout(renderDoctorReport(report))

  return report.exit_code
}
