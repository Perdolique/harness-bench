import { beforeEach, describe, expect, it, vi } from 'vitest'

const normalizeRun = vi.fn()
const exportSanitizedResult = vi.fn()
const disposeRun = vi.fn()

vi.mock('@harness-bench/results', async (importOriginal) => ({
  ...await importOriginal<typeof import('@harness-bench/results')>(),
  disposeRun,
  exportSanitizedResult,
  normalizeRun
}))

const { runCli } = await import('../src/cli.ts')
const { ResultError } = await import('@harness-bench/results')

function output() {
  const stderr: string[] = []
  const stdout: string[] = []

  return {
    stderr,
    stdout,

    io: {
      stderr: (value: string) => stderr.push(value),
      stdout: (value: string) => stdout.push(value)
    }
  }
}

beforeEach(() => {
  normalizeRun.mockReset()
  exportSanitizedResult.mockReset()
  disposeRun.mockReset()
})

describe('benchctl results', () => {
  it('normalizes a run with JSON and exit zero', async () => {
    normalizeRun.mockResolvedValue({
      kind: 'normalized',
      digest: `sha256:${'a'.repeat(64)}`,
      recordPath: '/runs/.results/run-a/normalized/address/record.json',
      runDirectory: '/runs/run-a',
      record: { identities: { run: { run_id: 'run-a' } } }
    })

    const captured = output()

    const exitCode = await runCli(
      ['results', 'normalize', '/runs/run-a'],
      captured.io
    )

    expect(exitCode).toBe(0)
    expect(normalizeRun).toHaveBeenCalledWith('/runs/run-a')

    expect(JSON.parse(captured.stdout.join(''))).toStrictEqual({
      status: 'normalized',
      run_id: 'run-a',
      digest: `sha256:${'a'.repeat(64)}`,
      record_path: '/runs/.results/run-a/normalized/address/record.json'
    })

    expect(captured.stderr).toEqual([])
  })

  it('returns safe restriction JSON and exit two', async () => {
    normalizeRun.mockResolvedValue({
      kind: 'restricted',
      digest: `sha256:${'b'.repeat(64)}`,
      recordPath: '/runs/.results/run-a/restrictions/address/record.json',
      runDirectory: '/runs/run-a',
      record: { identity: { run_id: 'run-a' } }
    })

    const captured = output()

    const exitCode = await runCli(
      ['results', 'normalize', '/runs/run-a'],
      captured.io
    )

    expect(exitCode).toBe(2)

    expect(JSON.parse(captured.stdout.join(''))).toStrictEqual({
      status: 'restricted',
      run_id: 'run-a',
      digest: `sha256:${'b'.repeat(64)}`,
      record_path: '/runs/.results/run-a/restrictions/address/record.json',
      publication: 'blocked',

      owner_actions: {
        rotation_or_revocation: 'pending',
        disposition: 'pending'
      }
    })
  })

  it('exports metadata without claiming publication authorization', async () => {
    exportSanitizedResult.mockResolvedValue({
      digest: `sha256:${'c'.repeat(64)}`,
      recordPath: '/runs/.results/run-a/exports/address/record.json',
      record: {}
    })

    const captured = output()

    const exitCode = await runCli(
      ['results', 'export', '/normalized/record.json'],
      captured.io
    )

    expect(exitCode).toBe(0)
    expect(exportSanitizedResult).toHaveBeenCalledWith('/normalized/record.json')

    expect(JSON.parse(captured.stdout.join(''))).toStrictEqual({
      status: 'exported',
      digest: `sha256:${'c'.repeat(64)}`,
      record_path: '/runs/.results/run-a/exports/address/record.json',
      publication_authorized: false
    })
  })

  it('passes explicit credential disposition attestation', async () => {
    disposeRun.mockResolvedValue({
      digest: `sha256:${'d'.repeat(64)}`,
      recordPath: '/runs/run-a/address/record.json',

      record: {
        disposition: 'incident-retain',
        identity: { run_id: 'run-a' }
      }
    })

    const captured = output()

    const exitCode = await runCli([
      'results',
      'dispose',
      '/runs/run-a',
      '--confirm-run-id',
      'run-a',
      '--reason',
      'credential-detected',
      '--disposition',
      'incident-retain',
      '--credential-action',
      'revoked',
      '--incident-expires-at',
      '2026-10-01T00:00:00Z'
    ], captured.io)

    expect(exitCode).toBe(0)

    expect(disposeRun).toHaveBeenCalledWith('/runs/run-a', {
      confirmRunId: 'run-a',
      credentialAction: 'revoked',
      disposition: 'incident-retain',
      incidentExpiresAt: '2026-10-01T00:00:00Z',
      reason: 'credential-detected'
    })

    expect(JSON.parse(captured.stdout.join(''))).toStrictEqual({
      status: 'incident-retained',
      run_id: 'run-a',
      digest: `sha256:${'d'.repeat(64)}`,
      record_path: '/runs/run-a/address/record.json'
    })
  })

  it.each([
    [
      'credential action',
      [
        'results',
        'dispose',
        '/runs/run-a',
        '--confirm-run-id',
        'run-a',
        '--reason',
        'credential-detected',
        '--disposition',
        'delete'
      ]
    ],
    [
      'incident expiry',
      [
        'results',
        'dispose',
        '/runs/run-a',
        '--confirm-run-id',
        'run-a',
        '--reason',
        'credential-detected',
        '--disposition',
        'incident-retain',
        '--credential-action',
        'rotated'
      ]
    ]
  ])('requires an explicit %s before disposition', async (_name, arguments_) => {
    const captured = output()
    const exitCode = await runCli(arguments_, captured.io)

    expect(exitCode).toBe(2)
    expect(captured.stdout).toEqual([])
    expect(captured.stderr.join('')).toContain('USAGE_ERROR')
    expect(disposeRun).not.toHaveBeenCalled()
  })

  it('prints safe result errors without their raw cause', async () => {
    const sentinel = 'raw-secret-cause'

    normalizeRun.mockRejectedValue(
      new ResultError('INTEGRITY_MISMATCH', 'Safe integrity failure', {
        cause: new Error(sentinel)
      })
    )

    const captured = output()

    const exitCode = await runCli(
      ['results', 'normalize', '/runs/run-a'],
      captured.io
    )

    expect(exitCode).toBe(2)
    expect(captured.stdout).toEqual([])

    expect(captured.stderr.join('')).toBe(
      'INTEGRITY_MISMATCH: Safe integrity failure\n'
    )

    expect(captured.stderr.join('')).not.toContain(sentinel)
  })

  it.each([
    ['results', 'normalize'],
    ['results', 'export'],
    ['results', 'dispose', '/runs/run-a']
  ])('rejects incomplete arguments with exit two', async (...arguments_) => {
    const captured = output()
    const exitCode = await runCli(arguments_, captured.io)

    expect(exitCode).toBe(2)
    expect(captured.stdout).toEqual([])
    expect(captured.stderr.join('')).toContain('USAGE_ERROR')
  })

  it.each([
    [
      'normalize unknown flag',
      ['results', 'normalize', '/runs/run-a', '--unknown']
    ],
    [
      'normalize extra positional',
      ['results', 'normalize', '/runs/run-a', 'extra']
    ],
    [
      'export unknown flag',
      ['results', 'export', '/normalized/record.json', '--unknown']
    ],
    [
      'export extra positional',
      ['results', 'export', '/normalized/record.json', 'extra']
    ],
    [
      'invalid reason',
      [
        'results', 'dispose', '/runs/run-a',
        '--confirm-run-id', 'run-a',
        '--reason', 'other',
        '--disposition', 'delete'
      ]
    ],
    [
      'invalid disposition',
      [
        'results', 'dispose', '/runs/run-a',
        '--confirm-run-id', 'run-a',
        '--reason', 'owner-request',
        '--disposition', 'retain'
      ]
    ],
    [
      'invalid credential action',
      [
        'results', 'dispose', '/runs/run-a',
        '--confirm-run-id', 'run-a',
        '--reason', 'credential-detected',
        '--disposition', 'delete',
        '--credential-action', 'ignored'
      ]
    ],
    [
      'credential action without credential reason',
      [
        'results', 'dispose', '/runs/run-a',
        '--confirm-run-id', 'run-a',
        '--reason', 'owner-request',
        '--disposition', 'delete',
        '--credential-action', 'revoked'
      ]
    ],
    [
      'incident retention without credential reason',
      [
        'results', 'dispose', '/runs/run-a',
        '--confirm-run-id', 'run-a',
        '--reason', 'owner-request',
        '--disposition', 'incident-retain',
        '--incident-expires-at', '2026-10-01T00:00:00Z'
      ]
    ],
    [
      'incident expiry with deletion',
      [
        'results', 'dispose', '/runs/run-a',
        '--confirm-run-id', 'run-a',
        '--reason', 'owner-request',
        '--disposition', 'delete',
        '--incident-expires-at', '2026-10-01T00:00:00Z'
      ]
    ]
  ])('rejects %s before invoking a result service', async (_name, arguments_) => {
    const captured = output()
    const exitCode = await runCli(arguments_, captured.io)

    expect(exitCode).toBe(2)
    expect(captured.stdout).toEqual([])
    expect(captured.stderr.join('')).toContain('USAGE_ERROR')
    expect(normalizeRun).not.toHaveBeenCalled()
    expect(exportSanitizedResult).not.toHaveBeenCalled()
    expect(disposeRun).not.toHaveBeenCalled()
  })
})
