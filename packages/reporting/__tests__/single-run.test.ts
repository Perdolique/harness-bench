import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeRun, readNormalizedRunRecord, type ReadNormalizedRunRecordResult } from '@harness-bench/results'
import { createResultFixture, makeWritable, type FixtureClassification } from '../../results/__tests__/fixture.ts'
import { renderSingleRunReport } from '../src/single-run.ts'

let root: string

beforeEach(async () => {
  const temporary = await mkdtemp('/tmp/harness-bench-report-')

  root = await realpath(temporary)
})

afterEach(async () => {
  await makeWritable(root)

  await rm(root, {
    recursive: true,
    force: true
  })
})

async function source(classification: FixtureClassification = 'task_success'): Promise<ReadNormalizedRunRecordResult> {
  const fixture = await createResultFixture(root, {
    classification,

    rawMutator: async (rawRoot) => {
      if (classification === 'infrastructure_failure') {
        const agent = resolve(rawRoot, 'harbor/job/trial-fixture/agent')

        await rm(agent, { recursive: true })
      }
    }
  })

  const normalized = await normalizeRun(fixture.runDirectory)

  if (normalized.kind !== 'normalized') throw new Error('Expected normalized fixture')

  return readNormalizedRunRecord(normalized.recordPath)
}

function stableReport(input: ReadNormalizedRunRecordResult): string {
  const report = renderSingleRunReport(input)

  return report.replaceAll(root, '<fixture>').replaceAll(input.digest, '<normalized-digest>').replaceAll(input.digest.slice(7), '<normalized-address>')
}

function reportSections(report: string, names: readonly string[]): string {
  const sections = report.trimEnd().split('\n\n')

  const selected = sections.filter((section) => {
    const heading = section.split('\n')[0] ?? ''

    return names.includes(heading)
  })

  expect(selected).toHaveLength(names.length)

  return selected.join('\n\n')
}

