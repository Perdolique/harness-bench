import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import * as v from '../../packages/schemas/node_modules/valibot/dist/index.mjs'
import { ScoreDocumentSchema } from '../../packages/schemas/src/index.ts'
import { fixtureScore } from '../../tests/fixtures/doctor/score.ts'
import { assertCanonicalScore } from '../canonical-task-check.ts'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const fixture = resolve(repositoryRoot, 'fixtures/order-receipt')

const solution = resolve(
  repositoryRoot,
  'benchmark/tasks/order-receipt/solutions/reference/files'
)

const mutator = resolve(
  repositoryRoot,
  'benchmark/tasks/order-receipt/calibration/mutate.mjs'
)

const manifestPath = resolve(
  repositoryRoot,
  'benchmark/tasks/order-receipt/calibration/negative-controls.json'
)

const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Readonly<
  Record<string, readonly string[]>
>

const controls = Object.keys(manifest)

function canonicalScore(control: string) {
  const positive = control !== 'pristine'

  const { score } = fixtureScore(control, {
    contracts: positive,
    direct: positive,
    regression: true,
    scope: true
  }, {
    credentialsAbsent: true,
    networkIsolated: true
  })

  return {
    ...score,

    harbor_reward: {
      status: 'retained_upstream',

      numeric_values: {
        direct_behavior: Number(positive),
        repository_contracts: Number(positive),
        regression: 1,
        scope_integrity: 1
      }
    }
  }
}

describe('canonical numeric calibration', () => {
  test.each(['pristine', 'reference', 'alternate', 'reference-repeat'])('accepts exact facets and rewards for %s', (control) => {
    const score = canonicalScore(control)

    expect(assertCanonicalScore(control, score)).toEqual(score)
  })

  test.each(['reference', 'alternate', 'reference-repeat'])('rejects internally consistent but incorrect contract scoring for %s', (control) => {
    const score = canonicalScore(control)

    score.facets.repository_contracts.value = 0
    score.harbor_reward.numeric_values.repository_contracts = 0
    score.composite.value = 0.65

    // Schema consistency and passing boolean checks do not establish correct calibration.
    expect(v.safeParse(ScoreDocumentSchema, score).success).toBe(true)
    expect(score.facets.repository_contracts.evidence[0]?.outcome).toBe('passed')
    expect(() => assertCanonicalScore(control, score)).toThrow('exact calibrated facets and rewards')
  })

  test.each(['facet', 'reward'] as const)('rejects pristine %s drift even with its composite gated at zero', (kind) => {
    const score = canonicalScore('pristine')

    if (kind === 'facet') score.facets.repository_contracts.value = 1
    else score.harbor_reward.numeric_values.repository_contracts = 1

    expect(v.safeParse(ScoreDocumentSchema, score).success).toBe(true)
    expect(() => assertCanonicalScore('pristine', score)).toThrow('exact calibrated facets and rewards')
  })
})

describe('canonical task negative controls', () => {
  test.each(controls)('applies %s to the formatted reference solution', async (control) => {
    const workspace = await mkdtemp('/tmp/harness-bench-negative-control-')

    try {
      await cp(fixture, workspace, {
        filter: (source) => {
          const path = relative(fixture, source)

          return !['dist', 'node_modules', 'test-results'].some(
            (entry) => path === entry || path.startsWith(`${entry}/`)
          )
        },

        recursive: true
      })

      await cp(solution, workspace, { recursive: true })

      const result = spawnSync(process.execPath, [mutator, control], {
        encoding: 'utf8',

        env: {
          ...process.env,
          CALIBRATION_WORKSPACE: workspace
        }
      })

      expect(result.status, result.stderr).toBe(0)
    } finally {
      await rm(workspace, {
        force: true,
        recursive: true
      })
    }
  })
})
