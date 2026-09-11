import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { basename, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDoctor } from '../src/doctor.ts'
import { doctorDigest, doctorInventory, writeDoctorJson } from '../src/doctor-storage.ts'
import { DOCTOR_HARBOR, type DoctorRuntime } from '../src/doctor-runtime.ts'
import { captureWorkspaceArtifacts } from '../src/task-artifacts.ts'
import { inspectTaskSource, materializeTaskWorkspace } from '../src/task.ts'
import { runHarborProcess, type HarborExecutionContext } from '../src/run-execution.ts'
import { prepareDoctorFixture, removeDoctorFixture } from '../../../tests/fixtures/doctor/fixture.ts'
import { fixtureScore, type FixtureChecks } from '../../../tests/fixtures/doctor/score.ts'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp('/tmp/harness-bench-doctor-test-')

  roots.push(root)

  const definition = await prepareDoctorFixture(root)

  return {
    root,
    definition,
    outputDirectory: resolve(root, 'output')
  }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()

  for (const root of roots.splice(0)) await removeDoctorFixture(root)
})

type Fault = 'pristine-pass' | 'pristine-drift' | 'reference-fail' | 'nondeterminism' | 'check-order' | 'reward-order' | 'semantic-drift' | 'network' | 'credential' | 'missing-check' | 'stop' | 'extra-artifact' | 'oracle' | 'visibility' | 'cancelled' | 'timeout' | 'image-layer' | 'image-id' | 'image-user' | 'image-root' | 'host'

