import type { DoctorReport } from '../../core/src/doctor-contracts.ts'

function display(value: string): string {
  const encoded = JSON.stringify(value).slice(1, -1)

  return encoded.replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(4, '0')

    return `\\u${code}`
  })
}

/** Renders the completed diagnostic record without changing its conclusions. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines = [
    'Task integrity doctor',
    `Purpose: ${report.purpose}`,
    `Allowed use: ${report.allowed_use}`,
    `Exit code: ${report.exit_code}`,
    ''
  ]

  for (const check of report.checks) {
    lines.push(`[${check.status}] ${display(check.code)}: ${display(check.message)}`)

    if (check.failure_code !== null) lines.push(`  Stage: ${check.stage}; cause: ${display(check.failure_code)}`)

    if (check.action !== '') lines.push(`  Action: ${display(check.action)}`)

    for (const evidence of check.evidence) lines.push(`  Evidence: ${display(evidence)}`)
  }

  lines.push('', 'Limits:')

  for (const limitation of report.limitations) lines.push(`- ${display(limitation)}`)

  return `${lines.join('\n')}\n`
}
