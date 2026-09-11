import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import * as publicSchemas from '../src/index.ts'

import {
  CompletionRunRecordSchema,
  ExperimentDocumentSchema,
  HarnessDocumentSchema,
  InitialRunRecordSchema,
  RunDocumentSchema,
  ScoreDocumentSchema,
  StackDocumentSchema,
  SuiteDocumentSchema,
  TaskDocumentSchema,
  validateDocumentRelationships,
  type CompletionRunRecord
} from '../src/index.ts'

const examplesRoot = resolve(import.meta.dirname, '../examples')

function readExample(directory: 'valid' | 'invalid', name: string): unknown {
  const source = readFileSync(
    resolve(examplesRoot, directory, `${name}.json`),
    'utf8'
  )

  return JSON.parse(source) as unknown
}

function pathsFor(
  result: v.SafeParseResult<v.GenericSchema>
): (string | null)[] {
  return result.issues?.map((issue) => v.getDotPath(issue)) ?? []
}

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const patternedDigest = (pattern: string): string =>
  `sha256:${pattern.repeat(64 / pattern.length)}`

function passedEvidence(character: string) {
  return {
    status: 'passed' as const,

    evidence_digest: {
      status: 'known' as const,
      value: digest(character)
    }
  }
}

function completionRecord(
  classification: CompletionRunRecord['classification'] = 'task_success',
  validGrade = classification === 'task_success' ||
    classification === 'task_failure'
): CompletionRunRecord {
  return v.parse(CompletionRunRecordSchema, {
    document_type: 'run',
    schema_version: 1,
    record_type: 'completion',

    identity: {
      run_id: 'run-v1-r1',
      attempt_id: 'attempt-1',
      attempt: 1
    },

    completed_at: '2026-09-05T10:00:00Z',
    initial_manifest_digest: digest('2'),
    classification,

    termination:
      classification === 'cancellation'
        ? {
      kind: 'cancelled',
      reason: 'Owner cancelled the run'
    }
        : classification === 'task_success' || classification === 'task_failure'
          ? { kind: 'success' }
          : {
      kind: 'error',
      reason: `${classification} fixture`
    },

    collection: {
      collector_revision: '1',
      collector_image_digest: digest('6'),
      quiescence: passedEvidence('a'),
      collection: passedEvidence('b'),
      exact_manifest: passedEvidence('c'),
      hashes: passedEvidence('d')
    },

    verifier: {
      verifier_revision: '1',
      verifier_image_digest: digest('7'),

      network_enforcement_sidecar_digest: {
        status: 'known',
        value: digest('8')
      },

      separate_environment: passedEvidence('e'),
      network_disabled: passedEvidence('f'),
      credential_free: passedEvidence('1'),

      result_digest: {
        status: 'known',
        value: patternedDigest('17')
      }
    },

    valid_grade: validGrade,

    score_id: validGrade
      ? {
      status: 'known',
      value: 'score-v1-r1'
    }
      : {
      status: 'not_applicable',
      reason: 'No valid quality grade'
    },

    timings: {
      total_seconds: 60,

      agent_seconds: {
        status: 'known',
        value: 40
      },

      verifier_seconds: {
        status: 'known',
        value: 10
      }
    },

    usage: {
      input_tokens: {
        status: 'unknown',
        reason: 'Not exposed'
      },

      output_tokens: {
        status: 'unknown',
        reason: 'Not exposed'
      },

      subscription_money: {
        status: 'not_applicable',
        reason: 'Subscription usage is not API spend'
      },

      upstream_api_price_estimate: {
        status: 'unknown',
        reason: 'No upstream estimate retained'
      }
    },

    retention: {
      classification: 'public',

      expires_at: {
        status: 'not_applicable',
        reason: 'The sanitized fixture contains no private source'
      }
    },

    raw_artifact_path: '/restricted/run-v1-r1',
    raw_artifact_manifest_digest: digest('3')
  })
}

function linkedDocuments() {
  const v1Harness = v.parse(
    HarnessDocumentSchema,
    readExample('valid', 'harness')
  )

  const v1Stack = v.parse(StackDocumentSchema, readExample('valid', 'stack'))

  const disabledHarness = v.parse(HarnessDocumentSchema, {
    ...v1Harness,
    harness_id: 'harness-disabled',
    digest: patternedDigest('14')
  })

  const v2Harness = v.parse(HarnessDocumentSchema, {
    ...v1Harness,
    harness_id: 'harness-v2',
    digest: patternedDigest('16')
  })

  const disabledStack = v.parse(StackDocumentSchema, {
    ...v1Stack,
    stack_id: 'codex-low-disabled',
    digest: patternedDigest('13'),

    harness: {
      id: disabledHarness.harness_id,
      revision: disabledHarness.revision,
      digest: disabledHarness.digest
    }
  })

  const v2Stack = v.parse(StackDocumentSchema, {
    ...v1Stack,
    stack_id: 'codex-low-v2',
    digest: patternedDigest('15'),

    harness: {
      id: v2Harness.harness_id,
      revision: v2Harness.revision,
      digest: v2Harness.digest
    }
  })

  return {
    stacks: [disabledStack, v1Stack, v2Stack],
    harnesses: [disabledHarness, v1Harness, v2Harness],
    suite: v.parse(SuiteDocumentSchema, readExample('valid', 'suite')),
    tasks: [v.parse(TaskDocumentSchema, readExample('valid', 'task'))],

    experiment: v.parse(
      ExperimentDocumentSchema,
      readExample('valid', 'experiment')
    ),

    initial_run: v.parse(InitialRunRecordSchema, readExample('valid', 'run')),
    initial_run_digest: digest('2'),
    completion_run: completionRecord(),
    score: v.parse(ScoreDocumentSchema, readExample('valid', 'score'))
  }
}

