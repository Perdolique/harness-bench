import type { NormalizedRunRecordV1, ReadNormalizedRunRecordResult } from '@harness-bench/results'

function text(value: string): string {
  const json = JSON.stringify(value)
  const unquoted = json.slice(1, -1)

  return unquoted.replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (character) => {
    const hex = character.charCodeAt(0).toString(16).padStart(4, '0')

    return `\\u${hex}`
  })
}

type UnknownValue = Extract<NormalizedRunRecordV1['timings']['agent_seconds'], { status: 'unknown' }>

function absent(value: UnknownValue | NormalizedRunRecordV1['usage']['subscription_money']): string {
  const status = value.status.replaceAll('_', ' ')
  const reason = text(value.reason)

  return `${status} (${reason})`
}

function metric(value: NormalizedRunRecordV1['timings']['agent_seconds']): string {
  return value.status === 'known' ? String(value.value) : absent(value)
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function renderSingleRunReport(source: ReadNormalizedRunRecordResult): string {
  const record = source.record
  const ids = record.identities
  const lines: string[] = []

  const row = (label: string, value: string | number | boolean): void => {
    const display = typeof value === 'string' ? text(value) : String(value)

    lines.push(`  ${label}: ${display}`)
  }

  const displayRow = (label: string, value: string): void => {
    lines.push(`  ${label}: ${value}`)
  }

  const section = (name: string): void => {
    if (lines.length > 0) lines.push('')

    lines.push(name)
  }

  section('Run')
  row('Run ID', ids.run.run_id)
  row('Attempt ID', ids.run.attempt_id)
  row('Attempt', ids.run.attempt)

  for (const [key, value] of Object.entries(ids.experiment)) row(key, value)

  row('Normalization revision', record.normalization_revision)
  row('Record digest', source.digest)
  row('Record path', source.recordPath)
  section('Identities and revisions')

  for (const name of ['stack', 'suite', 'task', 'harness'] as const) {
    for (const [key, value] of Object.entries(ids[name])) row(`${name}.${key}`, value)
  }

  row('Benchmark commit', ids.benchmark_repo_commit)
  row('Agent', ids.agent.product)
  row('CLI version', ids.agent.cli_version)
  row('Requested model', ids.agent.requested_model)
  row('Effort', ids.agent.effort)
  row('Auth mode', ids.agent.auth_mode)

  const provider = ids.agent.observed_provider_identity
  const providerDisplay = provider.status === 'known' ? text(provider.value) : absent(provider)

  displayRow('Observed provider', providerDisplay)

  for (const [key, value] of Object.entries(record.revisions)) {
    const display = typeof value === 'string' ? text(value) : value.status === 'known' ? value.value : absent(value)

    displayRow(key, display)
  }

  const rubric = record.score.status === 'known' ? text(record.score.document.rubric_revision) : 'unavailable (no valid quality grade)'

  displayRow('Rubric revision', rubric)
  row('Network policy digest', ids.network_policy_digest)
  row('Permissions digest', ids.effective_permissions_digest)
  row('MCP tools digest', ids.mcp_tools_digest)

  for (const [key, value] of Object.entries(ids.host)) row(`host.${key}`, value)

  section('Outcome and reliability')
  row('Classification', record.outcome.classification)
  row('Valid grade', record.outcome.valid_grade)

  for (const [key, value] of Object.entries(record.outcome.termination)) row(`termination.${key}`, value)

  for (const [key, value] of Object.entries(record.evidence_availability)) row(key, value)

  row('Merged output semantics', record.merged_output_semantics)
  section('Scores and scope')

  const facetNames = ['direct_behavior', 'repository_contracts', 'regression', 'scope_integrity', 'maintainability'] as const
  const gateNames = ['direct_behavior_pass', 'regression_pass', 'verifier_integrity_pass'] as const

  if (record.score.status === 'known' && record.outcome.valid_grade) {
    const score = record.score.document

    for (const name of gateNames) row(name, score.gates[name] ? 'passed' : 'failed')

    for (const name of facetNames) {
      const facet = score.facets[name]
      const display = facet.status === 'value' ? facet.value.toFixed(3) : absent(facet)

      displayRow(name, display)

      const evidence = [...facet.evidence].sort((left, right) => compare(left.check_id, right.check_id))

      for (const item of evidence) {
        const checkId = text(item.check_id)

        lines.push(`    ${checkId}: ${item.outcome} ${item.evidence_digest}`)
      }
    }

    row('Scope violations', score.scope_violations.length)

    for (const violation of score.scope_violations) {
      row('Scope path', violation.path)
      row('Scope reason', violation.reason)
      row('Scope evidence', violation.evidence_digest)
    }

    const composite = score.composite.status === 'value' ? score.composite.value.toFixed(3) : absent(score.composite)

    displayRow('Composite (convenience)', composite)
  } else {
    const reason = record.score.status === 'unavailable' ? text(record.score.reason) : 'no valid quality grade'
    const unavailable = `unavailable (${reason})`

    for (const name of [...gateNames, ...facetNames, 'Scope violations', 'Composite (convenience)']) displayRow(name, unavailable)
  }

  section('Timing and usage')
  row('Total seconds', record.timings.total_seconds)
  displayRow('Agent seconds', metric(record.timings.agent_seconds))
  displayRow('Verifier seconds', metric(record.timings.verifier_seconds))
  displayRow('Input tokens', metric(record.usage.input_tokens))
  displayRow('Output tokens', metric(record.usage.output_tokens))
  displayRow('Subscription money', absent(record.usage.subscription_money))

  const estimate = record.usage.upstream_api_price_estimate
  const estimateDisplay = estimate.status === 'known' ? `${estimate.value} USD` : absent(estimate)

  displayRow('API-price estimate, not subscription spend', estimateDisplay)

  if (estimate.status === 'known') row('Estimate provenance', estimate.provenance)

  section('Evidence paths')
  row('Raw manifest', source.rawManifestPath)

  const references = [...source.resolvedReferences].sort((left, right) => {
    const leftKey = `${left.role}:${left.relativePath}`
    const rightKey = `${right.role}:${right.relativePath}`

    return compare(leftKey, rightKey)
  })

  for (const reference of references) row(reference.role, reference.localPath)

  const verifierLogPaths = [...source.verifierLogPaths].sort(compare)

  for (const path of verifierLogPaths) row('verifier_log', path)

  if (verifierLogPaths.length === 0) row('verifier_log', 'unavailable (not retained)')

  const requiredRoles = ['artifact_manifest', 'collected_patch', 'native_rollout', 'atif_trajectory', 'merged_agent_output', 'harbor_trial_log', 'verifier_result'] as const

  for (const role of requiredRoles) {
    if (!references.some((reference) => reference.role === role)) row(role, 'unavailable (not retained)')
  }

  return `${lines.join('\n')}\n`
}
