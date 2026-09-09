import * as childProcess from 'node:child_process'
import { EventEmitter, getEventListeners } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runHarborProcess, runHarborRegradeProcess, type HarborExecutionContext } from '../src/run-execution.ts'

vi.mock(import('node:child_process'), async (importOriginal) => {
  const actual = await importOriginal()

  return {
    ...actual,
    spawn: vi.fn()
  }
})

const roots: string[] = []

async function context(signal: AbortSignal): Promise<HarborExecutionContext> {
  const root = await mkdtemp('/tmp/harness-bench-harbor-cancellation-')

  roots.push(root)

  return {
    runDirectory: root,
    configPath: resolve(root, 'config.json'),
    stdoutPath: resolve(root, 'stdout'),
    stderrPath: resolve(root, 'stderr'),
    wallClockSeconds: 60,
    signal
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.useRealTimers()

  for (const root of roots.splice(0)) await rm(root, {
    force: true,
    recursive: true
  })
})

describe('Harbor cancellation', () => {
  it('runs verifier-only regrade without auth or provider environment', async () => {
    const root = await mkdtemp('/tmp/harness-bench-harbor-regrade-')

    roots.push(root)

    const child = new EventEmitter() as childProcess.ChildProcess

    const spawn = vi.mocked(childProcess.spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('close', 0, null))

      return child
    })

    const outcome = await runHarborRegradeProcess({
      runDirectory: root,
      sourceTrial: '/source/trial',
      stderrPath: resolve(root, 'stderr'),
      stdoutPath: resolve(root, 'stdout'),
      targetTaskPath: resolve(root, 'fixture-task'),
      trialName: 'regrade-fixture-run-abc123',
      trialsDirectory: resolve(root, 'trials'),
      wallClockSeconds: 60,
      runId: 'fixture-run'
    }, '/fake/harbor')

    expect(outcome).toEqual({
      cancelled: false,
      exitCode: 0,
      signal: null,
      timedOut: false
    })

    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      '/fake/harbor',
      [
        'trial',
        'regrade',
        '/source/trial',
        '--task-path',
        resolve(root, 'fixture-task'),
        '--env',
        'docker',
        '--verifier-env',
        'HARBOR_RUN_ID=fixture-run',
        '--trial-name',
        'regrade-fixture-run-abc123',
        '--trials-dir',
        resolve(root, 'trials')
      ],
      expect.objectContaining({
        cwd: root,
        shell: false,
        stdio: expect.any(Array)
      })
    )

    const options = spawn.mock.calls[0]?.[2]
    const environment = options?.env ?? {}

    expect(environment).toMatchObject({
      HARBOR_TELEMETRY: 'off',
      HOME: root
    })

    expect(environment).not.toHaveProperty('CODEX_AUTH_JSON_PATH')
    expect(environment).not.toHaveProperty('OPENAI_API_KEY')
    expect(options?.stdio).toHaveLength(3)

    await expect(readFile(resolve(root, 'process-control.json'), 'utf8')).resolves.toBe(
      '{\n  "auth_transport": "none",\n  "harbor_telemetry": "off",\n  "operation": "regrade",\n  "shell": false,\n  "provider_calls": 0\n}\n'
    )
  })

  it.each(['before invocation', 'during asynchronous preparation'])('never spawns when aborted %s', async (timing) => {
    const cancellation = new AbortController()
    const input = await context(cancellation.signal)
    const child = new EventEmitter() as childProcess.ChildProcess

    const spawn = vi.mocked(childProcess.spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('close', 0, null))

      return child
    })

    if (timing === 'before invocation') cancellation.abort()

    const pending = runHarborProcess(input, '/fake/harbor')

    // runHarborProcess is suspended in its real filesystem preparation here.
    if (timing === 'during asynchronous preparation') cancellation.abort()

    const outcome = await pending

    expect(spawn).not.toHaveBeenCalled()

    expect(outcome).toEqual({
      cancelled: true,
      exitCode: null,
      signal: null,
      timedOut: false
    })

    expect(getEventListeners(cancellation.signal, 'abort')).toEqual([])
  })

  it('stops an active child through the persistent signal and removes all listeners', async () => {
    vi.useFakeTimers()

    const cancellation = new AbortController()
    const input = await context(cancellation.signal)
    const child = new EventEmitter() as childProcess.ChildProcess
    const interruptListeners = process.listenerCount('SIGINT')
    const terminateListeners = process.listenerCount('SIGTERM')

    child.kill = vi.fn((signal) => {
      queueMicrotask(() => child.emit('close', null, signal))

      return true
    })

    vi.mocked(childProcess.spawn).mockImplementation(() => {
      queueMicrotask(() => {
        expect(process.listenerCount('SIGINT')).toBe(interruptListeners)
        expect(process.listenerCount('SIGTERM')).toBe(terminateListeners)
        cancellation.abort()
      })

      return child
    })

    const outcome = await runHarborProcess(input, '/fake/harbor')

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.kill).toHaveBeenCalledTimes(1)

    expect(outcome).toEqual({
      cancelled: true,
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: false
    })

    expect(getEventListeners(cancellation.signal, 'abort')).toEqual([])
    expect(process.listenerCount('SIGINT')).toBe(interruptListeners)
    expect(process.listenerCount('SIGTERM')).toBe(terminateListeners)
    expect(vi.getTimerCount()).toBe(0)
  })
})
