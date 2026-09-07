import type { ExperimentPlan, ExperimentState } from '@harness-bench/results'

function display(value: string): string {
  const serialized = JSON.stringify(value)

  return serialized.slice(1, -1)
}
export function renderExperimentPlan(plan: ExperimentPlan): string {
  const lines = [
    `Experiment: ${display(plan.experiment.experiment_id)} revision ${display(plan.experiment.revision)}`,
    `Plan digest: ${plan.experiment.plan_digest}`,
    `Seed: ${plan.experiment.ordering_seed}`,
    'Subscription concurrency: requested 1, effective 1, enforced',
    'Automatic retries: 0; technical failures stop execution',
    `Per invocation: ${plan.experiment.budget.wall_clock_seconds}s agent limit, ${plan.experiment.budget.cpu_count} CPUs, ${plan.experiment.budget.memory_megabytes} MiB`,
    'Execution order:'
  ]

  for (const [index, assignment] of plan.assignments.entries()) {
    const entry = plan.experiment.execution_order[index]!
    const provenance = assignment.origin_plan === null ? 'new' : `carried from ${assignment.origin_plan}`

    lines.push(`${index + 1}. ${entry.task_id} replicate ${entry.replicate} arm ${assignment.arm_id} | ${assignment.block_id} | ${assignment.run_id} | ${provenance}`)
  }

  const newCount = plan.assignments.filter(({ origin_plan }) => origin_plan === null).length
  const carriedCount = plan.assignments.length - newCount
  const seconds = newCount * plan.experiment.budget.wall_clock_seconds

  lines.push(`New assignments: ${newCount}; carried assignments requiring state inspection: ${carriedCount}`)
  lines.push(`New-assignment agent-time ceiling: ${seconds}s; excludes setup and verification, not an experiment duration or quota guarantee`)
  lines.push('Subscription monetary cost: not applicable')

  return `${lines.join('\n')}\n`
}
export function renderExperimentReport(state: ExperimentState): string {
  const lines = [renderExperimentPlan(state.plan).trimEnd(), `Superseded: ${state.superseded}`]
  let pending = 0

  for (const block of state.blocks) {
    lines.push(`Block ${block.block_id}: ${block.status}`)
    lines.push(`  First start: ${block.first_started_at ?? 'unknown'}; deadline: ${block.deadline_at ?? 'unknown'}; completion: ${block.completed_at ?? 'unknown'}`)

    if (block.cause !== null) lines.push(`  Excluded: ${block.cause}; ${display(block.reason ?? '')}`)

    for (const run of block.runs) {
      const outcome = run.result === null ? run.status : `${run.result.classification}, valid grade: ${run.result.valid_grade}`

      lines.push(`  ${run.assignment.arm_id}: ${outcome} | ${run.assignment.run_id}`)

      if (run.result !== null) lines.push(`    Result: ${display(run.result.normalized_path)}`)

      if (block.status !== 'invalidated' && run.status === 'pending') pending += 1
    }
  }

  lines.push(`Remaining scheduled invocations: ${pending}`)
  lines.push(`Parent plan: ${state.plan.parent_plan ?? 'none'}; replaced block: ${state.plan.replaced_block ?? 'none'}`)
  lines.push('Provider-hidden changes remain unknown; public fixtures prove plumbing only')

  return `${lines.join('\n')}\n`
}