function fakeRuntime(root: string, fault?: Fault): DoctorRuntime {
  const command = vi.fn(async (executable: string, args: readonly string[]): Promise<string> => {
    if (executable === 'uname') return args[0] === '-s' ? 'Darwin' : 'arm64'

    if (executable === DOCTOR_HARBOR) return fault === 'host' ? '0.21.0' : '0.22.0'

    if (executable === 'docker') {
      if (args[0] === 'version') return JSON.stringify({
        Os: 'linux',
        Arch: 'arm64',
        Version: '29.7.2'
      })

      if (args[0] === 'info') return 'linuxkit'

      if (args[0] === 'desktop') return '4.77.0'

      if (args[0] === 'image' && args[1] === 'inspect') return JSON.stringify({
        Id: fault === 'image-id' ? 'wrong' : args[3],
        Os: 'linux',
        Architecture: 'arm64',

        Config: {
          User: args[3] === `sha256:${'1'.repeat(64)}`
            ? (fault === 'image-user' ? 'other-user' : 'pwuser')
            : ''
        }
      })

      if (args[0] === 'run') return fault === 'image-root' ? '0' : '1000'

      return ''
    }

    if (executable === 'tar') {
      if (args[0] === '-xOf') return '[{"Layers":["layer.tar"]}]'

      if (args[0] === '-tf') return fault === 'image-layer' ? 'tests-hidden/secret.txt\n' : 'app/README.md\n'

      return ''
    }

    throw new Error(`Unexpected executable ${executable}`)
  })

  const runHarbor = vi.fn(async (context: HarborExecutionContext) => {
    if (fault === 'cancelled' || fault === 'timeout') return {
      cancelled: fault === 'cancelled',
      timedOut: fault === 'timeout',
      exitCode: null,
      signal: 'SIGTERM' as const
    }

    const id = basename(context.runDirectory)
    const source = resolve(root, 'source')
    const snapshot = await inspectTaskSource(source)
    const temporary = await mkdtemp('/tmp/harness-bench-doctor-candidate-')

    try {
      const candidate = await materializeTaskWorkspace({
        source,
        destination: resolve(temporary, 'workspace'),
        expectedSourceDigest: snapshot.digest
      })

      if (id === 'pristine' && fault === 'pristine-drift') await writeFile(resolve(candidate.workspace, 'README.md'), 'Changed image source\n')

      const pristine = id === 'pristine' && fault !== 'pristine-pass'
      const positive = !pristine && !(id === 'reference' && fault === 'reference-fail')

      if (positive) {
        await writeFile(resolve(candidate.workspace, 'RESULT.md'), 'success\n')
        await writeFile(resolve(candidate.workspace, 'candidate.test.txt'), 'test\n')
      }

      if (id === 'deleted') await rm(resolve(candidate.workspace, 'candidate.test.txt'))

      if (id === 'disabled') await writeFile(resolve(candidate.workspace, 'regression.txt'), 'disabled\n')

      if (id === 'forbidden') await writeFile(resolve(candidate.workspace, 'forbidden.txt'), 'changed\n')

      if (fault === 'nondeterminism' && id === 'reference-repeat') await writeFile(resolve(candidate.workspace, 'extra.txt'), 'changed\n')

      const values: FixtureChecks = {
        contracts: positive && id !== 'deleted',
        direct: positive,
        regression: id !== 'disabled',
        scope: id !== 'forbidden'
      }

      const trial = resolve(context.runDirectory, 'raw/harbor/job/task__AbC1234')
      const artifacts = resolve(trial, 'artifacts/trusted-collector')

      await mkdir(resolve(trial, 'artifacts'), { recursive: true })
      await mkdir(resolve(trial, 'verifier'))
      await mkdir(resolve(trial, 'agent'))

      await captureWorkspaceArtifacts({
        source,
        workspace: candidate.workspace,
        artifacts,
        baseCommit: candidate.baseCommit,
        expectedSourceDigest: snapshot.digest
      })

      await writeDoctorJson(resolve(trial, 'artifacts/manifest.json'), [
        {
          source: '/logs/artifacts',
          destination: 'artifacts/logs/artifacts',
          type: 'directory',
          status: 'empty',
          service: null
        },
        {
          source: '/evidence',
          destination: 'artifacts/trusted-collector',
          type: 'directory',
          status: 'ok',
          service: 'collector'
        }
      ])

      await writeFile(resolve(trial, 'trial.log'), fault === 'stop' ? 'Collect hook in service \'collector\' completed\n' : 'Main service stopped\nCollect hook in service \'collector\' completed\n')

      await writeDoctorJson(resolve(trial, 'result.json'), {
        verifier_environment_mode: 'separate',
        exception_info: null
      })

      await writeDoctorJson(resolve(trial, 'config.json'), { trial_name: 'task__AbC1234' })

      const result = fixtureScore(id, values, {
        credentialsAbsent: true,
        networkIsolated: fault !== 'network'
      })

      if (fault === 'missing-check') {
        const modified = JSON.parse(result.verifierSource)

        delete modified.checks.contracts
        result.verifierSource = `${JSON.stringify(modified, null, 2)}\n`
        result.score.verifier_result_digest = doctorDigest(result.verifierSource)
      }

      if (fault === 'check-order' && id === 'reference-repeat') {
        const modified = JSON.parse(result.verifierSource)
        const reversed = Object.entries(modified.checks).reverse()

        modified.checks = Object.fromEntries(reversed)
        result.verifierSource = `${JSON.stringify(modified, null, 2)}\n`
        result.score.verifier_result_digest = doctorDigest(result.verifierSource)
      }

      if (fault === 'semantic-drift' && id === 'reference-repeat') {
        result.score.facets.repository_contracts.value = 0
        result.score.composite.value = 0.65
        result.score.harbor_reward.numeric_values.reward = 0.65
        result.reward.reward = 0.65
      }

      if (fault === 'reward-order') {
        const value = result.reward.reward

        const reward = id === 'reference-repeat' ? {
          extra: value,
          reward: value
        } : {
          reward: value,
          extra: value
        }

        result.score.harbor_reward.numeric_values = reward
        result.reward = reward
      }

      await writeFile(resolve(trial, 'verifier/verifier-result.json'), result.verifierSource)
      await writeDoctorJson(resolve(trial, 'verifier/score.json'), result.score)
      await writeDoctorJson(resolve(trial, 'verifier/reward.json'), result.reward)

      await writeDoctorJson(resolve(trial, 'agent/doctor-probe.json'), {
        version: 1,
        hidden_material_absent: fault !== 'visibility',
        credentials_absent: true,
        git_isolated: true,
        dependencies_pinned: true
      })

      await writeFile(resolve(trial, 'agent/oracle.txt'), fault === 'oracle' ? 'not completed\n' : 'CALIBRATION_ORACLE_OK\n')
      await writeFile(context.stdoutPath, fault === 'credential' ? `access_token=${'fixture'.repeat(5)}\n` : '')
      await writeFile(context.stderrPath, '')

      if (fault === 'extra-artifact') await writeFile(resolve(trial, 'artifacts/unlisted.txt'), 'extra\n')

      return {
        cancelled: false,
        timedOut: false,
        exitCode: 0,
        signal: null
      }
    } finally {
      await removeDoctorFixture(temporary)
    }
  })

  return {
    command,
    runHarbor,
    now: () => new Date('2026-09-07T00:00:00Z')
  }
}

