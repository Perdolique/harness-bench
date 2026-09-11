import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  parse as parseToml,
  stringify as stringifyToml,
  type TomlTable
} from '../packages/core/node_modules/smol-toml/dist/index.js'

import { runDoctor } from '../packages/core/src/doctor.ts'
import { doctorRuntime, type DoctorRuntime } from '../packages/core/src/doctor-runtime.ts'
import { providerFreeEnvironment } from '../packages/core/src/run-execution.ts'
import { doctorDigest, writeDoctorJson } from '../packages/core/src/doctor-storage.ts'
import { prepareDoctorFixture } from '../tests/fixtures/doctor/fixture.ts'
import { inspectTaskSource } from '../packages/core/src/task.ts'

const repository = resolve(import.meta.dirname, '..')
const imageBase = 'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:941cc91e5022880ac1d14ae90b476b624deb6399dbbc28d612d5d5bd7928fcbd'
const root = await mkdtemp('/tmp/harness-bench-doctor-integration-')
const preparation = resolve(root, 'preparation')

await mkdir(preparation)

const definitionPath = await prepareDoctorFixture(preparation)
const task = JSON.parse(await readFile(resolve(preparation, 'task.json'), 'utf8'))
const source = await inspectTaskSource(resolve(preparation, 'source'))
const contexts = resolve(root, 'images')

const images = {
  agent: '',
  collector: '',
  verifier: ''
}

for (const kind of ['agent', 'collector', 'verifier'] as const) {
  const context = resolve(contexts, kind)

  await mkdir(context, { recursive: true })

  if (kind === 'agent') await cp(resolve(preparation, 'workspace'), resolve(context, 'source'), { recursive: true })
  else {
    await cp(resolve(preparation, 'source'), resolve(context, 'source'), { recursive: true })
    await mkdir(resolve(context, 'core'))

    for (const name of ['task.ts', 'task-artifacts.ts', 'secret-scan.ts']) await cp(resolve(repository, 'packages/core/src', name), resolve(context, 'core', name))
  }

  let recipe = `FROM ${imageBase}\n`

  if (kind === 'agent') recipe += 'RUN npm install --global pnpm@11.25.0\nCOPY source/ /app/\nRUN chown -R pwuser:pwuser /app\nUSER pwuser\nWORKDIR /app\n'

  if (kind === 'collector') {
    await cp(resolve(repository, 'benchmark/tasks/order-receipt/collector/container-collector.ts'), resolve(context, 'container-collector.ts'))

    recipe += 'COPY source/ /trusted/source/\nCOPY core/ /opt/core/\nCOPY container-collector.ts /opt/collector/container-collector.ts\nCMD ["tail", "-f", "/dev/null"]\n'
  }

  if (kind === 'verifier') {
    await cp(resolve(repository, 'tests/fixtures/doctor/verify.mjs'), resolve(context, 'verify.mjs'))
    await cp(resolve(repository, 'tests/fixtures/doctor/score.ts'), resolve(context, 'score.ts'))
    await writeFile(resolve(context, 'test.sh'), '#!/bin/sh\nset -eu\nexec node /opt/verifier/verify.mjs\n', { mode: 0o755 })

    recipe += 'COPY source/ /trusted/source/\nCOPY core/ /opt/core/\nCOPY verify.mjs /opt/verifier/verify.mjs\nCOPY score.ts /opt/verifier/score.ts\nCOPY test.sh /tests/test.sh\n'
  }

  await writeFile(resolve(context, 'Dockerfile'), recipe)

  const tag = `harness-bench-doctor-${kind}:issue-12`

  execFileSync('docker', ['build', '--platform=linux/arm64', '--provenance=false', '--tag', tag, context], {
    stdio: 'inherit',

    env: {
      ...providerFreeEnvironment(root),
      HOME: process.env.HOME
    }
  })

  images[kind] = execFileSync('docker', ['image', 'inspect', '--format={{.Id}}', tag], { encoding: 'utf8' }).trim()
}

const deletedLayerContext = resolve(contexts, 'deleted-layer')

await mkdir(deletedLayerContext)
await writeFile(resolve(deletedLayerContext, 'Dockerfile'), 'FROM harness-bench-doctor-agent:issue-12\nUSER root\nRUN touch /doctor-hidden-sentinel\nRUN rm /doctor-hidden-sentinel\nUSER pwuser\n')

