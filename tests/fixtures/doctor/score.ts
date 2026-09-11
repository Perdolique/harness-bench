import { createHash } from 'node:crypto'

export interface FixtureChecks {
  readonly contracts: boolean;
  readonly direct: boolean;
  readonly regression: boolean;
  readonly scope: boolean;
}

export interface FixtureIntegrity {
  readonly credentialsAbsent: boolean;
  readonly networkIsolated: boolean;
}

export function fixtureScore(runId: string, values: FixtureChecks, integrity: FixtureIntegrity) {
  const digest = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`

  const checks = {
    contracts: {
      credit: Number(values.contracts),
      detail: 'The candidate retains the required test.',
      facet: 'repository_contracts',
      passed: values.contracts
    },

    direct: {
      credit: Number(values.direct),
      detail: 'The requested result exists.',
      facet: 'direct_behavior',
      passed: values.direct
    },

    regression: {
      credit: Number(values.regression),
      detail: 'The pristine regression remains enabled.',
      facet: 'regression',
      passed: values.regression
    },

    scope: {
      credit: Number(values.scope),
      detail: 'The forbidden file is unchanged.',
      facet: 'scope_integrity',
      passed: values.scope
    }
  }

  const violations = values.scope ? [] : [{
    path: 'forbidden.txt',
    reason: 'Forbidden fixture file changed'
  }]

  const verifier = {
    checks,

    integrity: {
      ...integrity,
      passed: integrity.credentialsAbsent && integrity.networkIsolated
    },

    scopeViolations: violations
  }

  const verifierSource = `${JSON.stringify(verifier, null, 2)}\n`

  const evidence = (id: keyof FixtureChecks) => [{
    check_id: id,
    outcome: values[id] ? 'passed' : 'failed',
    evidence_digest: digest(JSON.stringify(checks[id]))
  }]

  const gate = values.direct && values.regression && verifier.integrity.passed
  const composite = gate ? 0.45 * Number(values.direct) + 0.35 * Number(values.contracts) + 0.2 * Number(values.scope) : 0

  const score = {
    document_type: 'score',
    schema_version: 1,
    score_id: `score-${runId}`,
    run_id: runId,
    verifier_result_digest: digest(verifierSource),
    scoring_revision: '1',
    rubric_revision: '1',
    valid_grade: true,

    gates: {
      direct_behavior_pass: values.direct,
      regression_pass: values.regression,
      verifier_integrity_pass: verifier.integrity.passed
    },

    facets: {
      direct_behavior: {
        status: 'value',
        value: Number(values.direct),
        evidence: evidence('direct')
      },

      repository_contracts: {
        status: 'value',
        value: Number(values.contracts),
        evidence: evidence('contracts')
      },

      regression: {
        status: 'value',
        value: Number(values.regression),
        evidence: evidence('regression')
      },

      scope_integrity: {
        status: 'value',
        value: Number(values.scope),
        evidence: evidence('scope')
      },

      maintainability: {
        status: 'not_applicable',
        reason: 'Not measured by the fixture.',
        evidence: []
      }
    },

    scope_violations: violations.map((item) => ({
      ...item,
      evidence_digest: digest(JSON.stringify(item))
    })),

    harbor_reward: {
      status: 'retained_upstream',
      numeric_values: { reward: composite }
    },

    composite: {
      status: 'value',
      value: composite
    }
  }

  return {
    verifierSource,
    score,
    reward: { reward: composite }
  }
}
