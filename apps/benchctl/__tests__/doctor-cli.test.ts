import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../src/cli.ts'
import { prepareDoctorFixture, removeDoctorFixture } from '../../../tests/fixtures/doctor/fixture.ts'

const roots: string[] = []

afterEach(async () => { for (const root of roots.splice(0)) await removeDoctorFixture(root) })

describe('doctor CLI', () => {
  it.each([
    ['doctor'], ['doctor', 'definition.json'],
    ['doctor', 'definition.json', '--output-dir', 'relative'],
    ['doctor', 'definition.json', '--output-dir', '/tmp/output', '--purpose', 'guess'],
    ['doctor', 'definition.json', '--output-dir', '/tmp/output', '--provider', 'codex']
  ].map((args) => ({ args })))('rejects invalid invocation %j without a report', async ({ args }) => {
    let stdout = ''
    let stderr = ''

    expect(await runCli(args, {
      stdout: (value) => { stdout += value },
      stderr: (value) => { stderr += value }
    })).toBe(2)

    expect(stdout).toBe('')
    expect(stderr).not.toBe('')
  })

  it('reports quality ineligibility with exit 1 without starting Docker', async () => {
    const root = await mkdtemp('/tmp/harness-bench-doctor-cli-')

    roots.push(root)

    const definition = await prepareDoctorFixture(root)
    let stdout = ''
    let stderr = ''

    const exitCode = await runCli(['doctor', definition, '--output-dir', resolve(root, 'output')], {
      stdout: (value) => { stdout += value },
      stderr: (value) => { stderr += value }
    })

    expect(exitCode).toBe(1)
    expect(stdout).toContain('Allowed use: none')
    expect(stdout).toContain('[failed] ONLINE_REACHABILITY')
    expect(stdout).toContain('[not_run] RUNTIME_CONTROLS')
    expect(stderr).toBe('')
  })

  it('keeps an invalid definition and its raw values out of standard output and errors', async () => {
    const root = await mkdtemp('/tmp/harness-bench-doctor-cli-')

    roots.push(root)

    const definition = await prepareDoctorFixture(root)
    const document = JSON.parse(await readFile(definition, 'utf8'))

    document.controls = [{ secret: 'synthetic-private-value' }]

    await writeFile(definition, JSON.stringify(document))

    let output = ''

    const code = await runCli(['doctor', definition, '--output-dir', resolve(root, 'output')], {
      stdout: (value) => { output += value },
      stderr: (value) => { output += value }
    })

    expect(code).toBe(2)
    expect(output).toContain('INVALID_DEFINITION')
    expect(output).not.toContain('synthetic-private-value')
  })
})
