import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveRunPlan = vi.fn()
const executeRunPlan = vi.fn()

vi.mock('@harness-bench/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@harness-bench/core')>(),
  executeRunPlan,
  resolveRunPlan
}))

const { runCli } = await import('../src/cli.ts')
const { RunError } = await import('@harness-bench/core')

function io(): {
  readonly stderr: string[];
  readonly stdout: string[];
  readonly value: {
    readonly stderr: (value: string) => void;
    readonly stdout: (value: string) => void;
  };
} {
  const stderr: string[] = []
  const stdout: string[] = []

  return {
    stderr,
    stdout,

    value: {
      stderr: (value) => stderr.push(value),
      stdout: (value) => stdout.push(value)
    }
  }
}

const arguments_ = [
  'run',
  '--experiment',
  '/inputs/experiment.json',
  '--run-id',
  'run-a',
  '--stack',
  '/inputs/stack-a.json',
  '--stack',
  '/inputs/stack-b.json',
  '--harness-document',
  '/inputs/harness-a.json',
  '--harness-document',
  '/inputs/harness-b.json',
  '--suite',
  '/inputs/suite.json',
  '--task',
  '/inputs/task.json',
  '--task-source',
  '/inputs/source',
  '--task-package',
  '/inputs/package',
  '--harness-bundle',
  '/inputs/bundle',
  '--runs-dir',
  '/runs'
] as const

const resolvedPlan = {
  run_id: 'run-a',
  safe: true
}

beforeEach(() => {
  resolveRunPlan.mockReset()
  executeRunPlan.mockReset()
  resolveRunPlan.mockResolvedValue(resolvedPlan)
})

describe('benchctl run', () => {
  it('prints the resolved safe plan without executing on dry-run', async () => {
    const output = io()
    const exitCode = await runCli([...arguments_, '--dry-run'], output.value)

    expect(exitCode).toBe(0)
    expect(executeRunPlan).not.toHaveBeenCalled()
    expect(resolveRunPlan).toHaveBeenCalledTimes(1)

    expect(resolveRunPlan).toHaveBeenCalledWith({
      experiment: '/inputs/experiment.json',
      harnessBundle: '/inputs/bundle',
      harnessDocuments: ['/inputs/harness-a.json', '/inputs/harness-b.json'],
      runId: 'run-a',
      runsDirectory: '/runs',
      stackDocuments: ['/inputs/stack-a.json', '/inputs/stack-b.json'],
      suite: '/inputs/suite.json',
      taskDocuments: ['/inputs/task.json'],
      taskPackage: '/inputs/package',
      taskSource: '/inputs/source'
    })

    expect(JSON.parse(output.stdout.join(''))).toEqual({
      dry_run: true,
      plan: resolvedPlan,
      status: 'resolved'
    })
  })

  it.each([
    ['task_success', 0],
    ['task_failure', 1],
    ['agent_failure', 2],
    ['provider_failure', 2],
    ['runner_failure', 2],
    ['verifier_failure', 2],
    ['infrastructure_failure', 2],
    ['cancellation', 2]
  ] as const)('maps %s to exit %i', async (classification, expectedExit) => {
    executeRunPlan.mockResolvedValue({
      classification,
      valid_grade: expectedExit < 2
    })

    const output = io()
    const exitCode = await runCli(arguments_, output.value)

    expect(exitCode).toBe(expectedExit)
    expect(JSON.parse(output.stdout.join(''))).toMatchObject({ classification })

    expect(output.stderr.join('')).toBe(
      `RUNNING: Harbor execution started\nCOMPLETED: ${classification}\n`
    )

    expect(resolveRunPlan).toHaveBeenCalledTimes(1)
    expect(executeRunPlan).toHaveBeenCalledTimes(1)
    expect(executeRunPlan).toHaveBeenCalledWith(resolvedPlan)
  })

  it.each([
    ['experiment', ['--experiment', '/inputs/experiment.json']],
    ['run-id', ['--run-id', 'run-a']],
    ['stack', [
      '--stack',
      '/inputs/stack-a.json',
      '--stack',
      '/inputs/stack-b.json'
    ]],
    ['harness-document', [
      '--harness-document',
      '/inputs/harness-a.json',
      '--harness-document',
      '/inputs/harness-b.json'
    ]],
    ['suite', ['--suite', '/inputs/suite.json']],
    ['task', ['--task', '/inputs/task.json']],
    ['task-source', ['--task-source', '/inputs/source']],
    ['task-package', ['--task-package', '/inputs/package']],
    ['harness-bundle', ['--harness-bundle', '/inputs/bundle']],
    ['runs-dir', ['--runs-dir', '/runs']]
  ] as const)('rejects a missing --%s option as a usage error', async (_name, omitted) => {
    const omittedSet = new Set<string>(omitted)
    const incomplete = arguments_.filter((value) => !omittedSet.has(value))
    const output = io()
    const exitCode = await runCli(incomplete, output.value)

    expect(exitCode).toBe(2)
    expect(output.stderr.join('')).toContain('USAGE_ERROR')
    expect(resolveRunPlan).not.toHaveBeenCalled()
    expect(executeRunPlan).not.toHaveBeenCalled()
  })

  it.each(['stack', 'harness-document', 'task'] as const)(
    'rejects an empty repeatable --%s option',
    async (name) => {
      const output = io()
      const values = [...arguments_, `--${name}=`]
      const exitCode = await runCli(values, output.value)

      expect(exitCode).toBe(2)
      expect(output.stderr.join('')).toContain('USAGE_ERROR')
      expect(resolveRunPlan).not.toHaveBeenCalled()
      expect(executeRunPlan).not.toHaveBeenCalled()
    }
  )

  it.each([
    'experiment',
    'harness-bundle',
    'run-id',
    'runs-dir',
    'suite',
    'task-package',
    'task-source'
  ] as const)('rejects an empty --%s option', async (name) => {
    const output = io()
    const exitCode = await runCli([...arguments_, `--${name}=`], output.value)

    expect(exitCode).toBe(2)
    expect(output.stderr.join('')).toContain('USAGE_ERROR')
    expect(resolveRunPlan).not.toHaveBeenCalled()
    expect(executeRunPlan).not.toHaveBeenCalled()
  })

  it('does not print a RunError cause', async () => {
    const output = io()
    const sentinel = 'secret-cause-sentinel'

    resolveRunPlan.mockRejectedValue(
      new RunError('INVALID_DOCUMENT', 'Safe input error', {
        cause: new Error(sentinel)
      })
    )

    const exitCode = await runCli(arguments_, output.value)
    const stderr = output.stderr.join('')

    expect(exitCode).toBe(2)
    expect(stderr).toBe('INVALID_DOCUMENT: Safe input error\n')
    expect(stderr).not.toContain(sentinel)
  })

  it('uses a command-neutral unexpected error', async () => {
    const output = io()

    resolveRunPlan.mockRejectedValue(new Error('unexpected detail'))

    const exitCode = await runCli(arguments_, output.value)

    expect(exitCode).toBe(2)
    expect(output.stderr.join('')).toBe('UNEXPECTED_ERROR: command failed\n')
  })
})
