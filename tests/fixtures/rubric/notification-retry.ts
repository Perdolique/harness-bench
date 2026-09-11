import { createHash } from 'node:crypto'
import type { TaskDocument } from '../../../packages/schemas/src/index.ts'
import type { RubricDoctorControl } from '../../../packages/core/src/task-rubric.ts'

const sha256 = (value: unknown): string =>
  `sha256:${createHash('sha256').update(
    typeof value === 'string' ? value : JSON.stringify(value)
  ).digest('hex')}`

export const notificationRetryTask = {
  document_type: 'task',
  schema_version: 1,
  task_id: 'notification-retry',
  revision: 'notification-retry-task-v1',
  base_commit: '1'.repeat(40),
  source_digest: sha256('notification-retry-source'),

  environment: {
    id: 'notification-retry-environment',
    revision: '1',
    digest: sha256('environment')
  },

  collector: {
    revision: '1',
    image_digest: sha256('collector')
  },

  verifier: {
    revision: '1',
    image_digest: sha256('verifier'),

    network_enforcement_sidecar_digest: {
      status: 'not_applicable',
      reason: 'The sanitized test fixture has no verifier network'
    }
  },

  scoring: {
    revision: '1',
    rubric_revision: '1'
  },

  prompt: {
    path: 'instruction.md',
    digest: sha256('Retry a failed notification once.\n')
  },

  declared_artifacts: [
    {
    path: 'workspace.patch',
    required: true
  },
    {
    path: 'workspace-metadata.json',
    required: true
  }
  ],

  rubric: [
    {
      obligation_id: 'retry-once',
      facet: 'direct_behavior',
      expectation: 'A failed notification is retried exactly once',
      evidence_paths: ['src/notifications.ts'],
      justification: 'The pristine sender defines the requested behavior boundary',
      deterministic_check: 'tests/notifications.test.ts#retries one failed send',
      applicability: 'required',
      weight: 1
    },
    {
      obligation_id: 'established-logging',
      facet: 'repository_contracts',
      expectation: 'Retry failures use the established structured logger',
      evidence_paths: ['src/logger.ts', 'src/notifications.ts'],
      justification: 'The pristine sender already uses the project logger',
      deterministic_check: 'tests/notifications.test.ts#logs the final failure',
      applicability: 'required',
      weight: 1
    },
    {
      obligation_id: 'candidate-tests',
      facet: 'repository_contracts',
      expectation: 'Candidate tests prove the retry transition',
      evidence_paths: ['tests/notifications.test.ts'],
      justification: 'The existing test file is the supported extension point',
      deterministic_check: 'verifier#candidate tests fail pristine and pass candidate',
      applicability: 'optional',
      weight: 0.5
    },
    {
      obligation_id: 'existing-delivery',
      facet: 'regression',
      expectation: 'Successful notification delivery remains unchanged',
      evidence_paths: ['tests/notifications.test.ts'],
      justification: 'The pristine test records the supported success behavior',
      deterministic_check: 'tests/notifications.test.ts#delivers a notification',
      applicability: 'required',
      weight: 1
    },
    {
      obligation_id: 'scope-boundary',
      facet: 'scope_integrity',
      expectation: 'Changes stay in the sender, retry helper, and candidate tests',
      evidence_paths: ['src/notifications.ts', 'tests/notifications.test.ts'],
      justification: 'The pristine call graph identifies the narrow change boundary',
      deterministic_check: 'verifier#notification retry scope',
      applicability: 'required',
      weight: 1
    }
  ],

  scope: {
    allowed: ['src/notifications.ts'],
    conditional: ['src/retry.ts', 'tests/notifications.test.ts'],
    forbidden: ['package.json', 'pnpm-lock.yaml']
  },

  online_reachability: {
    status: 'ineligible',
    reason: 'This sanitized test fixture is checked into the public repository'
  },

  retention: {
    classification: 'public',

    expires_at: {
      status: 'not_applicable',
      reason: 'The fixture has no private source'
    }
  }
} satisfies TaskDocument

const allPassed = Object.fromEntries(
  notificationRetryTask.rubric.map(({ obligation_id }) => [obligation_id, true])
)

export const notificationRetryControls: readonly RubricDoctorControl[] = [
  {
    id: 'pristine',
    kind: 'pristine',

    expected_checks: {
      ...allPassed,
      'retry-once': false,
      'candidate-tests': false
    }
  },
  {
    id: 'direct-edit',
    kind: 'reference',
    expected_checks: allPassed
  },
  {
    id: 'conditional-helper',
    kind: 'alternate',
    expected_checks: allPassed
  },
  {
    id: 'candidate-tests-deleted',
    kind: 'test_deletion',
    expected_checks: { 'candidate-tests': false }
  },
  {
    id: 'regression-disabled',
    kind: 'test_disablement',
    expected_checks: { 'existing-delivery': false }
  },
  {
    id: 'dependency-churn',
    kind: 'forbidden_edit',
    expected_checks: { 'scope-boundary': false }
  }
]

export function notificationRetryEvidence(
  credits: Readonly<Record<string, number>> = {}
) {
  const checks = Object.fromEntries(notificationRetryTask.rubric.map((obligation) => {
    const credit = credits[obligation.obligation_id] ?? 1

    return [obligation.obligation_id, {
      facet: obligation.facet,
      passed: true,
      credit,
      detail: `${obligation.obligation_id} deterministic fixture check`
    }]
  }))

  const evidence = (checkId: string) => ({
    check_id: checkId,
    outcome: checks[checkId]!.passed ? 'passed' as const : 'failed' as const,
    evidence_digest: sha256(checks[checkId])
  })

  const facet = (name: TaskDocument['rubric'][number]['facet']) => {
    const obligations = notificationRetryTask.rubric.filter(
      ({ facet }) => facet === name
    )

    if (obligations.length === 0) {
      return {
        status: 'not_applicable' as const,
        reason: `The notification-retry rubric declares no ${name} obligations`,
        evidence: []
      }
    }

    const weight = obligations.reduce((total, obligation) => total + obligation.weight, 0)

    const value = obligations.reduce(
      (total, obligation) =>
        total + obligation.weight * checks[obligation.obligation_id]!.credit,
      0
    ) / weight

    return {
      status: 'value' as const,
      value,
      evidence: obligations.map(({ obligation_id }) => evidence(obligation_id))
    }
  }

  return {
    verifierResult: {
      checks,
      scopeViolations: []
    },

    score: {
      gates: {
        direct_behavior_pass: true,
        regression_pass: true
      },

      facets: {
        direct_behavior: facet('direct_behavior'),
        repository_contracts: facet('repository_contracts'),
        regression: facet('regression'),
        scope_integrity: facet('scope_integrity'),
        maintainability: facet('maintainability')
      },

      scope_violations: []
    }
  }
}