describe('versioned document schemas', () => {
  const cases = [
    ['stack', StackDocumentSchema],
    ['harness', HarnessDocumentSchema],
    ['task', TaskDocumentSchema],
    ['suite', SuiteDocumentSchema],
    ['experiment', ExperimentDocumentSchema],
    ['run', RunDocumentSchema],
    ['score', ScoreDocumentSchema]
  ] as const

  it.each(cases)(
    'accepts the sanitized %s example without mutating it',
    (name, schema) => {
      const input = readExample('valid', name)
      const before = JSON.stringify(input)
      const result = v.safeParse(schema, input)

      expect(result.issues).toBeUndefined()
      expect(JSON.stringify(input)).toBe(before)
    }
  )

  it('rejects unknown schema versions and extra fields', () => {
    const suite = v.parse(SuiteDocumentSchema, readExample('valid', 'suite'))

    const wrongVersion = {
      ...suite,
      schema_version: 2
    }

    const extraField = {
      ...suite,
      invented_zero: 0
    }

    expect(pathsFor(v.safeParse(SuiteDocumentSchema, wrongVersion))).toContain(
      'schema_version'
    )

    expect(pathsFor(v.safeParse(SuiteDocumentSchema, extraField))).toContain(
      'invented_zero'
    )
  })

  it('rejects malformed digests with an actionable field path', () => {
    const harness = v.parse(
      HarnessDocumentSchema,
      readExample('valid', 'harness')
    )

    const invalid = {
      ...harness,
      digest: 'abc123'
    }

    const result = v.safeParse(HarnessDocumentSchema, invalid)

    expect(pathsFor(result)).toContain('digest')
    expect(result.issues?.[0]?.message).toContain('sha256')
  })

  it('rejects a malformed completion collector image digest', () => {
    const completion = completionRecord()

    const invalid = {
      ...completion,

      collection: {
        ...completion.collection,
        collector_image_digest: 'collector-latest'
      }
    }

    expect(pathsFor(v.safeParse(CompletionRunRecordSchema, invalid))).toContain(
      'collection.collector_image_digest'
    )
  })

  it.each([0, 2])('rejects subscription concurrency %s', (requested) => {
    const stack = v.parse(StackDocumentSchema, readExample('valid', 'stack'))

    const invalid = {
      ...stack,

      runner: {
        ...stack.runner,

        concurrency: {
          ...stack.runner.concurrency,
          requested
        }
      }
    }

    expect(pathsFor(v.safeParse(StackDocumentSchema, invalid))).toContain(
      'runner.concurrency.requested'
    )
  })

  it('requires explicit owner opt-in when telemetry is effective', () => {
    const stack = v.parse(StackDocumentSchema, readExample('valid', 'stack'))

    const invalid = {
      ...stack,

      runner: {
        ...stack.runner,

        telemetry: {
          requested: 'on' as const,
          effective: 'on' as const,
          owner_opt_in: false
        }
      }
    }

    const result = v.safeParse(StackDocumentSchema, invalid)

    expect(pathsFor(result)).toContain('runner.telemetry.owner_opt_in')
  })

  it('preserves unknown provider identity without inventing a value', () => {
    const stack = v.parse(StackDocumentSchema, readExample('valid', 'stack'))

    expect(stack.agent.observed_provider_identity).toEqual({
      status: 'unknown',
      reason: 'Provider does not expose a stable backend identity'
    })
  })

  it('rejects an incompatible API authentication mode', () => {
    const stack = v.parse(StackDocumentSchema, readExample('valid', 'stack'))

    const invalid = {
      ...stack,

      agent: {
        ...stack.agent,

        auth: {
          ...stack.agent.auth,
          mode: 'api'
        }
      }
    }

    expect(pathsFor(v.safeParse(StackDocumentSchema, invalid))).toContain(
      'agent.auth.mode'
    )
  })

  it('allows an explicit not-applicable verifier network sidecar', () => {
    const task = v.parse(TaskDocumentSchema, readExample('valid', 'task'))

    const withoutSidecar = {
      ...task,

      verifier: {
        ...task.verifier,

        network_enforcement_sidecar_digest: {
          status: 'not_applicable' as const,
          reason: 'No sidecar participates in this verifier network boundary'
        }
      }
    }

    expect(v.parse(TaskDocumentSchema, withoutSidecar).verifier).toEqual(
      withoutSidecar.verifier
    )
  })

  it('rejects duplicate suite task identities', () => {
    const suite = v.parse(SuiteDocumentSchema, readExample('valid', 'suite'))

    const invalid = {
      ...suite,
      tasks: [suite.tasks[0], suite.tasks[0]]
    }

    expect(pathsFor(v.safeParse(SuiteDocumentSchema, invalid))).toContain(
      'tasks'
    )
  })

  const versionCases = cases.map(
    ([name, schema]) =>
      [name, name === 'run' ? InitialRunRecordSchema : schema] as const
  )

  it.each(versionCases)(
    'rejects schema version drift for %s',
    (name, schema) => {
      const document = readExample('valid', name) as Record<string, unknown>

      const invalid = {
        ...document,
        schema_version: 2
      }

      expect(pathsFor(v.safeParse(schema, invalid))).toContain(
        'schema_version'
      )
    }
  )

  it('rejects unknown fields inside the verifier identity', () => {
    const task = v.parse(TaskDocumentSchema, readExample('valid', 'task'))

    const invalid = {
      ...task,

      verifier: {
        ...task.verifier,
        ambient_credential_store: 'keychain'
      }
    }

    expect(pathsFor(v.safeParse(TaskDocumentSchema, invalid))).toContain(
      'verifier.ambient_credential_store'
    )
  })

  it('requires a unit for a known token or turn budget', () => {
    const stack = v.parse(StackDocumentSchema, readExample('valid', 'stack'))

    const withoutUnit = {
      ...stack,

      budget: {
        ...stack.budget,

        token_or_turn_limit: {
          status: 'known' as const,
          value: 100
        }
      }
    }

    const withUnit = {
      ...withoutUnit,

      budget: {
        ...withoutUnit.budget,

        token_or_turn_limit: {
          status: 'known' as const,
          unit: 'turns' as const,
          value: 100
        }
      }
    }

    expect(pathsFor(v.safeParse(StackDocumentSchema, withoutUnit))).toContain(
      'budget.token_or_turn_limit'
    )

    expect(v.safeParse(StackDocumentSchema, withUnit).issues).toBeUndefined()
  })

  it.each(['cpu_enforcement_status', 'memory_enforcement_status'] as const)(
    'requires explicit budget %s',
    (field) => {
      const stack = v.parse(StackDocumentSchema, readExample('valid', 'stack'))
      const budget = { ...stack.budget } as Record<string, unknown>

      delete budget[field]

      expect(
        pathsFor(v.safeParse(StackDocumentSchema, {
          ...stack,
          budget
        }))
      ).toContain(`budget.${field}`)
    }
  )

  it('rejects impossible calendar timestamps', () => {
    const run = v.parse(InitialRunRecordSchema, readExample('valid', 'run'))

    const invalid = {
      ...run,
      created_at: '2026-02-30T10:00:00Z'
    }

    expect(pathsFor(v.safeParse(InitialRunRecordSchema, invalid))).toContain(
      'created_at'
    )
  })

  it('rejects an unsupported credential store', () => {
    const stack = v.parse(StackDocumentSchema, readExample('valid', 'stack'))

    const invalid = {
      ...stack,

      agent: {
        ...stack.agent,

        auth: {
          ...stack.agent.auth,
          credential_store: 'keychain'
        }
      }
    }

    expect(pathsFor(v.safeParse(StackDocumentSchema, invalid))).toContain(
      'agent.auth.credential_store'
    )
  })

  it('rejects an unsupported requested telemetry value', () => {
    const stack = v.parse(StackDocumentSchema, readExample('valid', 'stack'))

    const invalid = {
      ...stack,

      runner: {
        ...stack.runner,

        telemetry: {
          ...stack.runner.telemetry,
          requested: 'ambient'
        }
      }
    }

    expect(pathsFor(v.safeParse(StackDocumentSchema, invalid))).toContain(
      'runner.telemetry.requested'
    )
  })

  it('rejects experiment concurrency other than one', () => {
    const experiment = v.parse(
      ExperimentDocumentSchema,
      readExample('valid', 'experiment')
    )

    expect(
      pathsFor(
        v.safeParse(ExperimentDocumentSchema, {
          ...experiment,
          requested_concurrency: 2
        })
      )
    ).toContain('requested_concurrency')
  })

  it('rejects an unsupported run effort', () => {
    const run = v.parse(InitialRunRecordSchema, readExample('valid', 'run'))

    const invalid = {
      ...run,

      agent: {
        ...run.agent,
        effort: 'banana'
      }
    }

    expect(pathsFor(v.safeParse(InitialRunRecordSchema, invalid))).toContain(
      'agent.effort'
    )
  })

  it('requires justified direct-behavior and regression obligations', () => {
    const task = v.parse(TaskDocumentSchema, readExample('valid', 'task'))

    const withoutRegression = {
      ...task,
      rubric: task.rubric.filter(({ facet }) => facet !== 'regression')
    }

    const withoutJustification = {
      ...task,

      rubric: task.rubric.map((obligation, index) => {
        if (index !== 0) {
          return obligation
        }

        const result = { ...obligation } as Record<string, unknown>

        delete result.justification

        return result
      })
    }

    expect(
      pathsFor(v.safeParse(TaskDocumentSchema, withoutRegression))
    ).toContain('rubric')

    expect(
      pathsFor(v.safeParse(TaskDocumentSchema, withoutJustification))
    ).toContain('rubric.0.justification')
  })

  it('rejects zero rubric weights and duplicate evidence paths', () => {
    const task = v.parse(TaskDocumentSchema, readExample('valid', 'task'))
    const first = task.rubric[0]!

    const zeroWeight = {
      ...task,

      rubric: [{
        ...first,
        weight: 0
      }, ...task.rubric.slice(1)]
    }

    const duplicateEvidence = {
      ...task,

      rubric: [{
        ...first,
        evidence_paths: [first.evidence_paths[0]!, first.evidence_paths[0]!]
      }, ...task.rubric.slice(1)]
    }

    expect(pathsFor(v.safeParse(TaskDocumentSchema, zeroWeight))).toContain(
      'rubric.0.weight'
    )

    expect(
      pathsFor(v.safeParse(TaskDocumentSchema, duplicateEvidence))
    ).toContain('rubric.0.evidence_paths')
  })

  it.each([
    'retry_once',
    '1-retry',
    'retry.once',
    'a'.repeat(65)
  ])('rejects rubric obligation ID %s outside the verifier key contract', (id) => {
    const task = v.parse(TaskDocumentSchema, readExample('valid', 'task'))

    const invalid = {
      ...task,

      rubric: task.rubric.map((obligation, index) => index === 0
        ? {
            ...obligation,
            obligation_id: id
          }
        : obligation)
    }

    expect(pathsFor(v.safeParse(TaskDocumentSchema, invalid))).toContain(
      'rubric.0.obligation_id'
    )
  })

  it('uses the rubric obligation ID contract for score evidence', () => {
    const score = v.parse(ScoreDocumentSchema, readExample('valid', 'score'))
    const direct = score.facets.direct_behavior

    if (direct.status !== 'value') {
      throw new Error('The valid score fixture must have direct behavior evidence')
    }

    direct.evidence[0]!.check_id = 'direct_check'

    expect(pathsFor(v.safeParse(ScoreDocumentSchema, score))).toContain(
      'facets.direct_behavior.evidence.0.check_id'
    )
  })

  it('rejects overlapping scope zones', () => {
    const task = v.parse(TaskDocumentSchema, readExample('valid', 'task'))

    const invalid = {
      ...task,

      scope: {
        ...task.scope,
        forbidden: [...task.scope.forbidden, task.scope.allowed[0]!]
      }
    }

    expect(pathsFor(v.safeParse(TaskDocumentSchema, invalid))).toContain(
      'scope'
    )
  })

  it.each([
    '/tests/result.json',
    '../workspace.patch',
    'logs/artifacts/result.json',
    'credentials/auth.json',
    'verifier/result.json',
    'trusted-tools/collector.json'
  ])('rejects unsafe declared artifact path %s', (path) => {
    const task = v.parse(TaskDocumentSchema, readExample('valid', 'task'))

    const invalid = {
      ...task,

      declared_artifacts: [{
        path,
        required: true
      }]
    }

    expect(pathsFor(v.safeParse(TaskDocumentSchema, invalid))).toContain(
      'declared_artifacts'
    )
  })

  it('requires an explicit verifier sidecar identity or not-applicable value', () => {
    const task = v.parse(TaskDocumentSchema, readExample('valid', 'task'))
    const verifier = { ...task.verifier } as Record<string, unknown>

    delete verifier.network_enforcement_sidecar_digest

    expect(
      pathsFor(v.safeParse(TaskDocumentSchema, {
        ...task,
        verifier
      }))
    ).toContain('verifier.network_enforcement_sidecar_digest')
  })

  it.each([
    ['initial', InitialRunRecordSchema, readExample('valid', 'run')],
    ['completion', CompletionRunRecordSchema, completionRecord()]
  ] as const)(
    'requires sidecar identity on the %s run record',
    (_name, schema, input) => {
      const record = v.parse(schema, input)
      const verifier = { ...record.verifier } as Record<string, unknown>

      delete verifier.network_enforcement_sidecar_digest

      expect(pathsFor(v.safeParse(schema, {
        ...record,
        verifier
      }))).toContain(
        'verifier.network_enforcement_sidecar_digest'
      )
    }
  )

  it('rejects an impossible private retention deadline', () => {
    const task = v.parse(TaskDocumentSchema, readExample('valid', 'task'))

    const invalid = {
      ...task,

      retention: {
        classification: 'private' as const,
        default_days: 90 as const,
        expires_at: '2026-02-30T10:00:00Z'
      }
    }

    expect(pathsFor(v.safeParse(TaskDocumentSchema, invalid))).toContain(
      'retention.expires_at'
    )
  })

  it('keeps score evidence linked to task rubric obligations', () => {
    const task = v.parse(TaskDocumentSchema, readExample('valid', 'task'))
    const score = v.parse(ScoreDocumentSchema, readExample('valid', 'score'))

    const obligationIds = task.rubric
      .map(({ obligation_id }) => obligation_id)
      .sort()

    const checkIds = Object.values(score.facets)
      .flatMap(({ evidence }) => evidence.map(({ check_id }) => check_id))
      .sort()

    expect(checkIds).toEqual(obligationIds)
  })

  it('exports only authoritative document schemas', () => {
    expect(
      Object.keys(publicSchemas).some((name) =>
        name.includes('StructureSchema')
      )
    ).toBe(false)
  })
})

