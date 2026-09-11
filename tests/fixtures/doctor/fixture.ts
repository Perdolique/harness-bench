import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildOrderReceiptTaskDocument } from '../../../benchmark/tasks/order-receipt/task-document.ts'
import { inspectTaskSource, materializeTaskWorkspace } from '../../../packages/core/src/task.ts'
import { doctorDigest, writeDoctorJson } from '../../../packages/core/src/doctor-storage.ts'
import { makeDoctorHarness } from '../doctor.ts'
import type { DoctorControl, DoctorDefinition } from '../../../packages/core/src/doctor-contracts.ts'

export const fixtureImages = {
  agent: `sha256:${'1'.repeat(64)}`,
  collector: `sha256:${'2'.repeat(64)}`,
  verifier: `sha256:${'3'.repeat(64)}`
}

export async function prepareDoctorFixture(root: string, images = fixtureImages): Promise<string> {
  const source = resolve(root, 'source')

  await mkdir(source, { recursive: true })
  await writeFile(resolve(source, 'README.md'), 'A small deterministic calibration task.\n')
  await writeFile(resolve(source, 'regression.txt'), 'enabled\n')
  await writeFile(resolve(source, 'forbidden.txt'), 'unchanged\n')
  await writeFile(resolve(source, 'package.json'), '{"name":"doctor-fixture","version":"1.0.0","packageManager":"pnpm@11.25.0"}\n')
  await writeFile(resolve(source, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\nimporters:\n  .: {}\n')

  const snapshot = await inspectTaskSource(source)

  const materialized = await materializeTaskWorkspace({
    source,
    destination: resolve(root, 'workspace'),
    expectedSourceDigest: snapshot.digest
  })

  const base = await buildOrderReceiptTaskDocument({
    baseCommit: materialized.baseCommit,
    sourceDigest: snapshot.digest,
    environmentImageDigest: images.agent,
    collectorImageDigest: images.collector,
    verifierImageDigest: images.verifier
  })

  const prompt = 'Create RESULT.md and a candidate test. Preserve the regression and forbidden file.\n'

  const task = {
    ...base,

    rubric: [
      {
        obligation_id: 'direct',
        facet: 'direct_behavior',
        expectation: 'Create the requested fixture result',
        evidence_paths: ['README.md'],
        justification: 'The pristine fixture describes the requested result',
        deterministic_check: 'tests/fixture#direct',
        applicability: 'required',
        weight: 1
      },
      {
        obligation_id: 'contracts',
        facet: 'repository_contracts',
        expectation: 'Add a candidate test',
        evidence_paths: ['README.md'],
        justification: 'The pristine fixture defines the candidate test contract',
        deterministic_check: 'tests/fixture#contracts',
        applicability: 'required',
        weight: 1
      },
      {
        obligation_id: 'regression',
        facet: 'regression',
        expectation: 'Preserve the enabled regression marker',
        evidence_paths: ['regression.txt'],
        justification: 'The pristine marker records the protected behavior',
        deterministic_check: 'tests/fixture#regression',
        applicability: 'required',
        weight: 1
      },
      {
        obligation_id: 'scope',
        facet: 'scope_integrity',
        expectation: 'Keep the forbidden fixture file unchanged',
        evidence_paths: ['forbidden.txt'],
        justification: 'The pristine file records the task scope boundary',
        deterministic_check: 'tests/fixture#scope',
        applicability: 'required',
        weight: 1
      }
    ],

    task_id: 'doctor-fixture',

    scoring: {
      revision: '1',
      rubric_revision: '1'
    },

    prompt: {
      path: 'instruction.md',
      digest: doctorDigest(prompt)
    }
  }

  await writeDoctorJson(resolve(root, 'task.json'), task)

  const packagePath = resolve(root, 'package')

  await mkdir(resolve(packagePath, 'environment'), { recursive: true })
  await mkdir(resolve(packagePath, 'tests'), { recursive: true })
  await writeFile(resolve(packagePath, 'instruction.md'), prompt)

  const taskRoot = resolve(import.meta.dirname, '../../../benchmark/tasks/order-receipt')
  let toml = await readFile(resolve(taskRoot, 'task.toml.template'), 'utf8')

  for (const [key, value] of Object.entries({
    __AGENT_IMAGE__: images.agent,
    __VERIFIER_IMAGE__: images.verifier,
    __TASK_BASE_COMMIT__: materialized.baseCommit,
    __TASK_SOURCE_DIGEST__: snapshot.digest
  })) toml = toml.replaceAll(key, value)

  await writeFile(resolve(packagePath, 'task.toml'), toml)

  let compose = await readFile(resolve(taskRoot, 'environment/docker-compose.yaml.template'), 'utf8')

  for (const [key, value] of Object.entries({
    __COLLECTOR_IMAGE__: images.collector,
    __TASK_BASE_COMMIT__: materialized.baseCommit,
    __TASK_SOURCE_DIGEST__: snapshot.digest
  })) compose = compose.replaceAll(key, value)

  await writeFile(resolve(packagePath, 'environment/docker-compose.yaml'), compose)
  await writeFile(resolve(packagePath, 'tests/docker-compose.yaml'), 'services:\n  main:\n    network_mode: none\n')

  const positive = {
    contracts: true,
    direct: true,
    regression: true,
    scope: true
  }

  const controls: DoctorControl[] = [{
    id: 'pristine',
    kind: 'pristine',

    expected_checks: {
      contracts: false,
      direct: false,
      regression: true,
      scope: true
    }
  }]

  for (const [id, kind, mutation, expected] of [
    ['reference', 'reference', '', positive],
    ['alternate', 'alternate', '', positive],
    ['deleted', 'test_deletion', 'rm /app/candidate.test.txt', { contracts: false }],
    ['disabled', 'test_disablement', 'printf \'disabled\\n\' > /app/regression.txt', { regression: false }],
    ['forbidden', 'forbidden_edit', 'printf \'changed\\n\' > /app/forbidden.txt', { scope: false }]
  ] as const) {
    const solution = resolve(root, 'solutions', id)

    await mkdir(solution, { recursive: true })
    await writeFile(resolve(solution, 'solve.sh'), `#!/bin/sh\nset -eu\nprintf 'success\\n' > /app/RESULT.md\nprintf 'test\\n' > /app/candidate.test.txt\n${mutation}\nprintf 'CALIBRATION_ORACLE_OK\\n'\n`, { mode: 0o755 })

    controls.push({
      id,
      kind,
      solution,
      expected_checks: expected
    })
  }

  const bundle = await makeDoctorHarness(resolve(root, 'harness'))

  const definition: DoctorDefinition = {
    document_type: 'doctor_definition',
    schema_version: 1,
    revision: '1',
    task_document: 'task.json',
    task_source: 'source',
    task_package: 'package',
    harness_bundle: bundle,
    forbidden_agent_paths: ['/tests-hidden', '/doctor-hidden-sentinel'],
    controls
  }

  const path = resolve(root, 'definition.json')

  await writeDoctorJson(path, definition)

  return path
}

export async function removeDoctorFixture(root: string): Promise<void> {
  const { lstat, readdir } = await import('node:fs/promises')
  const stat = await lstat(root).catch(() => undefined)

  if (stat === undefined) return

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    await rm(root, { force: true })

    return
  }

  await chmod(root, 0o700)

  for (const name of await readdir(root)) await removeDoctorFixture(resolve(root, name))

  await rm(root, {
    recursive: true,
    force: true
  })
}
