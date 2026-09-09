import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExperimentPlan, ResolvedScoringMigrationDefinition } from '@harness-bench/core'
import type { TaskDocument } from '@harness-bench/schemas'
import { regradeExperiment, type ExperimentRegradeDependencies, type ExperimentRegradeRuntime } from '../src/regrade.ts'
import type { ExperimentComparisonSource } from '../src/experiment.ts'
import type { ReadRegradedRunRecordResult } from '../src/regrade-storage.ts'

const digest = (character: string): string => `sha256:${character.repeat(64)}`
let root: string

beforeEach(async () => {
  root = await mkdtemp('/tmp/harness-bench-regrade-orchestration-')
})

afterEach(async () => {
  await rm(root, {
    force: true,
    recursive: true
  })
})

function task(revision: string): TaskDocument {
  return {
    verifier: {
      revision,
      image_digest: digest('a'),

      network_enforcement_sidecar_digest: {
        status: 'not_applicable',
        reason: 'Docker network mode is none'
      }
    },

    scoring: {
      revision,
      rubric_revision: revision
    },

    rubric: [{ revision }]
  } as unknown as TaskDocument
}

function fixtureSource(): ExperimentComparisonSource {
  const records = [
    {
      digest: digest('1'),
      recordPath: resolve(root, '.results/run-valid/normalized/record.json'),
      runDirectory: resolve(root, 'run-valid'),

      record: {
        identities: {
          run: {
            run_id: 'run-valid',
            attempt_id: 'run-valid-attempt-1'
          },

          task: { id: 'fixture-task' }
        },

        outcome: {
          classification: 'task_success',
          valid_grade: true
        }
      }
    },
    {
      digest: digest('2'),
      recordPath: resolve(root, '.results/run-technical/normalized/record.json'),
      runDirectory: resolve(root, 'run-technical'),

      record: {
        identities: {
          run: {
            run_id: 'run-technical',
            attempt_id: 'run-technical-attempt-1'
          },

          task: { id: 'fixture-task' }
        },

        outcome: {
          classification: 'runner_failure',
          valid_grade: false
        }
      }
    }
  ]

  return {
    records,

    state: {
      superseded: false,

      blocks: [{
        status: 'completed',

        runs: records.map((record) => ({
          status: 'verified',

          assignment: {
            run_id: record.record.identities.run.run_id
          }
        }))
      }],

      excluded_blocks: []
    }
  } as unknown as ExperimentComparisonSource
}

function plan(): ExperimentPlan {
  return {
    runs_directory: root,

    experiment: {
      experiment_id: 'fixture-experiment',
      revision: '1',
      plan_digest: digest('3')
    }
  } as unknown as ExperimentPlan
}

function migration(): ResolvedScoringMigrationDefinition {
  return {
    definition: {
      migration_id: 'fixture-migration',
      revision: '2'
    },

    digest: digest('4'),

    targets: [{
      taskId: 'fixture-task',
      documentDigest: digest('5'),
      packageDigest: digest('6'),
      sourceTask: task('1'),
      targetTask: task('2')
    }]
  } as unknown as ResolvedScoringMigrationDefinition
}

function harness(source = fixtureSource()) {
  const release = vi.fn(async () => Promise.resolve())
  const readSource = vi.fn(async () => source)

  const regradeSource = vi.fn(async (record) => ({
    digest: digest('7'),
    recordPath: resolve(root, `.results/${record.record.identities.run.run_id}/regrades/record.json`)
  } as ReadRegradedRunRecordResult))

  const writeMigration = vi.fn(async (_plan, record) => ({
    digest: digest('8'),
    record,
    recordPath: resolve(root, '.experiments/migrations/record.json')
  }))

  const dependencies = {
    lockExperiment: vi.fn(async () => release),
    readPlan: vi.fn(async () => plan()),
    readSource,
    regradeSource,
    resolveDefinition: vi.fn(async () => migration()),

    withRunLocks: vi.fn(async (_runsRoot, _runIds, operation) =>
      operation()
    ),

    writeMigration
  } as unknown as ExperimentRegradeDependencies

  const runtime = {
    execute: vi.fn(),
    now: () => new Date('2026-09-08T10:00:00.000Z'),
    preflight: vi.fn(async () => Promise.resolve())
  } as unknown as ExperimentRegradeRuntime

  return {
    dependencies,
    readSource,
    regradeSource,
    release,
    runtime,
    writeMigration
  }
}

describe('regradeExperiment', () => {
  it('preflights every source before regrading and retains technical outcomes', async () => {
    const test = harness()

    const result = await regradeExperiment(
      '/plan.json',
      '/definition.json',
      test.runtime,
      test.dependencies
    )

    expect(test.runtime.preflight).toHaveBeenCalledTimes(2)
    expect(test.regradeSource).toHaveBeenCalledTimes(1)
    expect(test.writeMigration).toHaveBeenCalledTimes(1)
    expect(result.regradedRuns).toBe(1)
    expect(result.retainedTechnicalRuns).toBe(1)

    expect(result.migration.record.entries).toContainEqual({
      run_id: 'run-technical',
      attempt_id: 'run-technical-attempt-1',
      source_normalized_digest: digest('2'),
      status: 'retained_technical',
      classification: 'runner_failure'
    })

    expect(test.release).toHaveBeenCalledOnce()
  })

  it('publishes no derived result when a later preflight fails', async () => {
    const source = fixtureSource()
    const technical = source.records[1]!

    Object.assign(technical.record.outcome, {
      classification: 'task_success',
      valid_grade: true
    })

    const test = harness(source)

    vi.mocked(test.runtime.preflight)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('late preflight failure'))

    await expect(
      regradeExperiment(
        '/plan.json',
        '/definition.json',
        test.runtime,
        test.dependencies
      )
    ).rejects.toThrow('late preflight failure')

    expect(test.regradeSource).not.toHaveBeenCalled()
    expect(test.writeMigration).not.toHaveBeenCalled()
    expect(test.release).toHaveBeenCalledOnce()
  })

  it('rejects source changes after result leases are acquired', async () => {
    const source = fixtureSource()
    const locked = structuredClone(source)

    Object.assign(locked.records[0]!, { digest: digest('9') })

    const test = harness(source)

    test.readSource
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(locked)

    await expect(
      regradeExperiment(
        '/plan.json',
        '/definition.json',
        test.runtime,
        test.dependencies
      )
    ).rejects.toMatchObject({ code: 'INPUT_CHANGED' })

    expect(test.runtime.preflight).not.toHaveBeenCalled()
    expect(test.regradeSource).not.toHaveBeenCalled()
    expect(test.release).toHaveBeenCalledOnce()
  })

  it('rejects an incomplete experiment before resolving a migration', async () => {
    const source = fixtureSource()

    Object.assign(source.state.blocks[0]!, { status: 'in_progress' })

    const test = harness(source)

    await expect(
      regradeExperiment(
        '/plan.json',
        '/definition.json',
        test.runtime,
        test.dependencies
      )
    ).rejects.toMatchObject({ code: 'EXECUTION_FAILED' })

    expect(test.dependencies.resolveDefinition).not.toHaveBeenCalled()
    expect(test.release).toHaveBeenCalledOnce()
  })
})