describe('run completion integrity', () => {
  it.each([
    'task_success',
    'task_failure',
    'agent_failure',
    'provider_failure',
    'runner_failure',
    'verifier_failure',
    'infrastructure_failure',
    'cancellation'
  ] as const)('represents the %s terminal classification', (classification) => {
    expect(completionRecord(classification).classification).toBe(
      classification
    )
  })

  it('retains timeout stage, limit, elapsed time, and observed cause', () => {
    const completion = completionRecord('runner_failure', false)

    const timeout = {
      ...completion,

      termination: {
        kind: 'timeout' as const,
        stage: 'collection' as const,
        limit_seconds: 60,
        elapsed_seconds: 61,
        observed_cause: 'Collector did not quiesce'
      }
    }

    expect(v.parse(CompletionRunRecordSchema, timeout).termination).toEqual(
      timeout.termination
    )
  })

  it.each([
    [{
      status: 'known' as const,
      value: 1 as const
    }, 'failed' as const],
    [
      {
        status: 'unknown' as const,
        reason: 'Not observed'
      },
      'enforced' as const
    ]
  ])(
    'rejects contradictory initial-run concurrency evidence %#',
    (effectiveConcurrency, enforcementStatus) => {
      const run = v.parse(InitialRunRecordSchema, readExample('valid', 'run'))

      const invalid = {
        ...run,

        runner: {
          ...run.runner,
          effective_concurrency: effectiveConcurrency,
          concurrency_enforcement_status: enforcementStatus
        }
      }

      expect(pathsFor(v.safeParse(InitialRunRecordSchema, invalid))).toContain(
        'runner.concurrency_enforcement_status'
      )
    }
  )

  it.each([
    'separate_environment',
    'network_disabled',
    'credential_free'
  ] as const)('rejects a valid grade when verifier %s fails', (field) => {
    const completion = completionRecord()

    const invalid = {
      ...completion,

      verifier: {
        ...completion.verifier,

        [field]: {
          status: 'failed' as const,

          evidence_digest: {
            status: 'unknown' as const,
            reason: 'Failed'
          }
        }
      }
    }

    expect(pathsFor(v.safeParse(CompletionRunRecordSchema, invalid))).toContain(
      'valid_grade'
    )
  })

  it('rejects a valid grade without a verifier result digest', () => {
    const completion = completionRecord()

    const invalid = {
      ...completion,

      verifier: {
        ...completion.verifier,

        result_digest: {
          status: 'unknown' as const,
          reason: 'Missing'
        }
      }
    }

    expect(pathsFor(v.safeParse(CompletionRunRecordSchema, invalid))).toContain(
      'valid_grade'
    )
  })

  it('rejects timeout stages outside the frozen taxonomy', () => {
    const completion = completionRecord('runner_failure', false)

    const invalid = {
      ...completion,

      termination: {
        kind: 'timeout' as const,
        stage: 'upload',
        limit_seconds: 60,
        elapsed_seconds: 60,
        observed_cause: 'Unexpected stage'
      }
    }

    expect(pathsFor(v.safeParse(CompletionRunRecordSchema, invalid))).toContain(
      'termination'
    )
  })

  it('rejects a timeout observed before its configured limit', () => {
    const completion = completionRecord('runner_failure', false)

    const invalid = {
      ...completion,

      termination: {
        kind: 'timeout' as const,
        stage: 'collection' as const,
        limit_seconds: 60,
        elapsed_seconds: 59,
        observed_cause: 'Collector still running'
      }
    }

    expect(pathsFor(v.safeParse(CompletionRunRecordSchema, invalid))).toContain(
      'termination'
    )
  })

  it.each([
    'agent_failure',
    'provider_failure',
    'runner_failure',
    'verifier_failure',
    'infrastructure_failure'
  ] as const)('rejects success termination for %s', (classification) => {
    const completion = completionRecord(classification, false)

    const invalid = {
      ...completion,
      termination: { kind: 'success' as const }
    }

    expect(pathsFor(v.safeParse(CompletionRunRecordSchema, invalid))).toContain(
      'termination'
    )
  })

  it('represents ungraded agent budget exhaustion', () => {
    const completion = completionRecord('agent_failure', false)

    const exhausted = {
      ...completion,

      termination: {
        kind: 'budget_exhausted' as const,
        reason: 'Agent reached the declared turn limit before collection'
      }
    }

    expect(v.parse(CompletionRunRecordSchema, exhausted).valid_grade).toBe(
      false
    )
  })

  it.each([InitialRunRecordSchema, CompletionRunRecordSchema])(
    'requires retention on every run record %#',
    (schema) => {
      const record =
        schema === InitialRunRecordSchema
          ? v.parse(InitialRunRecordSchema, readExample('valid', 'run'))
          : completionRecord()

      const withoutRetention = { ...record } as Record<string, unknown>

      delete withoutRetention.retention

      expect(pathsFor(v.safeParse(schema, withoutRetention))).toContain(
        'retention'
      )
    }
  )

  it('rejects a valid grade for a provider failure', () => {
    const completion = completionRecord()

    const invalid = {
      ...completion,
      classification: 'provider_failure' as const
    }

    const result = v.safeParse(CompletionRunRecordSchema, invalid)

    expect(pathsFor(result)).toContain('valid_grade')

    expect(
      result.issues?.some(({ message }) => message.includes('valid grade'))
    ).toBe(true)
  })

  it('rejects a task outcome without a valid grade', () => {
    const completion = completionRecord()

    const invalid = {
      ...completion,
      valid_grade: false,

      score_id: {
        status: 'not_applicable' as const,
        reason: 'Fixture removes the grade'
      }
    }

    expect(pathsFor(v.safeParse(CompletionRunRecordSchema, invalid))).toContain(
      'valid_grade'
    )
  })

  it.each(['quiescence', 'collection', 'exact_manifest', 'hashes'] as const)(
    'rejects a valid grade when %s evidence is missing',
    (field) => {
      const completion = completionRecord()

      const invalid = {
        ...completion,

        collection: {
          ...completion.collection,

          [field]: {
            status: 'missing' as const,

            evidence_digest: {
              status: 'unknown' as const,
              reason: 'Missing'
            }
          }
        }
      }

      expect(
        pathsFor(v.safeParse(CompletionRunRecordSchema, invalid))
      ).toContain('valid_grade')
    }
  )

  it('allows budget exhaustion to carry a task grade with complete evidence', () => {
    const completion = completionRecord('task_failure', true)

    const graded = {
      ...completion,

      termination: {
        kind: 'budget_exhausted' as const,
        reason: 'Wall-clock limit reached after collectable work'
      }
    }

    expect(v.parse(CompletionRunRecordSchema, graded).valid_grade).toBe(true)
  })

  it('accepts observed zero token usage without treating it as missing', () => {
    const completion = completionRecord()

    const zeroUsage = {
      ...completion,

      usage: {
        ...completion.usage,

        input_tokens: {
          status: 'known' as const,
          value: 0
        },

        output_tokens: {
          status: 'known' as const,
          value: 0
        }
      }
    }

    expect(v.parse(CompletionRunRecordSchema, zeroUsage).usage).toEqual(
      zeroUsage.usage
    )
  })

  it('rejects a cancellation without a cancelled termination', () => {
    const completion = completionRecord('cancellation', false)

    const invalid = {
      ...completion,

      termination: {
        kind: 'error' as const,
        reason: 'Wrong terminal kind'
      }
    }

    expect(pathsFor(v.safeParse(CompletionRunRecordSchema, invalid))).toContain(
      'termination'
    )
  })
})