execFileSync('docker', ['build', '--platform=linux/arm64', '--provenance=false', '--tag', 'harness-bench-doctor-deleted-layer:issue-12', deletedLayerContext], {
  stdio: 'inherit',

  env: {
    ...providerFreeEnvironment(root),
    HOME: process.env.HOME
  }
})

const deletedLayerImage = execFileSync('docker', ['image', 'inspect', '--format={{.Id}}', 'harness-bench-doctor-deleted-layer:issue-12'], { encoding: 'utf8' }).trim()

// Bind the prepared task to the actually built local image IDs without touching source identities.
task.environment.digest = images.agent
task.collector.image_digest = images.collector
task.verifier.image_digest = images.verifier

await writeFile(resolve(preparation, 'task.json'), `${JSON.stringify(task, null, 2)}\n`)

const packagePath = resolve(preparation, 'package')
let toml = await readFile(resolve(packagePath, 'task.toml'), 'utf8')

toml = toml.replace(`sha256:${'1'.repeat(64)}`, images.agent).replace(`sha256:${'3'.repeat(64)}`, images.verifier)

await writeFile(resolve(packagePath, 'task.toml'), toml)

const composePath = resolve(packagePath, 'environment/docker-compose.yaml')
const compose = await readFile(composePath, 'utf8')

await writeFile(composePath, compose.replace(`sha256:${'2'.repeat(64)}`, images.collector))

let providerAttempts = 0

const canary = createServer((_request, response) => {
  providerAttempts++

  response.writeHead(503)
  response.end('Provider calls are forbidden')
})

await new Promise<void>((done) => canary.listen(0, '0.0.0.0', done))

const address = canary.address() as AddressInfo
const previousBase = process.env.OPENAI_BASE_URL
const previousCredential = process.env.CODEX_AUTH_JSON_PATH

process.env.OPENAI_BASE_URL = `http://host.docker.internal:${address.port}`
process.env.CODEX_AUTH_JSON_PATH = '/not-a-credential-do-not-read'

const results: Record<string, unknown> = {}
const commands: Array<{ executable: string; args: readonly string[] }> = []

