import { createHash } from 'node:crypto'
import type { TaskDocument } from '@harness-bench/schemas'
import * as v from 'valibot'

const FACETS = [
  'direct_behavior',
  'repository_contracts',
  'regression',
  'scope_integrity',
  'maintainability'
] as const

const CHECK_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const SCORE_TOLERANCE = 1e-12
const CheckIdSchema = v.pipe(v.string(), v.regex(CHECK_ID_PATTERN))

export const RubricCheckSchema = v.strictObject({
  facet: v.picklist(FACETS),
  passed: v.boolean(),
  credit: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  detail: v.string()
})

export const RubricChecksSchema = v.record(CheckIdSchema, RubricCheckSchema)

const ScopeViolationSchema = v.strictObject({
  path: v.pipe(v.string(), v.minLength(1)),
  reason: v.pipe(v.string(), v.minLength(1))
})

const ScopeViolationsSchema = v.array(ScopeViolationSchema)

export type RubricCheck = v.InferOutput<typeof RubricCheckSchema>
export type RubricFacet = typeof FACETS[number]

interface ScoreEvidence {
  readonly check_id: string;
  readonly outcome: 'passed' | 'failed';
  readonly evidence_digest: string;
}

interface ScoreFacet {
  readonly status: 'value' | 'unknown' | 'not_applicable';
  readonly value?: number;
  readonly evidence: readonly ScoreEvidence[];
}

interface RubricScore {
  readonly facets: Readonly<Record<RubricFacet, ScoreFacet>>;
  readonly gates: {
    readonly direct_behavior_pass: boolean;
    readonly regression_pass: boolean;
  };
  readonly scope_violations: readonly {
    readonly path: string;
    readonly reason: string;
    readonly evidence_digest: string;
  }[];
}

export interface RubricDoctorControl {
  readonly id: string;
  readonly kind:
    | 'pristine'
    | 'reference'
    | 'alternate'
    | 'test_deletion'
    | 'test_disablement'
    | 'forbidden_edit'
    | 'negative';
  readonly expected_checks: Readonly<Record<string, boolean>>;
}

export class RubricValidationError extends Error {
  constructor(message: string) {
    super(message)

    this.name = 'RubricValidationError'
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right, 'en'))
}

function sameInventory(left: Iterable<string>, right: Iterable<string>): boolean {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right))
}

function parseChecks(candidate: unknown): Readonly<Record<string, RubricCheck>> {
  const result = v.safeParse(RubricChecksSchema, candidate)

  if (!result.success) {
    throw new RubricValidationError(
      'Verifier checks must use the strict rubric check shape'
    )
  }

  return result.output
}

export function assertRubricEvidencePaths(
  task: TaskDocument,
  pristinePaths: ReadonlySet<string>
): void {
  for (const obligation of task.rubric) {
    for (const path of obligation.evidence_paths) {
      if (!pristinePaths.has(path)) {
        throw new RubricValidationError(
          `Rubric obligation ${obligation.obligation_id} has no pristine evidence at ${path}`
        )
      }
    }
  }
}

export function assertRubricDoctorControls(
  task: TaskDocument,
  controls: readonly RubricDoctorControl[]
): void {
  const obligationIds = new Set(task.rubric.map(({ obligation_id }) => obligation_id))
  const completeKinds = new Set(['pristine', 'reference', 'alternate'])

  for (const control of controls) {
    const checkIds = Object.keys(control.expected_checks)

    if (checkIds.some((checkId) => !obligationIds.has(checkId))) {
      throw new RubricValidationError(
        `Doctor control ${control.id} references an unknown rubric obligation`
      )
    }

    if (completeKinds.has(control.kind) && !sameInventory(checkIds, obligationIds)) {
      throw new RubricValidationError(
        `Doctor control ${control.id} must declare the complete rubric inventory`
      )
    }
  }

  const requiredDirect = task.rubric.filter(
    ({ applicability, facet }) =>
      applicability === 'required' && facet === 'direct_behavior'
  )

  const requiredRegression = task.rubric.filter(
    ({ applicability, facet }) =>
      applicability === 'required' && facet === 'regression'
  )

  const scopeObligations = task.rubric.filter(
    ({ facet }) => facet === 'scope_integrity'
  )

  const pristine = controls.find(({ kind }) => kind === 'pristine')
  const reference = controls.find(({ kind }) => kind === 'reference')
  const alternate = controls.find(({ kind }) => kind === 'alternate')
  const disablement = controls.find(({ kind }) => kind === 'test_disablement')
  const forbidden = controls.find(({ kind }) => kind === 'forbidden_edit')

  if (
    pristine === undefined ||
    !requiredDirect.some(({ obligation_id }) =>
      pristine.expected_checks[obligation_id] === false
    ) ||
    !requiredRegression.every(({ obligation_id }) =>
      pristine.expected_checks[obligation_id] === true
    )
  ) {
    throw new RubricValidationError(
      'Pristine control must fail a required direct check and pass required regressions'
    )
  }

  for (const positive of [reference, alternate]) {
    if (
      positive === undefined ||
      !Object.values(positive.expected_checks).every(Boolean)
    ) {
      throw new RubricValidationError(
        'Reference and alternate controls must pass every rubric obligation'
      )
    }
  }

  if (
    disablement === undefined ||
    !requiredRegression.some(({ obligation_id }) =>
      disablement.expected_checks[obligation_id] === false
    )
  ) {
    throw new RubricValidationError(
      'Test disablement must fail a required regression obligation'
    )
  }

  if (
    forbidden === undefined ||
    scopeObligations.length === 0 ||
    !scopeObligations.some(({ obligation_id }) =>
      forbidden.expected_checks[obligation_id] === false
    )
  ) {
    throw new RubricValidationError(
      'Forbidden edit must fail a scope integrity obligation'
    )
  }
}