describe('doctor', { timeout: 15_000 }, () => {
  it('executes every required control, repeats identical artifacts, and seals a smoke-only report', async () => {
    const input = await fixture()
    const runtime = fakeRuntime(input.root)

    const report = await runDoctor({
      ...input,
      purpose: 'smoke'
    }, runtime)

    expect(report.checks.filter((check) => check.status === 'failed')).toEqual([])
    expect(report.exit_code).toBe(0)
    expect(report.allowed_use).toBe('smoke')
    expect(report.checks.find((check) => check.code === 'ONLINE_REACHABILITY')?.status).toBe('warning')
    expect(runtime.runHarbor).toHaveBeenCalledTimes(7)
    expect(report.checks.find((check) => check.code === 'DETERMINISM')?.status).toBe('passed')

    const manifest = await readFile(resolve(input.outputDirectory, 'evidence-manifest.json'))

    expect(report.evidence_manifest_digest).toBe(doctorDigest(manifest))
    expect(JSON.parse(manifest.toString())).toEqual(await doctorInventory(resolve(input.outputDirectory, 'raw')))

    const { lstat } = await import('node:fs/promises')

    expect((await lstat(resolve(input.outputDirectory, 'report.json'))).mode & 0o777).toBe(0o400)
    expect((await lstat(resolve(input.outputDirectory, 'raw'))).mode & 0o777).toBe(0o500)

    for (const [context] of vi.mocked(runtime.runHarbor).mock.calls) {
      expect(context.authPath).toBeUndefined()
      expect(context.signal).toBeInstanceOf(AbortSignal)

      const job = JSON.parse(await readFile(context.configPath, 'utf8'))

      expect(['nop', 'oracle']).toContain(job.agents[0].name)
      expect(job.agents[0].mcp_servers).toBeUndefined()
      expect(job.n_concurrent_trials).toBe(1)
      expect(job.retry.max_retries).toBe(0)
    }

    await expect(runDoctor({
      ...input,
      purpose: 'smoke'
    }, runtime)).rejects.toThrow()
  })

  it('defaults to quality and rejects the public fixture before any runtime invocation', async () => {
    const input = await fixture()
    const runtime = fakeRuntime(input.root)
    const report = await runDoctor(input, runtime)

    expect(report.exit_code).toBe(1)
    expect(report.allowed_use).toBe('none')
    expect(runtime.command).not.toHaveBeenCalled()
    expect(runtime.runHarbor).not.toHaveBeenCalled()
  })

  it('rejects a rubric evidence path absent from pristine source', async () => {
    const input = await fixture()
    const taskPath = resolve(input.root, 'task.json')
    const task = JSON.parse(await readFile(taskPath, 'utf8'))

    task.rubric[0].evidence_paths = ['src/missing-evidence.ts']

    await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`)

    const runtime = fakeRuntime(input.root)

    const report = await runDoctor({
      ...input,
      purpose: 'smoke'
    }, runtime)

    expect(report.checks.find((check) => check.code === 'TASK_SOURCE')).toMatchObject({
      failure_code: 'RUBRIC_EVIDENCE',
      status: 'failed'
    })

    expect(runtime.runHarbor).not.toHaveBeenCalled()
  })

  it('rejects a doctor control with an unknown rubric obligation', async () => {
    const input = await fixture()
    const definition = JSON.parse(await readFile(input.definition, 'utf8'))

    const disabled = definition.controls.find(
      (control: { kind: string }) => control.kind === 'test_disablement'
    )

    disabled.expected_checks.unknown = false

    await writeFile(
      input.definition,
      `${JSON.stringify(definition, null, 2)}\n`
    )

    const runtime = fakeRuntime(input.root)

    const report = await runDoctor({
      ...input,
      purpose: 'smoke'
    }, runtime)

    expect(report.checks.find((check) => check.code === 'CONTROL_INPUTS')).toMatchObject({
      failure_code: 'CONTROL_EXPECTATIONS',
      status: 'failed'
    })

    expect(runtime.runHarbor).not.toHaveBeenCalled()
  })

  it.each(['check-order', 'reward-order'] as const)('compares semantic outcomes regardless of %s in verifier JSON', async (fault) => {
    const input = await fixture()

    const report = await runDoctor({
      ...input,
      purpose: 'smoke'
    }, fakeRuntime(input.root, fault))

    expect(report.exit_code).toBe(0)
    expect(report.checks.find((check) => check.code === 'DETERMINISM')?.status).toBe('passed')
  })

  it('fails closed on a weighted score change before determinism comparison', async () => {
    const input = await fixture()

    const report = await runDoctor({
      ...input,
      purpose: 'smoke'
    }, fakeRuntime(input.root, 'semantic-drift'))

    expect(report.exit_code).toBe(2)
    expect(report.checks.find((check) => check.code === 'CONTROL_reference-repeat')?.failure_code).toBe('INVALID_EVIDENCE')
    expect(report.checks.find((check) => check.code === 'DETERMINISM')?.status).toBe('not_run')
  })

  it.each(['container', 'volume', 'network'] as const)('rejects an orphan %s by its exact Compose project label', async (kind) => {
    const input = await fixture()
    const runtime = fakeRuntime(input.root)
    const project = kind === 'volume' ? 'task__abc1234__env' : 'task__abc1234__verifier__trial'

    const report = await runDoctor({
      ...input,
      purpose: 'smoke'
    }, {
      ...runtime,

      command: async (executable, args, home) => {
        const selectedKind = args[0] === 'ps' ? 'container' : args[0]

        if (executable === 'docker' && selectedKind === kind && args.includes(`label=com.docker.compose.project=${project}`)) return 'orphan-resource'

        return runtime.command(executable, args, home)
      }
    })

    expect(report.exit_code).toBe(2)
    expect(report.allowed_use).toBe('none')
    expect(report.checks.find((check) => check.code === 'HARBOR_CLEANUP')?.failure_code).toBe('CLEANUP_FAILED')

    const evidence = JSON.parse(await readFile(resolve(input.outputDirectory, 'raw/cleanup.json'), 'utf8'))

    expect(evidence[project][kind]).toEqual(['orphan-resource'])
  })

  it('checks both Harbor projects for every resource kind without claiming unrelated resources', async () => {
    const input = await fixture()
    const runtime = fakeRuntime(input.root)
    const inspected: string[][] = []

    const report = await runDoctor({
      ...input,
      purpose: 'smoke'
    }, {
      ...runtime,

      command: async (executable, args, home) => {
        if (executable === 'docker' && (args[0] === 'ps' || args[1] === 'ls')) {
          inspected.push([...args])

          return args.includes('label=com.docker.compose.project=unrelated-project') || !args.includes('--filter') ? 'unrelated-resource' : ''
        }

        return runtime.command(executable, args, home)
      }
    })

    expect(report.exit_code).toBe(0)

    for (const suffix of ['env', 'verifier__trial']) {
      const filter = `label=com.docker.compose.project=task__abc1234__${suffix}`

      expect(inspected).toContainEqual(['ps', '--all', '--quiet', '--filter', filter])
      expect(inspected).toContainEqual(['volume', 'ls', '--quiet', '--filter', filter])
      expect(inspected).toContainEqual(['network', 'ls', '--quiet', '--filter', filter])
    }
  })

  it('blocks cleanup success when retained trial ownership evidence is missing', async () => {
    const input = await fixture()
    const runtime = fakeRuntime(input.root)

    const report = await runDoctor({
      ...input,
      purpose: 'smoke'
    }, {
      ...runtime,

      runHarbor: async (context) => {
        const outcome = await runtime.runHarbor(context)

        await rm(resolve(context.runDirectory, 'raw/harbor/job/task__AbC1234/config.json'))

        return outcome
      }
    })

    expect(report.exit_code).toBe(2)
    expect(report.checks.find((check) => check.code === 'CONTROL_reference-repeat')?.status).toBe('passed')
    expect(report.checks.find((check) => check.code === 'HARBOR_CLEANUP')?.failure_code).toBe('CLEANUP_FAILED')
  })

  it.each(['unknown', 'missing'] as const)('rejects a %s reachability assessment even for smoke', async (status) => {
    const input = await fixture()
    const path = resolve(input.root, 'task.json')
    const task = JSON.parse(await readFile(path, 'utf8'))

    if (status === 'missing') delete task.online_reachability
    else task.online_reachability.status = 'unknown'

    await writeFile(path, JSON.stringify(task))

    const runtime = fakeRuntime(input.root)

    const report = await runDoctor({
      ...input,
      purpose: 'smoke'
    }, runtime)

    expect(report.exit_code).toBe(1)
    expect(runtime.runHarbor).not.toHaveBeenCalled()
  })

  it.each(['pristine-pass', 'pristine-drift', 'reference-fail', 'nondeterminism', 'network', 'missing-check', 'stop', 'extra-artifact', 'oracle', 'visibility', 'cancelled', 'timeout', 'image-layer', 'image-id', 'image-user', 'image-root', 'host'] satisfies Fault[])('rejects %s without claiming complete calibration', async (fault) => {
    const input = await fixture()
    const runtime = fakeRuntime(input.root, fault)

    const report = await runDoctor({
      ...input,
      purpose: 'smoke'
    }, runtime)

    expect(report.exit_code).not.toBe(0)
    expect(report.allowed_use).toBe('none')
    expect(report.checks.some((check) => check.status === 'failed')).toBe(true)

    if (fault === 'nondeterminism') expect(report.checks.find((check) => check.code === 'DETERMINISM')?.status).toBe('failed')

    if (fault === 'cancelled' || fault === 'timeout' || fault === 'host') expect(report.exit_code).toBe(2)
  })

  it('quarantines a credential finding and prints neither secret values nor raw errors', async () => {
    const input = await fixture()

    const report = await runDoctor({
      ...input,
      purpose: 'smoke'
    }, fakeRuntime(input.root, 'credential'))

    expect(report.exit_code).toBe(2)
    expect(JSON.stringify(report)).not.toContain('fixture'.repeat(5))
    expect(report.checks.find((check) => check.code === 'EVIDENCE_RESTRICTED')?.status).toBe('failed')

    const restricted = await readFile(resolve(input.outputDirectory, 'raw/restriction.json'), 'utf8')

    expect(JSON.parse(restricted).publication).toBe('blocked')
  })

  it('keeps credential-bearing control identifiers only in quarantine, including derived metadata', async () => {
    const input = await fixture()
    const runtime = fakeRuntime(input.root)
    const sentinel = `sk-${'synthetic'.repeat(4)}`
    const definition = JSON.parse(await readFile(input.definition, 'utf8'))

    definition.controls.find((control: { kind: string }) => control.kind === 'reference').id = sentinel

    await writeFile(input.definition, JSON.stringify(definition))

    const report = await runDoctor({
      ...input,
      purpose: 'smoke'
    }, runtime)

    expect(report.exit_code).toBe(2)
    expect(report.checks.find((check) => check.code === 'CREDENTIAL_INPUTS')?.failure_code).toBe('RESTRICTED_INPUTS')
    expect(runtime.command).not.toHaveBeenCalled()
    expect(runtime.runHarbor).not.toHaveBeenCalled()
    expect(JSON.stringify(report)).not.toContain(sentinel)

    const inventory = await doctorInventory(input.outputDirectory)

    for (const entry of inventory) {
      if (entry.path.startsWith('quarantine/')) continue

      expect(entry.path).not.toContain(sentinel)

      if (entry.kind === 'file') {
        const contents = await readFile(resolve(input.outputDirectory, entry.path), 'utf8')

        expect(contents).not.toContain(sentinel)
      }
    }

    const original = await readFile(resolve(input.outputDirectory, 'quarantine/raw/inputs/definition.json'), 'utf8')

    expect(original).toBe(JSON.stringify(definition))
  })

  it.each(['tag', 'lock', 'source', 'harness'] as const)('rejects changed %s inputs before runtime', async (kind) => {
    const input = await fixture()

    if (kind === 'tag') {
      const path = resolve(input.root, 'package/task.toml')
      const source = await readFile(path, 'utf8')

      await writeFile(path, source.replace(`sha256:${'1'.repeat(64)}`, 'mutable:latest'))
    } else if (kind === 'harness') {
      const definition = JSON.parse(await readFile(input.definition, 'utf8'))
      const path = resolve(definition.harness_bundle, 'content/config.toml')

      await chmod(path, 0o600)
      await writeFile(path, 'changed')
    } else await writeFile(resolve(input.root, 'source', kind === 'lock' ? 'pnpm-lock.yaml' : 'README.md'), 'changed')

    const runtime = fakeRuntime(input.root)

    const report = await runDoctor({
      ...input,
      purpose: 'smoke'
    }, runtime)

    expect(report.exit_code).toBe(1)
    expect(runtime.runHarbor).not.toHaveBeenCalled()
  })

  it('retains a setup-stage report when interrupted during host inspection', async () => {
    const input = await fixture()
    const runtime = fakeRuntime(input.root)
    const listeners = process.listenerCount('SIGINT')

    const report = await runDoctor({
      ...input,
      purpose: 'smoke'
    }, {
      ...runtime,

      command: async (executable, args, home) => {
        process.emit('SIGINT')

        return runtime.command(executable, args, home)
      }
    })

    expect(report.exit_code).toBe(2)
    expect(report.allowed_use).toBe('none')

    expect(report.checks.find((check) => check.code === 'HOST_AND_IMAGES')).toMatchObject({
      stage: 'setup',
      failure_code: 'CANCELLED'
    })

    expect(runtime.runHarbor).not.toHaveBeenCalled()
    expect(process.listenerCount('SIGINT')).toBe(listeners)
    expect(JSON.parse(await readFile(resolve(input.outputDirectory, 'report.json'), 'utf8')).exit_code).toBe(2)
  })

  it('does not start Harbor after cancellation during control package preparation', async () => {
    const input = await fixture()
    const runtime = fakeRuntime(input.root)
    let monitor: Promise<void> | undefined
    let finished = false
    let interrupted = false

    try {
      const report = await runDoctor({
        ...input,
        purpose: 'smoke'
      }, {
        ...runtime,

        command: async (executable, args, home) => {
          if (executable === 'tar' && args[0] === '-tf') {
            const packagePath = resolve(input.outputDirectory, 'raw/cases/pristine/task')

            monitor = (async () => {
              while (!finished) {
                await nextTurn()

                if (existsSync(packagePath)) {
                  interrupted = true

                  process.emit('SIGINT')

                  return
                }
              }
            })()
          }

          return runtime.command(executable, args, home)
        }
      })

      expect(interrupted).toBe(true)
      expect(report.exit_code).toBe(2)
      expect(report.checks.find((check) => check.code === 'CONTROL_pristine')?.failure_code).toBe('CANCELLED')
      expect(runtime.runHarbor).not.toHaveBeenCalled()
    } finally {
      finished = true

      await monitor
    }
  })

  it('rejects dependency ranges even when source and lock identities agree', async () => {
    const input = await fixture()
    const source = resolve(input.root, 'source')

    await writeFile(resolve(source, 'package.json'), '{"name":"doctor-fixture","packageManager":"pnpm@11.25.0","dependencies":{"example":"^1.0.0"}}\n')
    await writeFile(resolve(source, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\nimporters:\n  .:\n    dependencies:\n      example:\n        specifier: ^1.0.0\n        version: 1.0.0\n')

    const snapshot = await inspectTaskSource(source)
    const taskPath = resolve(input.root, 'task.json')
    const task = JSON.parse(await readFile(taskPath, 'utf8'))

    task.source_digest = snapshot.digest

    await writeFile(taskPath, JSON.stringify(task))

    const report = await runDoctor({
      ...input,
      purpose: 'smoke'
    }, fakeRuntime(input.root))

    expect(report.checks.find((check) => check.code === 'TASK_SOURCE')?.failure_code).toBe('DEPENDENCY_PINS')
  })

  it('rejects earlier raw evidence changed after its successful verification', async () => {
    const input = await fixture()
    const runtime = fakeRuntime(input.root)
    const runHarbor = runtime.runHarbor

    const report = await runDoctor({
      ...input,
      purpose: 'smoke'
    }, {
      ...runtime,

      runHarbor: async (context) => {
        if (basename(context.runDirectory) === 'reference') {
          await writeFile(resolve(input.outputDirectory, 'raw/cases/pristine/raw/runner/stdout.log'), 'changed after verification')
        }

        return runHarbor(context)
      }
    })

    expect(report.allowed_use).toBe('none')
    expect(report.checks.find((check) => check.code === 'EVIDENCE_STABILITY')?.status).toBe('failed')
  })

  it('does not inherit credentials into the shared Harbor launcher without an auth descriptor', async () => {
    const root = await mkdtemp('/tmp/harness-bench-doctor-env-')

    roots.push(root)

    const executable = resolve(root, 'harbor')

    await writeFile(executable, '#!/bin/sh\nprintenv\n', { mode: 0o700 })
    vi.stubEnv('CODEX_AUTH_JSON_PATH', '/ambient/must-not-be-read')
    vi.stubEnv('OPENAI_API_KEY', 'fixture-private-value')
    vi.stubEnv('CODEX_HOME', '/ambient/home')

    const outcome = await runHarborProcess({
      configPath: 'config.json',
      runDirectory: root,
      stdoutPath: resolve(root, 'stdout'),
      stderrPath: resolve(root, 'stderr'),
      wallClockSeconds: 3
    }, executable)

    expect(outcome.exitCode).toBe(0)

    const output = await readFile(resolve(root, 'stdout'), 'utf8')

    expect(output).not.toMatch(/CODEX_AUTH_JSON_PATH|OPENAI_API_KEY|CODEX_HOME|fixture-private-value|ambient/)
    expect(output).toContain('HARBOR_TELEMETRY=off')
    expect(output).toContain(`HOME=${root}`)

    const processControl = JSON.parse(await readFile(resolve(root, 'process-control.json'), 'utf8'))

    expect(processControl.auth_transport).toBe('none')
  })
})