describe('score applicability', () => {
  it('preserves not-applicable and unknown facets without numeric zeroes', () => {
    const score = v.parse(ScoreDocumentSchema, readExample('valid', 'score'))

    const unresolved = {
      ...score,
      valid_grade: false,

      gates: {
        ...score.gates,
        verifier_integrity_pass: false
      },

      facets: {
        ...score.facets,

        repository_contracts: {
          status: 'not_applicable' as const,
          reason: 'No evidence-backed repository obligation',
          evidence: []
        },

        scope_integrity: {
          status: 'unknown' as const,
          reason: 'Verifier evidence unavailable',
          evidence: []
        }
      },

      composite: {
        status: 'not_applicable' as const,
        reason: 'Required facets are not numeric'
      }
    }

    const parsed = v.parse(ScoreDocumentSchema, unresolved)

    expect(parsed.facets.repository_contracts.status).toBe('not_applicable')
    expect(parsed.facets.scope_integrity.status).toBe('unknown')
    expect(parsed.composite.status).toBe('not_applicable')
  })

  it('rejects a composite when an obligatory facet is not numeric', () => {
    const score = v.parse(ScoreDocumentSchema, readExample('valid', 'score'))

    const invalid = {
      ...score,

      facets: {
        ...score.facets,

        repository_contracts: {
          status: 'not_applicable' as const,
          reason: 'No evidenced contracts',
          evidence: []
        }
      }
    }

    expect(pathsFor(v.safeParse(ScoreDocumentSchema, invalid))).toContain(
      'composite'
    )
  })

  it('rejects a composite that differs from the frozen formula', () => {
    const score = v.parse(ScoreDocumentSchema, readExample('valid', 'score'))

    const invalid = {
      ...score,

      composite: {
        status: 'value' as const,
        value: 0.5
      }
    }

    const result = v.safeParse(ScoreDocumentSchema, invalid)

    expect(pathsFor(result)).toContain('composite')

    expect(
      result.issues?.some(({ message }) =>
        message.includes('frozen v1 scoring formula')
      )
    ).toBe(true)
  })

  it('freezes every mandatory facet and asymmetric v1 weight', () => {
    const score = v.parse(ScoreDocumentSchema, readExample('valid', 'score'))

    const asymmetric = {
      ...score,

      facets: {
        ...score.facets,

        direct_behavior: {
          ...score.facets.direct_behavior,
          status: 'value' as const,
          value: 0.2
        },

        repository_contracts: {
          ...score.facets.repository_contracts,
          status: 'value' as const,
          value: 0.6
        },

        regression: {
          ...score.facets.regression,
          status: 'value' as const,
          value: 0.7
        },

        scope_integrity: {
          ...score.facets.scope_integrity,
          status: 'value' as const,
          value: 0.9
        }
      },

      composite: {
        status: 'value' as const,
        value: 0.48
      }
    }

    const withoutRegression = {
      ...asymmetric,

      facets: {
        ...asymmetric.facets,

        regression: {
          status: 'not_applicable' as const,
          reason: 'Mutation removes the mandatory facet',
          evidence: []
        }
      }
    }

    expect(v.safeParse(ScoreDocumentSchema, asymmetric).issues).toBeUndefined()

    expect(
      pathsFor(v.safeParse(ScoreDocumentSchema, withoutRegression))
    ).toContain('composite')

    expect(
      pathsFor(
        v.safeParse(ScoreDocumentSchema, {
          ...asymmetric,

          composite: {
            status: 'value',
            value: 0.5
          }
        })
      )
    ).toContain('composite')
  })

  it('requires an empty numeric map when Harbor reward is unavailable', () => {
    const score = v.parse(ScoreDocumentSchema, readExample('valid', 'score'))

    const invalid = {
      ...score,

      harbor_reward: {
        status: 'not_available' as const,
        numeric_values: { direct_behavior: 1 }
      }
    }

    expect(pathsFor(v.safeParse(ScoreDocumentSchema, invalid))).toContain(
      'harbor_reward'
    )
  })
})