export function assertTaskScoreEvidence(
  task: TaskDocument,
  score: RubricScore,
  verifierResult: Readonly<Record<string, unknown>>
): void {
  const rawChecks = verifierResult.checks
  const checks = parseChecks(rawChecks)

  const obligations = new Map(
    task.rubric.map((obligation) => [obligation.obligation_id, obligation])
  )

  if (!sameInventory(Object.keys(checks), obligations.keys())) {
    throw new RubricValidationError(
      'Verifier check inventory must exactly match the task rubric'
    )
  }

  const referencedChecks = new Set<string>()

  for (const facetName of FACETS) {
    const facet = score.facets[facetName]
    const facetObligations = task.rubric.filter(({ facet }) => facet === facetName)

    if (facetObligations.length === 0) {
      if (facet.status !== 'not_applicable' || facet.evidence.length !== 0) {
        throw new RubricValidationError(
          `Facet ${facetName} must be not_applicable without evidence`
        )
      }

      continue
    }

    if (facet.status !== 'value' || facet.value === undefined) {
      throw new RubricValidationError(
        `Declared facet ${facetName} must have a numeric value`
      )
    }

    if (!sameInventory(
      facet.evidence.map(({ check_id }) => check_id),
      facetObligations.map(({ obligation_id }) => obligation_id)
    )) {
      throw new RubricValidationError(
        `Facet ${facetName} evidence must exactly match its rubric obligations`
      )
    }

    let weightedCredit = 0
    let totalWeight = 0

    for (const obligation of facetObligations) {
      const checkId = obligation.obligation_id
      const check = checks[checkId]!
      const evidence = facet.evidence.find((entry) => entry.check_id === checkId)!

      if (check.facet !== facetName || referencedChecks.has(checkId)) {
        throw new RubricValidationError(
          'Each verifier check must bind to exactly one matching rubric facet'
        )
      }

      referencedChecks.add(checkId)

      if (
        evidence.outcome !== (check.passed ? 'passed' : 'failed') ||
        evidence.evidence_digest !== digest(
          (rawChecks as Record<string, unknown>)[checkId]
        )
      ) {
        throw new RubricValidationError(
          `Score evidence does not match verifier check ${checkId}`
        )
      }

      weightedCredit += obligation.weight * check.credit
      totalWeight += obligation.weight
    }

    const expectedValue = weightedCredit / totalWeight

    if (Math.abs(facet.value - expectedValue) > SCORE_TOLERANCE) {
      throw new RubricValidationError(
        `Facet ${facetName} does not match its weighted rubric credit`
      )
    }
  }

  if (referencedChecks.size !== Object.keys(checks).length) {
    throw new RubricValidationError(
      'Score must reference every verifier check exactly once'
    )
  }

  const requiredGate = (facet: 'direct_behavior' | 'regression'): boolean =>
    task.rubric
      .filter(
        ({ applicability, facet: obligationFacet }) =>
          applicability === 'required' && obligationFacet === facet
      )
      .every(({ obligation_id }) => checks[obligation_id]!.passed)

  if (
    score.gates.direct_behavior_pass !== requiredGate('direct_behavior') ||
    score.gates.regression_pass !== requiredGate('regression')
  ) {
    throw new RubricValidationError(
      'Score gates do not match required rubric checks'
    )
  }

  const scopeResult = v.safeParse(
    ScopeViolationsSchema,
    verifierResult.scopeViolations
  )

  if (!scopeResult.success) {
    throw new RubricValidationError('Verifier scope violations are invalid')
  }

  const rawViolations = verifierResult.scopeViolations as readonly unknown[]

  const expectedViolations = scopeResult.output.map((violation, index) => ({
    ...violation,
    evidence_digest: digest(rawViolations[index])
  }))

  if (JSON.stringify(score.scope_violations) !== JSON.stringify(expectedViolations)) {
    throw new RubricValidationError(
      'Score scope violations do not match verifier evidence'
    )
  }
}
