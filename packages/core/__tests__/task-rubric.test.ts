import { describe, expect, it } from 'vitest'
import type { TaskDocument } from '@harness-bench/schemas'
import * as v from 'valibot'

import {
  notificationRetryControls,
  notificationRetryEvidence,
  notificationRetryTask,
  taskRubricEvidence
} from '../../../tests/fixtures/rubric/notification-retry.ts'

import { assertRubricDoctorControls, assertRubricEvidencePaths, assertTaskScoreEvidence } from '../src/task-rubric.ts'
import { DoctorDefinitionSchema } from '../src/doctor-contracts.ts'

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

  it('keeps weighted credit stable for a subnormal positive weight', () => {
    const task = structuredClone(notificationRetryTask) as TaskDocument

    const direct = task.rubric.find(
      ({ obligation_id }) => obligation_id === 'retry-once'
    )!

    direct.weight = Number.MIN_VALUE

    const evidence = taskRubricEvidence(task, {
      credits: { 'retry-once': 0.5 }
    })

    expect(evidence.score.facets.direct_behavior).toMatchObject({
      status: 'value',
      value: 0.5
    })

    expect(() => assertTaskScoreEvidence(
      task,
      evidence.score,
      evidence.verifierResult
    )).not.toThrow()
  })

  it('excludes failed optional direct and regression checks from hard gates', () => {
    const task = structuredClone(notificationRetryTask) as TaskDocument

    task.rubric.push(
      {
        ...task.rubric[0]!,
        obligation_id: 'optional-direct',
        applicability: 'optional'
      },
      {
        ...task.rubric.find(({ facet }) => facet === 'regression')!,
        obligation_id: 'optional-regression',
        applicability: 'optional'
      }
    )

    const evidence = taskRubricEvidence(task, {
      passed: {
        'optional-direct': false,
        'optional-regression': false
      }
    })

    expect(evidence.score.gates).toStrictEqual({
      direct_behavior_pass: true,
      regression_pass: true
    })

    expect(() => assertTaskScoreEvidence(
      task,
      evidence.score,
      evidence.verifierResult
    )).not.toThrow()
  })

  it.each([
    ['scope passes with a violation', {
      passed: {},
      credits: {}
    }],
    ['scope fails with full credit', {
      passed: { 'scope-boundary': false },
      credits: { 'scope-boundary': 1 }
    }]
  ] as const)('rejects when %s', (_name, overrides) => {
    const evidence = taskRubricEvidence(notificationRetryTask, {
      ...overrides,

      scopeViolations: [{
        path: 'package.json',
        reason: 'Forbidden dependency change'
      }]
    })

    expect(() => assertTaskScoreEvidence(
      notificationRetryTask,
      evidence.score,
      evidence.verifierResult
    )).toThrow(/Scope violations/)
  })

  it('rejects a failed scope check without a recorded violation', () => {
    const evidence = taskRubricEvidence(notificationRetryTask, {
      passed: { 'scope-boundary': false }
    })

    expect(() => assertTaskScoreEvidence(
      notificationRetryTask,
      evidence.score,
      evidence.verifierResult
    )).toThrow(/Scope violations/)
  })

  it('accepts a failed scope check with reduced credit and matching violation', () => {
    const evidence = taskRubricEvidence(notificationRetryTask, {
      passed: { 'scope-boundary': false },

      scopeViolations: [{
        path: 'package.json',
        reason: 'Forbidden dependency change'
      }]
    })

    expect(() => assertTaskScoreEvidence(
      notificationRetryTask,
      evidence.score,
      evidence.verifierResult
    )).not.toThrow()
  })

  it('accepts scope violations when the scope facet is not applicable', () => {
    const task = structuredClone(notificationRetryTask) as TaskDocument

    task.rubric = task.rubric.filter(
      ({ facet }) => facet !== 'scope_integrity'
    )

    const evidence = taskRubricEvidence(task, {
      scopeViolations: [{
        path: 'package.json',
        reason: 'Forbidden dependency change'
      }]
    })

    expect(evidence.score.facets.scope_integrity).toMatchObject({
      status: 'not_applicable',
      evidence: []
    })

    expect(() => assertTaskScoreEvidence(
      task,
      evidence.score,
      evidence.verifierResult
    )).not.toThrow()
  })

  it('rejects a forged scope violation digest with matching path and reason', () => {
    const evidence = taskRubricEvidence(notificationRetryTask, {
      passed: { 'scope-boundary': false },

      scopeViolations: [{
        path: 'package.json',
        reason: 'Forbidden dependency change'
      }]
    })

    evidence.score.scope_violations[0]!.evidence_digest = `sha256:${'0'.repeat(64)}`

    expect(() => assertTaskScoreEvidence(
      notificationRetryTask,
      evidence.score,
      evidence.verifierResult
    )).toThrow(/scope violations do not match/)
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

  it.each([
    ['pristine required direct behavior', 'pristine', { 'retry-once': true }],
    ['pristine required regression', 'pristine', { 'existing-delivery': false }],
    ['reference positive inventory', 'reference', { 'retry-once': false }],
    ['alternate positive inventory', 'alternate', { 'retry-once': false }],
    ['test deletion repository contract', 'test_deletion', {
      'candidate-tests': true,
      'retry-once': false
    }],
    ['test disablement regression', 'test_disablement', {
      'existing-delivery': true,
      'retry-once': false
    }],
    ['forbidden edit scope', 'forbidden_edit', {
      'scope-boundary': true,
      'retry-once': false
    }]
  ] as const)('rejects an invalid %s control', (_name, kind, overrides) => {
    const controls = structuredClone(notificationRetryControls)
    const control = controls.find((candidate) => candidate.kind === kind)!

    Object.assign(control.expected_checks, overrides)

    expect(() => assertRubricDoctorControls(
      notificationRetryTask,
      controls
    )).toThrow()
  })

  it('accepts a forbidden-edit control for a task without scope obligations', () => {
    const task = structuredClone(notificationRetryTask) as TaskDocument

    task.rubric = task.rubric.filter(
      ({ facet }) => facet !== 'scope_integrity'
    )

    const controls = structuredClone(notificationRetryControls)

    for (const control of controls) {
      const expectedChecks = control.expected_checks as Record<string, boolean>

      delete expectedChecks['scope-boundary']
    }

    const forbidden = controls.find(
      ({ kind }) => kind === 'forbidden_edit'
    )!

    Object.assign(forbidden.expected_checks, { 'retry-once': true })
    expect(() => assertRubricDoctorControls(task, controls)).not.toThrow()

    const definition = {
      document_type: 'doctor_definition',
      schema_version: 1,
      revision: 'no-scope-v1',
      task_document: 'task.json',
      task_source: 'source',
      task_package: 'package',
      harness_bundle: 'harness',
      forbidden_agent_paths: ['/hidden'],

      controls: controls.map((control) => ({
        ...control,

        ...(control.kind === 'pristine'
          ? {}
          : { solution: `solutions/${control.id}` })
      }))
    }

    expect(v.safeParse(DoctorDefinitionSchema, definition).success).toBe(true)
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