describe(renderSingleRunReport, () => {
  it('snapshots complete success', async () => {
    const input = await source()

    expect(stableReport(input)).toMatchInlineSnapshot(`
      "Run
        Run ID: fixture-run
        Attempt ID: fixture-run-attempt-1
        Attempt: 1
        experiment_id: fixture-experiment
        experiment_revision: 1
        plan_digest: sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
        arm_id: a
        block_id: fixture-block
        replicate: 1
        Normalization revision: 1
        Record digest: <normalized-digest>
        Record path: <fixture>/runs/.results/fixture-run/normalized/<normalized-address>/record.json

      Identities and revisions
        stack.id: fixture-stack
        stack.revision: 1
        stack.digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        suite.id: fixture-suite
        suite.revision: 1
        suite.digest: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
        task.id: fixture-task
        task.revision: 1
        task.base_commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        task.source_digest: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
        task.environment_image_digest: sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
        harness.id: fixture-harness
        harness.revision: 1
        harness.digest: sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
        Benchmark commit: 1111111111111111111111111111111111111111
        Agent: codex
        CLI version: 0.153.2
        Requested model: gpt-5.6-luna
        Effort: low
        Auth mode: chatgpt_subscription
        Observed provider: unknown (Provider identity is hidden)
        runner_name: harbor
        runner_version: 0.22.0
        runner_config_digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        collector_revision: fixture-collector-v1
        collector_image_digest: sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
        verifier_revision: fixture-verifier-v1
        verifier_image_digest: sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
        verifier_network_enforcement_sidecar_digest: not applicable (Docker network_mode none is direct)
        scoring_revision: fixture-scoring-v1
        Rubric revision: fixture-rubric-v1
        Network policy digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        Permissions digest: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
        MCP tools digest: sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
        host.os: macos
        host.os_version: 15.6
        host.architecture: arm64
        host.apple_silicon_model: Apple M4
        host.docker_desktop_version: 4.50.0
        host.docker_engine_version: 28.0.0
        host.linuxkit_kernel: 6.10.0-linuxkit
        host.container_architecture: linux/arm64

      Outcome and reliability
        Classification: task_success
        Valid grade: true
        termination.kind: success
        native_rollout: available
        atif_trajectory: available
        merged_agent_output: available
        Merged output semantics: irreversibly_merged_stdout_stderr

      Scores and scope
        direct_behavior_pass: passed
        regression_pass: passed
        verifier_integrity_pass: passed
        direct_behavior: 1.000
          direct: passed sha256:1111111111111111111111111111111111111111111111111111111111111111
        repository_contracts: 1.000
          contracts: passed sha256:2222222222222222222222222222222222222222222222222222222222222222
        regression: 1.000
          regression: passed sha256:3333333333333333333333333333333333333333333333333333333333333333
        scope_integrity: 1.000
          scope: passed sha256:4444444444444444444444444444444444444444444444444444444444444444
        maintainability: not applicable (Not measured by this fixture)
        Scope violations: 0
        Composite (convenience): 1.000

      Timing and usage
        Total seconds: 10
        Agent seconds: 4
        Verifier seconds: 1
        Input tokens: 12
        Output tokens: 5
        Subscription money: not applicable (Subscription money is not derived from token usage)
        API-price estimate, not subscription spend: 0.25 USD
        Estimate provenance: Harbor 0.22.0 Codex ATIF metrics backed by upstream LiteLLM API-price estimation

      Evidence paths
        Raw manifest: <fixture>/runs/fixture-run/raw-manifest.json
        artifact_manifest: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/artifacts/manifest.json
        atif_trajectory: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/agent/trajectory.json
        collected_patch: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/artifacts/trusted-collector/workspace.patch
        collector_metadata: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/artifacts/trusted-collector/workspace-metadata.json
        harbor_job_result: <fixture>/runs/fixture-run/raw/harbor/job/result.json
        harbor_trial_log: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/trial.log
        harbor_trial_result: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/result.json
        merged_agent_output: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/agent/codex.txt
        native_rollout: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/agent/sessions/2026/09/06/rollout-2026-09-06T12-00-00-provider-free-fixture.jsonl
        runner_process_control: <fixture>/runs/fixture-run/raw/runner/process-control.json
        runner_stderr: <fixture>/runs/fixture-run/raw/runner/harbor.stderr.log
        runner_stdout: <fixture>/runs/fixture-run/raw/runner/harbor.stdout.log
        structured_score: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/verifier/score.json
        upstream_reward: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/verifier/reward.json
        verifier_result: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/verifier/verifier-result.json
        verifier_log: unavailable (not retained)
      "
    `)
  })

  it('snapshots a valid task failure and preserves zero', async () => {
    const input = await source('task_failure')
    const report = stableReport(input)

    expect(report).toContain('direct_behavior: 0.000')
    expect(report).toContain('Composite (convenience): 0.000')

    expect(reportSections(report, ['Outcome and reliability', 'Scores and scope'])).toMatchInlineSnapshot(`
      "Outcome and reliability
        Classification: task_failure
        Valid grade: true
        termination.kind: success
        native_rollout: available
        atif_trajectory: available
        merged_agent_output: available
        Merged output semantics: irreversibly_merged_stdout_stderr

      Scores and scope
        direct_behavior_pass: failed
        regression_pass: passed
        verifier_integrity_pass: passed
        direct_behavior: 0.000
          direct: failed sha256:1111111111111111111111111111111111111111111111111111111111111111
        repository_contracts: 1.000
          contracts: passed sha256:2222222222222222222222222222222222222222222222222222222222222222
        regression: 1.000
          regression: passed sha256:3333333333333333333333333333333333333333333333333333333333333333
        scope_integrity: 1.000
          scope: passed sha256:4444444444444444444444444444444444444444444444444444444444444444
        maintainability: not applicable (Not measured by this fixture)
        Scope violations: 0
        Composite (convenience): 0.000"
    `)
  })

  it('snapshots unknown and inapplicable facets without inventing composite', async () => {
    const input = await source()

    if (input.record.score.status !== 'known') throw new Error('Expected score')

    input.record.score.document.facets.repository_contracts = {
      status: 'not_applicable',
      reason: 'No justified contracts',
      evidence: []
    }
    input.record.score.document.facets.scope_integrity = {
      status: 'unknown',
      reason: 'Scope evidence unavailable',
      evidence: []
    }
    input.record.score.document.composite = {
      status: 'not_applicable',
      reason: 'Required facets are not numeric'
    }

    const report = stableReport(input)

    expect(reportSections(report, ['Scores and scope'])).toMatchInlineSnapshot(`
      "Scores and scope
        direct_behavior_pass: passed
        regression_pass: passed
        verifier_integrity_pass: passed
        direct_behavior: 1.000
          direct: passed sha256:1111111111111111111111111111111111111111111111111111111111111111
        repository_contracts: not applicable (No justified contracts)
        regression: 1.000
          regression: passed sha256:3333333333333333333333333333333333333333333333333333333333333333
        scope_integrity: unknown (Scope evidence unavailable)
        maintainability: not applicable (Not measured by this fixture)
        Scope violations: 0
        Composite (convenience): not applicable (Required facets are not numeric)"
    `)
  })

  it('snapshots infrastructure failure with absent trajectories', async () => {
    const input = await source('infrastructure_failure')

    input.record.evidence_availability = {
      native_rollout: 'unavailable',
      atif_trajectory: 'unavailable',
      merged_agent_output: 'unavailable'
    }

    const absentRoles = ['native_rollout', 'atif_trajectory', 'merged_agent_output']
    const references = input.resolvedReferences.filter((reference) => !absentRoles.includes(reference.role))

    const report = stableReport({
      ...input,
      resolvedReferences: references
    })

    expect(report).not.toContain('0.000')

    expect(reportSections(report, ['Outcome and reliability', 'Scores and scope', 'Evidence paths'])).toMatchInlineSnapshot(`
      "Outcome and reliability
        Classification: infrastructure_failure
        Valid grade: false
        termination.kind: error
        termination.reason: Execution did not produce a grade
        native_rollout: unavailable
        atif_trajectory: unavailable
        merged_agent_output: unavailable
        Merged output semantics: irreversibly_merged_stdout_stderr

      Scores and scope
        direct_behavior_pass: unavailable (Execution outcome has no valid quality grade)
        regression_pass: unavailable (Execution outcome has no valid quality grade)
        verifier_integrity_pass: unavailable (Execution outcome has no valid quality grade)
        direct_behavior: unavailable (Execution outcome has no valid quality grade)
        repository_contracts: unavailable (Execution outcome has no valid quality grade)
        regression: unavailable (Execution outcome has no valid quality grade)
        scope_integrity: unavailable (Execution outcome has no valid quality grade)
        maintainability: unavailable (Execution outcome has no valid quality grade)
        Scope violations: unavailable (Execution outcome has no valid quality grade)
        Composite (convenience): unavailable (Execution outcome has no valid quality grade)

      Evidence paths
        Raw manifest: <fixture>/runs/fixture-run/raw-manifest.json
        artifact_manifest: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/artifacts/manifest.json
        collected_patch: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/artifacts/trusted-collector/workspace.patch
        collector_metadata: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/artifacts/trusted-collector/workspace-metadata.json
        harbor_job_result: <fixture>/runs/fixture-run/raw/harbor/job/result.json
        harbor_trial_log: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/trial.log
        harbor_trial_result: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/result.json
        runner_process_control: <fixture>/runs/fixture-run/raw/runner/process-control.json
        runner_stderr: <fixture>/runs/fixture-run/raw/runner/harbor.stderr.log
        runner_stdout: <fixture>/runs/fixture-run/raw/runner/harbor.stdout.log
        structured_score: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/verifier/score.json
        upstream_reward: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/verifier/reward.json
        verifier_result: <fixture>/runs/fixture-run/raw/harbor/job/trial-fixture/verifier/verifier-result.json
        verifier_log: unavailable (not retained)
        native_rollout: unavailable (not retained)
        atif_trajectory: unavailable (not retained)
        merged_agent_output: unavailable (not retained)"
    `)
  })

  it('preserves all execution failure classifications and timeout details', async () => {
    const input = await source('provider_failure')

    for (const classification of ['agent_failure', 'provider_failure', 'runner_failure', 'verifier_failure', 'infrastructure_failure', 'cancellation'] as const) {
      input.record.outcome.classification = classification
      input.record.outcome.termination = {
        kind: 'timeout',
        stage: 'agent',
        limit_seconds: 60,
        elapsed_seconds: 61,
        observed_cause: 'Quota exhausted'
      }

      const report = renderSingleRunReport(input)

      expect(report).toContain(`Classification: ${classification}`)
      expect(report).toContain('termination.stage: agent')
      expect(report).toContain('termination.observed_cause: Quota exhausted')
      expect(report).toContain('Composite (convenience): unavailable')
    }
  })

  it('distinguishes known zero timing and usage from unknown values', async () => {
    const input = await source()

    input.record.usage.input_tokens = {
      status: 'known',
      value: 0
    }
    input.record.usage.output_tokens = {
      status: 'unknown',
      reason: 'Provider did not report tokens'
    }
    input.record.timings.agent_seconds = {
      status: 'known',
      value: 0
    }
    input.record.timings.verifier_seconds = {
      status: 'unknown',
      reason: 'No timing pair'
    }

    const estimate = input.record.usage.upstream_api_price_estimate

    if (estimate.status !== 'known') throw new Error('Expected estimate')

    estimate.value = 0

    const report = renderSingleRunReport(input)

    expect(report).toContain('Input tokens: 0\n')
    expect(report).toContain('Output tokens: unknown (Provider did not report tokens)')
    expect(report).toContain('Agent seconds: 0\n')
    expect(report).toContain('Verifier seconds: unknown (No timing pair)')
    expect(report).toContain('API-price estimate, not subscription spend: 0 USD')
    expect(report).toContain('Subscription money: not applicable')

    input.record.usage.upstream_api_price_estimate = {
      status: 'unknown',
      reason: 'No estimate'
    }

    expect(renderSingleRunReport(input)).toContain('API-price estimate, not subscription spend: unknown (No estimate)')
  })

  it('escapes terminal controls in reasons and paths and retains complete digests', async () => {
    const input = await source()

    if (input.record.score.status !== 'known') throw new Error('Expected score')

    input.record.score.document.scope_violations.push({
      path: 'file\n\u001b[31m.ts',
      reason: 'unsafe\r\u009btext',
      evidence_digest: input.digest
    })

    const report = renderSingleRunReport({
      ...input,
      rawManifestPath: '/tmp/with\nnewline'
    })

    expect(report).toContain('Scope path: file\\n\\u001b[31m.ts')
    expect(report).toContain('Scope reason: unsafe\\r\\u009btext')
    expect(report).toContain('Raw manifest: /tmp/with\\nnewline')
    expect(report).toContain(`Scope evidence: ${input.digest}`)

    for (const character of ['\u001b', '\u009b', '\r']) {
      expect(report).not.toContain(character)
    }

    expect(report.endsWith('\n')).toBe(true)

    for (const reference of input.resolvedReferences) expect(report).toContain(reference.localPath)
  })

  it('prints available verifier log paths instead of an unavailable placeholder', async () => {
    const input = await source()

    const rendered = renderSingleRunReport({
      ...input,
      verifierLogPaths: ['/runs/verifier/test-stdout.txt']
    })

    expect(rendered).toContain('verifier_log: /runs/verifier/test-stdout.txt')
    expect(rendered).not.toContain('verifier_log: unavailable')
  })

  it('escapes every bidi control in scope text and local evidence paths', async () => {
    const input = await source()
    const controls = ['\u061c', '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069']

    if (input.record.score.status !== 'known') throw new Error('Expected score')

    for (const control of controls) {
      const hex = control.charCodeAt(0).toString(16).padStart(4, '0')
      const escaped = `\\u${hex}`

      input.record.score.document.scope_violations = [{
        path: `safe${control}file.ts`,
        reason: `reason${control}text`,
        evidence_digest: input.digest
      }]

      const rendered = renderSingleRunReport({
        ...input,
        rawManifestPath: `/tmp/safe${control}manifest.json`
      })

      expect(rendered).not.toContain(control)
      expect(rendered).toContain(`Scope path: safe${escaped}file.ts`)
      expect(rendered).toContain(`Scope reason: reason${escaped}text`)
      expect(rendered).toContain(`Raw manifest: /tmp/safe${escaped}manifest.json`)
    }
  })

  it('renders deterministically without mutating the input', async () => {
    const input = await source()
    const before = structuredClone(input)
    const report = renderSingleRunReport(input)
    const reversed = [...input.resolvedReferences].reverse()

    expect(renderSingleRunReport({
      ...input,
      resolvedReferences: reversed
    })).toBe(report)

    expect(input).toStrictEqual(before)
  })
})
