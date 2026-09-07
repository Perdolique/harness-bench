import { beforeEach, describe, expect, it, vi } from 'vitest'

const executeExperiment = vi.fn()
const invalidateExperimentBlock = vi.fn()
const lockExperiment = vi.fn()
const planExperiment = vi.fn()
const readExperimentPlan = vi.fn()
const rerunExperimentBlock = vi.fn()
const saveExperimentPlan = vi.fn()
const readExperimentState = vi.fn()
const renderExperimentPlan = vi.fn()
const renderExperimentReport = vi.fn()

vi.mock('@harness-bench/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@harness-bench/core')>(),
  executeExperiment,
  invalidateExperimentBlock,
  lockExperiment,
  planExperiment,
  readExperimentPlan,
  rerunExperimentBlock,
  saveExperimentPlan
}))

vi.mock('@harness-bench/results', async (importOriginal) => ({
  ...await importOriginal<typeof import('@harness-bench/results')>(),
  readExperimentState
}))

vi.mock('@harness-bench/reporting', async (importOriginal) => ({
  ...await importOriginal<typeof import('@harness-bench/reporting')>(),
  renderExperimentPlan,
  renderExperimentReport
}))

const { runCli } = await import('../src/cli.ts')
const { RunError } = await import('@harness-bench/core')

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

const plan = {
  experiment: {
    experiment_id: 'experiment-a',
    plan_digest: `sha256:${'a'.repeat(64)}`
  },

  runs_directory: '/runs'
}

const state = {
  blocks: [],
  plan,
  superseded: false
}

beforeEach(() => {
  executeExperiment.mockReset()
  invalidateExperimentBlock.mockReset()
  lockExperiment.mockReset()
  planExperiment.mockReset()
  readExperimentPlan.mockReset()
  rerunExperimentBlock.mockReset()
  saveExperimentPlan.mockReset()
  readExperimentState.mockReset()
  renderExperimentPlan.mockReset()
  renderExperimentReport.mockReset()
  lockExperiment.mockResolvedValue(vi.fn())
  readExperimentPlan.mockResolvedValue(plan)
  readExperimentState.mockResolvedValue(state)
  renderExperimentReport.mockReturnValue('Experiment report\n')
})

describe('benchctl experiment usage', () => {
  it.each([
    {
      arguments_: ['experiment'],
      message: 'Expected experiment plan, run, resume, report, rerun-block, or invalidate'
    },
    {
      arguments_: ['experiment', 'unknown', '/plan.json'],
      message: 'Expected experiment plan, run, resume, report, rerun-block, or invalidate'
    },
    {
      arguments_: ['experiment', 'report'],
      message: 'Experiment command requires exactly one definition or plan file'
    },
    {
      arguments_: ['experiment', 'report', '/plan.json', 'extra'],
      message: 'Experiment command requires exactly one definition or plan file'
    },
    {
      arguments_: ['experiment', 'plan', '/definition.json'],
      message: 'Missing required option: --runs-dir'
    },
    {
      arguments_: ['experiment', 'rerun-block', '/plan.json', '--revision', '2'],
      message: 'Missing required option: --block'
    },
    {
      arguments_: [
        'experiment',
        'invalidate',
        '/plan.json',
        '--block',
        'block-a',
        '--cause',
        'model_changed'
      ],

      message: 'Missing required option: --reason'
    },
    {
      arguments_: [
        'experiment',
        'invalidate',
        '/plan.json',
        '--block',
        'block-a',
        '--cause',
        'made_up',
        '--reason',
        'Invalid test cause'
      ],

      message: 'Invalid --cause value'
    }
  ])('returns the shared synopsis for $arguments_', async ({ arguments_, message }) => {
    const captured = output()
    const exit = await runCli(arguments_, captured.io)
    const error = captured.stderr.join('')

    expect(exit).toBe(2)
    expect(captured.stdout).toStrictEqual([])
    expect(error).toContain(`USAGE_ERROR: ${message}\n`)
    expect(error).toContain('Usage:\n  benchctl experiment plan DEFINITION')
    expect(readExperimentPlan).not.toHaveBeenCalled()
    expect(planExperiment).not.toHaveBeenCalled()
    expect(rerunExperimentBlock).not.toHaveBeenCalled()
    expect(invalidateExperimentBlock).not.toHaveBeenCalled()
  })

  it('lists experiment among the valid command groups', async () => {
    const captured = output()
    const exit = await runCli(['unknown'], captured.io)

    expect(exit).toBe(2)

    expect(captured.stderr.join('')).toContain(
      'USAGE_ERROR: Expected experiment, run, harness, or results command group'
    )
  })
})