describe('experiment blocks', () => {
  it('accepts the exact 24-hour deadline boundary', () => {
    const experiment = v.parse(
      ExperimentDocumentSchema,
      readExample('valid', 'experiment')
    )

    expect(experiment.blocks[0]?.contemporaneity.status).toBe('eligible')
  })

  it('rejects an eligible block completed one second after the deadline', () => {
    const experiment = v.parse(
      ExperimentDocumentSchema,
      readExample('valid', 'experiment')
    )

    const block = experiment.blocks[0]

    expect(block).toBeDefined()

    const invalidBlock = {
      ...block!,

      completed_at: {
        status: 'known' as const,
        value: '2026-09-06T08:00:01Z'
      }
    }

    const invalid = {
      ...experiment,
      blocks: [invalidBlock]
    }

    expect(pathsFor(v.safeParse(ExperimentDocumentSchema, invalid))).toContain(
      'blocks'
    )
  })

  it('requires execution order to cover the full block and arm matrix', () => {
    const experiment = v.parse(
      ExperimentDocumentSchema,
      readExample('valid', 'experiment')
    )

    const invalid = {
      ...experiment,
      execution_order: experiment.execution_order.slice(0, -1)
    }

    expect(pathsFor(v.safeParse(ExperimentDocumentSchema, invalid))).toContain(
      'execution_order'
    )
  })

  it.each([
    'incomplete',
    'deadline_exceeded',
    'model_changed',
    'cli_changed',
    'provider_changed',
    'runner_changed',
    'harbor_config_changed',
    'harness_changed'
  ] as const)('retains %s as an ineligible block cause', (cause) => {
    const experiment = v.parse(
      ExperimentDocumentSchema,
      readExample('valid', 'experiment')
    )

    const block = experiment.blocks[0]

    expect(block).toBeDefined()

    const invalidated = {
      ...block!,

      completed_at:
        cause === 'deadline_exceeded'
          ? {
              status: 'known' as const,
              value: '2026-09-06T08:00:01Z'
            }
          : block!.completed_at,

      completion_status: 'invalidated' as const,

      contemporaneity: {
        status: 'ineligible' as const,
        cause,
        reason: `${cause} fixture`
      }
    }

    expect(
      v.safeParse(ExperimentDocumentSchema, {
        ...experiment,
        blocks: [invalidated, ...experiment.blocks.slice(1)]
      }).issues
    ).toBeUndefined()
  })

  it.each(['2026-09-06T07:00:00Z', '2026-09-06T09:00:00Z'])(
    'rejects a block deadline that is not exactly 24 hours: %s',
    (value) => {
      const experiment = v.parse(
        ExperimentDocumentSchema,
        readExample('valid', 'experiment')
      )

      const firstBlock = experiment.blocks[0]!

      const invalid = {
        ...experiment,

        blocks: [
          {
            ...firstBlock,

            deadline_at: {
              status: 'known' as const,
              value
            }
          },
          ...experiment.blocks.slice(1)
        ]
      }

      expect(
        pathsFor(v.safeParse(ExperimentDocumentSchema, invalid))
      ).toContain('blocks')
    }
  )

  it('rejects an equal-length execution order with a duplicate block-arm pair', () => {
    const experiment = v.parse(
      ExperimentDocumentSchema,
      readExample('valid', 'experiment')
    )

    const duplicate = {
      ...experiment.execution_order[1]!,
      sequence: experiment.execution_order[2]!.sequence
    }

    const invalid = {
      ...experiment,

      execution_order: [
        ...experiment.execution_order.slice(0, 2),
        duplicate,
        ...experiment.execution_order.slice(3)
      ]
    }

    expect(pathsFor(v.safeParse(ExperimentDocumentSchema, invalid))).toContain(
      'execution_order'
    )
  })

  it('rejects duplicate arms in a completed block', () => {
    const experiment = v.parse(
      ExperimentDocumentSchema,
      readExample('valid', 'experiment')
    )

    const firstBlock = experiment.blocks[0]!

    const invalidRuns = firstBlock.runs.map((run) =>
      run.arm_id === 'v2' ? {
        ...run,
        arm_id: 'v1'
      } : run
    )

    const invalid = {
      ...experiment,

      blocks: [
        {
        ...firstBlock,
        runs: invalidRuns
      },
        ...experiment.blocks.slice(1)
      ]
    }

    expect(pathsFor(v.safeParse(ExperimentDocumentSchema, invalid))).toContain(
      'blocks'
    )
  })

  it('rejects one run ID assigned to multiple blocks', () => {
    const experiment = v.parse(
      ExperimentDocumentSchema,
      readExample('valid', 'experiment')
    )

    const secondBlock = experiment.blocks[1]!

    const startedSecondBlock = {
      ...secondBlock,

      runs: [
        {
          run_id: experiment.blocks[0]!.runs[0]!.run_id,
          arm_id: 'disabled',
          attempt: 1,
          selected: false
        }
      ],

      first_started_at: {
        status: 'known' as const,
        value: '2026-09-05T13:00:00Z'
      },

      deadline_at: {
        status: 'known' as const,
        value: '2026-09-06T13:00:00Z'
      },

      completion_status: 'in_progress' as const
    }

    const invalid = {
      ...experiment,

      blocks: [
        experiment.blocks[0]!,
        startedSecondBlock,
        experiment.blocks[2]!
      ]
    }

    expect(pathsFor(v.safeParse(ExperimentDocumentSchema, invalid))).toContain(
      'blocks'
    )
  })

  it('records retries and one selected run per arm', () => {
    const experiment = v.parse(
      ExperimentDocumentSchema,
      readExample('valid', 'experiment')
    )

    const firstBlock = experiment.blocks[0]!

    const retriedRuns = [
      ...firstBlock.runs.map((run) =>
        run.arm_id === 'v1' ? {
          ...run,
          selected: false
        } : run
      ),
      {
        run_id: 'run-v1-r1-retry',
        arm_id: 'v1',
        attempt: 2,
        selected: true
      }
    ]

    const retried = {
      ...experiment,

      retry_policy: {
        max_attempts_per_arm: 2,
        retryable_classifications: ['provider_failure' as const]
      },

      blocks: [
        {
        ...firstBlock,
        runs: retriedRuns
      },
        ...experiment.blocks.slice(1)
      ]
    }

    const twoSelected = {
      ...retried,

      blocks: [
        {
          ...retried.blocks[0]!,

          runs: retriedRuns.map((run) =>
            run.arm_id === 'v1' ? {
            ...run,
            selected: true
          } : run
          )
        },
        ...retried.blocks.slice(1)
      ]
    }

    expect(
      v.safeParse(ExperimentDocumentSchema, retried).issues
    ).toBeUndefined()

    expect(
      pathsFor(v.safeParse(ExperimentDocumentSchema, twoSelected))
    ).toContain('blocks')
  })

  it('rejects inconsistent planned and invalidated block states', () => {
    const experiment = v.parse(
      ExperimentDocumentSchema,
      readExample('valid', 'experiment')
    )

    const planned = experiment.blocks[1]!

    const plannedWithDeadline = {
      ...planned,

      deadline_at: {
        status: 'known' as const,
        value: '2026-09-06T13:00:00Z'
      }
    }

    const completed = experiment.blocks[0]!

    const earlyDeadlineExceeded = {
      ...completed,
      completion_status: 'invalidated' as const,

      contemporaneity: {
        status: 'ineligible' as const,
        cause: 'deadline_exceeded' as const,
        reason: 'Contradicts the completion timestamp'
      }
    }

    expect(
      pathsFor(
        v.safeParse(ExperimentDocumentSchema, {
          ...experiment,

          blocks: [
            experiment.blocks[0]!,
            plannedWithDeadline,
            experiment.blocks[2]!
          ]
        })
      )
    ).toContain('blocks')

    expect(
      pathsFor(
        v.safeParse(ExperimentDocumentSchema, {
          ...experiment,
          blocks: [earlyDeadlineExceeded, ...experiment.blocks.slice(1)]
        })
      )
    ).toContain('blocks')
  })
})