try {
  for (const scenario of ['healthy', 'network', 'credential', 'hidden', 'collector', 'missing-artifact', 'deleted-layer']) {
    if (scenario === 'deleted-layer') {
      task.environment.digest = deletedLayerImage

      await writeFile(resolve(preparation, 'task.json'), JSON.stringify(task))
      await writeFile(resolve(packagePath, 'task.toml'), toml.replace(images.agent, deletedLayerImage))
    }

    let harborCalls = 0

    const runtime: DoctorRuntime = {
      now: doctorRuntime.now,

      command: async (executable, args, home, signal) => {
        if (!['uname', 'docker', 'tar', resolve(repository, '.venv/bin/harbor')].includes(executable)) throw new Error('Unapproved executable')

        commands.push({
          executable,
          args
        })

        return doctorRuntime.command(executable, args, home, signal)
      },

      runHarbor: async (context) => {
        harborCalls++

        const job = JSON.parse(await readFile(context.configPath, 'utf8'))

        if (!['nop', 'oracle'].includes(job.agents[0].name) || context.authPath !== undefined || job.n_concurrent_trials !== 1 || job.retry.max_retries !== 0) throw new Error('Provider-free runtime contract changed')

        const packagePath = resolve(context.runDirectory, 'task')
        const tomlPath = resolve(packagePath, 'task.toml')
        const config = parseToml(await readFile(tomlPath, 'utf8'))
        const verifier = config.verifier as TomlTable
        const environment = verifier.environment as TomlTable
        const env = verifier.env as TomlTable
        const collect = verifier.collect as TomlTable[]

        if (scenario === 'network') {
          verifier.network_mode = 'public'
          environment.network_mode = 'public'

          await writeFile(resolve(packagePath, 'tests/docker-compose.yaml'), 'services:\n  main:\n    network_mode: bridge\n')
        }

        if (scenario === 'credential') env.OPENAI_API_KEY = 'synthetic-sentinel'

        if (scenario === 'hidden') collect.unshift({
          service: 'main',
          command: 'touch /doctor-hidden-sentinel',
          user: 'root',
          timeout_sec: 10
        })

        if (scenario === 'collector') collect[collect.length - 1]!.command = 'node -e "process.exit(42)"'

        await writeFile(tomlPath, stringifyToml(config))

        const outcome = await doctorRuntime.runHarbor(context)

        if (scenario === 'missing-artifact' && outcome.exitCode === 0) {
          const jobs = resolve(context.runDirectory, 'raw/harbor/job')

          for (const entry of await readdir(jobs, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name !== '.sources') await rm(resolve(jobs, entry.name, 'artifacts/trusted-collector/workspace-metadata.json'), { force: true })
          }
        }

        return outcome
      }
    }

    console.log(`Doctor integration: ${scenario}`)

    const outputDirectory = resolve(root, scenario)

    const report = await runDoctor({
      definition: definitionPath,
      outputDirectory,
      purpose: 'smoke'
    }, runtime)

    if ((scenario === 'healthy') !== (report.exit_code === 0)) throw new Error(`${scenario} produced an unexpected doctor outcome; inspect ${outputDirectory}`)

    if (report.checks.find((check) => check.code === 'HARBOR_CLEANUP')?.status !== 'passed' && scenario !== 'deleted-layer') throw new Error(`${scenario} did not prove cleanup`)

    if (scenario === 'deleted-layer') {
      if (harborCalls !== 0) throw new Error('Forbidden image reached Harbor')

      if (report.checks.find((check) => check.code === 'AGENT_IMAGE_LAYERS')?.failure_code !== 'HIDDEN_IMAGE_MATERIAL') throw new Error('Deleted historical image material was not detected')
    } else if (scenario !== 'healthy') {
      const evidenceRoot = report.checks.some((check) => check.code === 'EVIDENCE_RESTRICTED') ? 'quarantine/raw' : 'raw'
      const jobs = resolve(outputDirectory, evidenceRoot, 'cases/pristine/raw/harbor/job')
      const entries = await readdir(jobs, { withFileTypes: true })
      const trial = entries.find((entry) => entry.isDirectory() && entry.name !== '.sources')

      if (trial === undefined) throw new Error(`${scenario} has no trial evidence`)

      const trialPath = resolve(jobs, trial.name)

      if (scenario === 'network' || scenario === 'credential') {
        const verifier = JSON.parse(await readFile(resolve(trialPath, 'verifier/verifier-result.json'), 'utf8'))
        const field = scenario === 'network' ? 'networkIsolated' : 'credentialsAbsent'

        if (verifier.integrity[field] !== false) throw new Error(`${scenario} did not fail the intended integrity property`)
      }

      if (scenario === 'hidden') {
        const probe = JSON.parse(await readFile(resolve(trialPath, 'agent/doctor-probe.json'), 'utf8'))

        if (probe.hidden_material_absent !== false || probe.git_isolated !== true || probe.credentials_absent !== true) throw new Error('Hidden sentinel did not isolate the intended visibility property')
      }

      if (scenario === 'collector') {
        const log = await readFile(resolve(trialPath, 'trial.log'), 'utf8')

        if (!log.includes('Collect hook in service \'collector\' exited with code 42:')) throw new Error('Collector control did not retain the injected exit code')
      }

      if (scenario === 'missing-artifact') {
        const failure = report.checks.find((check) => check.code === 'CONTROL_pristine')

        if (failure?.status !== 'failed' || failure.stage !== 'verification') throw new Error('Missing artifact was not rejected at evidence validation')
      }
    }

    results[scenario] = {
      harbor_calls: harborCalls,
      exit_code: report.exit_code,
      checks: report.checks,
      evidence: outputDirectory,
      report_digest: doctorDigest(await readFile(resolve(outputDirectory, 'report.json')))
    }
  }

  if (providerAttempts !== 0) throw new Error('Provider canary observed a request')

  await writeDoctorJson(resolve(root, 'summary.json'), {
    provider_attempts: providerAttempts,
    automatic_retries: 0,
    harbor_telemetry: 'off',
    image_digests: images,
    source_digest: source.digest,
    commands,
    results
  })

  console.log(`Doctor integration evidence: ${root}`)
} finally {
  if (previousBase === undefined) delete process.env.OPENAI_BASE_URL
  else process.env.OPENAI_BASE_URL = previousBase

  if (previousCredential === undefined) delete process.env.CODEX_AUTH_JSON_PATH
  else process.env.CODEX_AUTH_JSON_PATH = previousCredential

  await new Promise<void>((done, reject) => canary.close((error) => error === undefined ? done() : reject(error)))
}
