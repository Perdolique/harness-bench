import { describe, expect, it } from 'vitest'
import type { TaskDocument } from '@harness-bench/schemas'

import {
  notificationRetryControls,
  notificationRetryEvidence,
  notificationRetryTask
} from '../../../tests/fixtures/rubric/notification-retry.ts'

import { assertRubricDoctorControls, assertRubricEvidencePaths, assertTaskScoreEvidence } from '../src/task-rubric.ts'

function cloneEvidence() {
  return structuredClone(notificationRetryEvidence())
}

describe('task rubric contract', () => {
  it('accepts weighted credit, optional checks, and absent facets', () => {
    const evidence = notificationRetryEvidence({ 'candidate-tests': 0.5 })

    expect(evidence.score.facets.repository_contracts).toMatchObject({
      status: 'value',
      value: 5 / 6
    })

    expect(evidence.score.facets.maintainability).toMatchObject({
      status: 'not_applicable',
      evidence: []
    })

    expect(() => assertTaskScoreEvidence(
      notificationRetryTask,
      evidence.score,
      evidence.verifierResult
    )).not.toThrow()
  })

  it('accepts a valid task with no repository-contract obligations', () => {
    const task = structuredClone(notificationRetryTask) as TaskDocument

    task.rubric = task.rubric.filter(
      ({ facet }) => !['repository_contracts', 'scope_integrity'].includes(facet)
    )

    const evidence = notificationRetryEvidence()

    delete evidence.verifierResult.checks['established-logging']
    delete evidence.verifierResult.checks['candidate-tests']
    delete evidence.verifierResult.checks['scope-boundary']

    evidence.score.facets.repository_contracts = {
      status: 'not_applicable',
      reason: 'No repository contracts are declared',
      evidence: []
    }

    evidence.score.facets.scope_integrity = {
      status: 'not_applicable',
      reason: 'No scope facet is declared',
      evidence: []
    }

    expect(() => assertTaskScoreEvidence(
      task,
      evidence.score,
      evidence.verifierResult
    )).not.toThrow()
  })

  it.each([
    ['missing check', (value: ReturnType<typeof cloneEvidence>) => {
      delete value.verifierResult.checks['retry-once']
    }],
    ['extra check', (value: ReturnType<typeof cloneEvidence>) => {
      value.verifierResult.checks.extra = {
        facet: 'direct_behavior',
        passed: true,
        credit: 1,
        detail: 'Unexpected check'
      }
    }],
    ['facet mismatch', (value: ReturnType<typeof cloneEvidence>) => {
      value.verifierResult.checks['retry-once']!.facet = 'regression'
    }],
    ['missing credit', (value: ReturnType<typeof cloneEvidence>) => {
      delete (value.verifierResult.checks['retry-once'] as Partial<{ credit: number }>).credit
    }],
    ['missing detail', (value: ReturnType<typeof cloneEvidence>) => {
      delete (value.verifierResult.checks['retry-once'] as Partial<{ detail: string }>).detail
    }],
    ['extra check field', (value: ReturnType<typeof cloneEvidence>) => {
      Object.assign(value.verifierResult.checks['retry-once']!, {
        command: 'unsupported raw detail'
      })
    }],
    ['credit below zero', (value: ReturnType<typeof cloneEvidence>) => {
      value.verifierResult.checks['retry-once']!.credit = -0.1
    }],
    ['credit above one', (value: ReturnType<typeof cloneEvidence>) => {
      value.verifierResult.checks['retry-once']!.credit = 1.1
    }],
    ['wrong weighted score', (value: ReturnType<typeof cloneEvidence>) => {
      if (value.score.facets.repository_contracts.status === 'value') {
        value.score.facets.repository_contracts.value = 0.75
      }
    }],
    ['numeric absent facet', (value: ReturnType<typeof cloneEvidence>) => {
      value.score.facets.maintainability = {
        status: 'value',
        value: 1,
        evidence: []
      }
    }],
    ['not-applicable declared facet', (value: ReturnType<typeof cloneEvidence>) => {
      value.score.facets.repository_contracts = {
        status: 'not_applicable',
        reason: 'Incorrectly omitted',
        evidence: []
      }
    }]
  ] as const)('rejects %s', (_name, mutate) => {
    const value = cloneEvidence()

    mutate(value)

    expect(() => assertTaskScoreEvidence(
      notificationRetryTask,
      value.score,
      value.verifierResult
    )).toThrow()
  })

  it('accepts direct-edit and conditional-helper calibration controls', () => {
    expect(() => assertRubricDoctorControls(
      notificationRetryTask,
      notificationRetryControls
    )).not.toThrow()
  })

  it('rejects an unknown doctor check', () => {
    const controls = structuredClone(notificationRetryControls)

    const disablement = controls.find(
      ({ kind }) => kind === 'test_disablement'
    ) as { expected_checks: Record<string, boolean> }

    disablement.expected_checks.unknown = false

    expect(() => assertRubricDoctorControls(
      notificationRetryTask,
      controls
    )).toThrow(/unknown rubric obligation/)
  })

  it('requires every evidence path in the pristine source', () => {
    const paths = new Set(
      notificationRetryTask.rubric.flatMap(({ evidence_paths }) => evidence_paths)
    )

    expect(() => assertRubricEvidencePaths(
      notificationRetryTask,
      paths
    )).not.toThrow()

    paths.delete('src/logger.ts')

    expect(() => assertRubricEvidencePaths(
      notificationRetryTask,
      paths
    )).toThrow(/src\/logger\.ts/)
  })
})