describe('cross-document relationships', () => {
  it('accepts a linked three-arm harness-effect document set', () => {
    const v1Harness = v.parse(
      HarnessDocumentSchema,
      readExample('valid', 'harness')
    )

    const v1Stack = v.parse(StackDocumentSchema, readExample('valid', 'stack'))

    const disabledHarness = v.parse(HarnessDocumentSchema, {
      ...v1Harness,
      harness_id: 'harness-disabled',
      digest: patternedDigest('14')
    })

    const v2Harness = v.parse(HarnessDocumentSchema, {
      ...v1Harness,
      harness_id: 'harness-v2',
      digest: patternedDigest('16')
    })

    const disabledStack = v.parse(StackDocumentSchema, {
      ...v1Stack,
      stack_id: 'codex-low-disabled',
      digest: patternedDigest('13'),

      harness: {
        id: disabledHarness.harness_id,
        revision: disabledHarness.revision,
        digest: disabledHarness.digest
      }
    })

    const v2Stack = v.parse(StackDocumentSchema, {
      ...v1Stack,
      stack_id: 'codex-low-v2',
      digest: patternedDigest('15'),

      harness: {
        id: v2Harness.harness_id,
        revision: v2Harness.revision,
        digest: v2Harness.digest
      }
    })

    const suite = v.parse(SuiteDocumentSchema, readExample('valid', 'suite'))
    const task = v.parse(TaskDocumentSchema, readExample('valid', 'task'))

    const experiment = v.parse(
      ExperimentDocumentSchema,
      readExample('valid', 'experiment')
    )

    const initialRun = v.parse(
      InitialRunRecordSchema,
      readExample('valid', 'run')
    )

    const completionRun = completionRecord()
    const score = v.parse(ScoreDocumentSchema, readExample('valid', 'score'))

    const issues = validateDocumentRelationships({
      stacks: [disabledStack, v1Stack, v2Stack],
      harnesses: [disabledHarness, v1Harness, v2Harness],
      suite,
      tasks: [task],
      experiment,
      initial_run: initialRun,
      initial_run_digest: digest('2'),
      completion_run: completionRun,
      score
    })

    expect(issues).toEqual([])

    const changedAgentRun = {
      ...initialRun,

      agent: {
        ...initialRun.agent,
        effort: 'high' as const
      }
    }

    const incompatible = validateDocumentRelationships({
      stacks: [disabledStack, v1Stack, v2Stack],
      harnesses: [disabledHarness, v1Harness, v2Harness],
      suite,
      tasks: [task],
      experiment,
      initial_run: changedAgentRun,
      initial_run_digest: digest('2'),
      completion_run: completionRun,
      score
    })

    expect(incompatible.map(({ path }) => path)).toContain('initial_run.agent')
  })

  it('reports immutable initial/completion linkage errors', () => {
    const initialRun = v.parse(
      InitialRunRecordSchema,
      readExample('valid', 'run')
    )

    const completionRun = completionRecord()

    const mismatched = {
      ...completionRun,

      identity: {
        ...completionRun.identity,
        attempt_id: 'attempt-2'
      }
    }

    const stack = v.parse(StackDocumentSchema, readExample('valid', 'stack'))

    const harness = v.parse(
      HarnessDocumentSchema,
      readExample('valid', 'harness')
    )

    const issues = validateDocumentRelationships({
      stacks: [stack],
      harnesses: [harness],
      suite: v.parse(SuiteDocumentSchema, readExample('valid', 'suite')),
      tasks: [v.parse(TaskDocumentSchema, readExample('valid', 'task'))],

      experiment: v.parse(
        ExperimentDocumentSchema,
        readExample('valid', 'experiment')
      ),

      initial_run: initialRun,
      initial_run_digest: digest('9'),
      completion_run: mismatched
    })

    expect(issues.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        'completion_run.identity.attempt_id',
        'completion_run.initial_manifest_digest'
      ])
    )
  })

  it('reports completion chronology and score identity errors', () => {
    const initialRun = v.parse(
      InitialRunRecordSchema,
      readExample('valid', 'run')
    )

    const completionRun = {
      ...completionRecord(),
      completed_at: '2026-09-05T07:59:59Z'
    }

    const score = v.parse(ScoreDocumentSchema, readExample('valid', 'score'))

    const issues = validateDocumentRelationships({
      stacks: [v.parse(StackDocumentSchema, readExample('valid', 'stack'))],

      harnesses: [
        v.parse(HarnessDocumentSchema, readExample('valid', 'harness'))
      ],

      suite: v.parse(SuiteDocumentSchema, readExample('valid', 'suite')),
      tasks: [v.parse(TaskDocumentSchema, readExample('valid', 'task'))],

      experiment: v.parse(
        ExperimentDocumentSchema,
        readExample('valid', 'experiment')
      ),

      initial_run: initialRun,
      initial_run_digest: digest('2'),
      completion_run: completionRun,

      score: {
        ...score,
        score_id: 'different-score'
      }
    })

    expect(issues.map(({ path }) => path)).toEqual(
      expect.arrayContaining(['completion_run.completed_at', 'score.score_id'])
    )
  })

  it('binds exact experiment task revisions and source digests', () => {
    const documents = linkedDocuments()
    const reference = documents.experiment.tasks[0]!

    const experiment = {
      ...documents.experiment,

      tasks: [
        {
          ...reference,
          revision: '2',
          source_digest: patternedDigest('34')
        }
      ]
    }

    const issues = validateDocumentRelationships({
      ...documents,
      experiment
    })

    expect(issues.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        'experiment.tasks.0.revision',
        'experiment.tasks.0.source_digest'
      ])
    )
  })

  it('binds experiment budget and concurrency to every stack', () => {
    const documents = linkedDocuments()

    const experiment = {
      ...documents.experiment,

      budget: {
        ...documents.experiment.budget,
        wall_clock_seconds: 601
      }
    }

    const issues = validateDocumentRelationships({
      ...documents,
      experiment
    })

    expect(issues.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        'experiment.arms.0.stack',
        'experiment.arms.1.stack',
        'experiment.arms.2.stack'
      ])
    )
  })

  it('rejects experiment concurrency evidence that differs from its stacks', () => {
    const documents = linkedDocuments()

    const experiment = v.parse(ExperimentDocumentSchema, {
      ...documents.experiment,

      effective_concurrency: {
        status: 'unknown',
        reason: 'Mutation removes observed enforcement'
      },

      concurrency_enforcement_status: 'not_started'
    })

    const issues = validateDocumentRelationships({
      ...documents,
      experiment
    })

    expect(issues.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        'experiment.arms.0.stack',
        'experiment.arms.1.stack',
        'experiment.arms.2.stack'
      ])
    )
  })

  it.each([
    ['run ID', { run_id: 'rogue-run' }],
    ['attempt', { attempt: 2 }]
  ])(
    'binds every initial run %s to its block assignment',
    (_name, identity) => {
      const documents = linkedDocuments()

      const initialRun = {
        ...documents.initial_run,

        identity: {
          ...documents.initial_run.identity,
          ...identity
        }
      }

      const issues = validateDocumentRelationships({
        ...documents,
        initial_run: initialRun
      })

      expect(issues.map(({ path }) => path)).toContain(
        'initial_run.identity.run_id'
      )
    }
  )

  it('requires score and completion documents to appear together for a valid grade', () => {
    const documents = linkedDocuments()
    const { completion_run: _completionRun, ...withoutCompletion } = documents
    const { score: _score, ...withoutScore } = documents

    expect(
      validateDocumentRelationships(withoutCompletion).map(({ path }) => path)
    ).toContain('score')

    expect(
      validateDocumentRelationships(withoutScore).map(({ path }) => path)
    ).toContain('score')
  })

  it.each(['direct_behavior_pass', 'regression_pass'] as const)(
    'rejects task success when %s fails',
    (gate) => {
      const documents = linkedDocuments()

      const score = v.parse(ScoreDocumentSchema, {
        ...documents.score,

        gates: {
          ...documents.score.gates,
          [gate]: false
        },

        composite: {
          status: 'value',
          value: 0
        }
      })

      const issues = validateDocumentRelationships({
        ...documents,
        score
      })

      expect(issues.map(({ path }) => path)).toContain('score.gates')
    }
  )

  it('binds run retention to the task and immutable completion', () => {
    const documents = linkedDocuments()

    const initialRun = v.parse(InitialRunRecordSchema, {
      ...documents.initial_run,

      retention: {
        classification: 'private',
        default_days: 90,
        expires_at: '2026-12-04T09:00:00Z'
      }
    })

    const issues = validateDocumentRelationships({
      ...documents,
      initial_run: initialRun
    })

    expect(issues.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        'initial_run.retention',
        'completion_run.retention'
      ])
    )
  })

  it.each([
    [
      'collector revision',
      'completion_run.collection',
      (completion: CompletionRunRecord) => ({
        ...completion,

        collection: {
          ...completion.collection,
          collector_revision: '2'
        }
      })
    ],
    [
      'collector image',
      'completion_run.collection',
      (completion: CompletionRunRecord) => ({
        ...completion,

        collection: {
          ...completion.collection,
          collector_image_digest: patternedDigest('35')
        }
      })
    ],
    [
      'verifier revision',
      'completion_run.verifier',
      (completion: CompletionRunRecord) => ({
        ...completion,

        verifier: {
          ...completion.verifier,
          verifier_revision: '2'
        }
      })
    ],
    [
      'verifier image',
      'completion_run.verifier',
      (completion: CompletionRunRecord) => ({
        ...completion,

        verifier: {
          ...completion.verifier,
          verifier_image_digest: patternedDigest('36')
        }
      })
    ],
    [
      'verifier sidecar',
      'completion_run.verifier',
      (completion: CompletionRunRecord) => ({
        ...completion,

        verifier: {
          ...completion.verifier,

          network_enforcement_sidecar_digest: {
            status: 'known' as const,
            value: patternedDigest('37')
          }
        }
      })
    ]
  ] as const)(
    'binds completion %s to the initial manifest',
    (_name, path, mutate) => {
      const documents = linkedDocuments()

      const completionRun = v.parse(
        CompletionRunRecordSchema,
        mutate(documents.completion_run)
      )

      const issues = validateDocumentRelationships({
        ...documents,
        completion_run: completionRun
      })

      expect(issues.map(({ path: issuePath }) => issuePath)).toContain(path)
    }
  )
})

describe('checked-in invalid examples', () => {
  it.each([
    ['stack-concurrency-two', StackDocumentSchema],
    ['run-missing-collector', InitialRunRecordSchema],
    ['unknown-schema-version', SuiteDocumentSchema]
  ] as const)('rejects only the intended field in %s', (name, schema) => {
    const expectedPath = {
      'run-missing-collector': 'collector',
      'stack-concurrency-two': 'runner.concurrency.requested',
      'unknown-schema-version': 'schema_version'
    }[name]

    const paths = pathsFor(v.safeParse(schema, readExample('invalid', name)))

    expect(paths).toEqual([expectedPath])
  })
})