describe('benchctl experiment report inspection', () => {
  it('refuses to inspect state while the experiment-family lease is active', async () => {
    lockExperiment.mockRejectedValue(
      new RunError(
        'EXECUTION_FAILED',
        'Execution lock exists or cannot be acquired; inspect active processes before trusted recovery'
      )
    )

    const captured = output()

    const exit = await runCli(
      ['experiment', 'report', '/plan.json'],
      captured.io
    )

    expect(exit).toBe(2)
    expect(captured.stdout).toStrictEqual([])

    expect(captured.stderr).toStrictEqual([
      'EXECUTION_FAILED: Execution lock exists or cannot be acquired; inspect active processes before trusted recovery\n'
    ])

    expect(readExperimentPlan).toHaveBeenCalledExactlyOnceWith('/plan.json')
    expect(lockExperiment).toHaveBeenCalledExactlyOnceWith(plan)
    expect(readExperimentState).not.toHaveBeenCalled()
    expect(renderExperimentReport).not.toHaveBeenCalled()
  })

  it('holds the lease through read-only state inspection before releasing it', async () => {
    const events: string[] = []

    const release = vi.fn(async () => {
      events.push('release')
    })

    readExperimentPlan.mockImplementation(async () => {
      events.push('read-plan')

      return plan
    })

    lockExperiment.mockImplementation(async () => {
      events.push('lock')

      return release
    })

    readExperimentState.mockImplementation(async () => {
      events.push('read-state')

      return state
    })

    renderExperimentReport.mockImplementation(() => {
      events.push('render')

      return 'Experiment report\n'
    })

    const captured = output()

    const exit = await runCli(
      ['experiment', 'report', '/plan.json'],
      captured.io
    )

    expect(exit).toBe(0)

    expect(events).toStrictEqual([
      'read-plan',
      'lock',
      'read-state',
      'render',
      'release'
    ])

    expect(readExperimentState).toHaveBeenCalledExactlyOnceWith(plan)
    expect(release).toHaveBeenCalledOnce()
    expect(captured.stdout).toStrictEqual(['Experiment report\n'])
    expect(captured.stderr).toStrictEqual([])
  })

  it('releases the inspection lease when state reading fails', async () => {
    const release = vi.fn()

    lockExperiment.mockResolvedValue(release)
    readExperimentState.mockRejectedValue(new Error('private diagnostics'))

    const captured = output()

    const exit = await runCli(
      ['experiment', 'report', '/plan.json'],
      captured.io
    )

    expect(exit).toBe(2)
    expect(release).toHaveBeenCalledOnce()
    expect(captured.stdout).toStrictEqual([])

    expect(captured.stderr).toStrictEqual([
      'UNEXPECTED_ERROR: command failed\n'
    ])
  })

  it('uses the same leased inspection for post-rerun output', async () => {
    rerunExperimentBlock.mockResolvedValue('/child/plan.json')

    const captured = output()

    const exit = await runCli([
      'experiment',
      'rerun-block',
      '/parent/plan.json',
      '--block',
      'block-a',
      '--revision',
      '2'
    ], captured.io)

    expect(exit).toBe(0)

    expect(rerunExperimentBlock).toHaveBeenCalledWith(
      '/parent/plan.json',
      'block-a',
      '2',
      expect.any(Object)
    )

    expect(readExperimentPlan).toHaveBeenCalledExactlyOnceWith('/child/plan.json')
    expect(lockExperiment).toHaveBeenCalledExactlyOnceWith(plan)
    expect(readExperimentState).toHaveBeenCalledExactlyOnceWith(plan)

    expect(captured.stdout).toStrictEqual([
      'Experiment report\n',
      'Plan: "/child/plan.json"\n'
    ])
  })
})
