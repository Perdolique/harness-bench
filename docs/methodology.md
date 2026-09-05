# Methodology

## Experimental identity and controls

The unit under test is the complete stack described in
[the product specification](product-spec.md). For a harness-effect claim, hold
agent version, model/effort, auth mode, task/suite revisions, environment, runner,
verifier, scoring, tool access, and budgets fixed. Only the named harness
difference is the treatment. Model/effort or native-agent changes compare complete
stacks and must be labelled accordingly.

Use a fixed base snapshot with no future history. The pristine base must fail the
new direct requirement for the intended reason while existing regressions pass.
A known-good reference patch and a structurally different valid implementation
must pass the canonical task. Never grade source/diff similarity. Every implicit
contract has a path in the pristine snapshot and observable expected behavior.

Materialize the agent-visible source as a new local Git repository with exactly one
base commit. Do not copy the source object database, refs, remotes, hooks,
credentials, or later history; retain only objects reachable from the new commit.
Record source provenance outside that repository, and capture the result
independently of agent-controlled Git metadata.

With unrestricted agent internet, local absence is not secrecy. Exclude a task from
hidden-material or future-history claims when the exact grading material, later
solution, or identifiable source history is publicly reachable. A public synthetic
fixture can test orchestration but cannot establish this online isolation property.

## Score vector and applicability

| Dimension | Meaning | Gate |
| --- | --- | --- |
| Direct behavior | Explicit requested behavior | Required pass |
| Repository contracts | Evidence-backed analytics, tests, logging, accessibility, localization | Per-task declared checks |
| Regression | Existing supported behavior remains correct | Required pass |
| Scope integrity | Changes stay within the justified envelope | Score plus violation evidence |
| Maintainability | Optional deterministic rubric | Not part of v1 composite |

Each applicable facet is a number in `[0,1]` with evidence and rubric revision.
`not_applicable` means no justified obligation; `unknown` means evidence is
unavailable. Neither is zero. Repository-contract aggregation uses task-declared
weights over applicable facets, frozen before runs. If none apply, the aggregate
is `not_applicable` and the optional composite is omitted. Missing required scores
also suppress the composite rather than silently redistributing weights.

The initial convenience composite, for complete applicable grades, is:

```text
gate = direct_behavior_pass * regression_pass * verifier_integrity_pass
composite = gate * (
  0.45 * direct_behavior
  + 0.35 * repository_contracts
  + 0.20 * scope_integrity
)
```

Raw facets remain authoritative. Failed direct/regression checks yield a valid
task-quality failure and a gated zero composite. Missing or compromised verifier
evidence is an invalid grade, not a numeric zero. The integrity gate is a condition
for scoring; it does not convert verifier execution failures into task failures.

## Failure taxonomy

| Classification | Example | Analysis treatment |
| --- | --- | --- |
| Task failure | Valid checks reject produced behavior | Include in quality outcomes |
| Agent failure | Native CLI fails independently of task grading | Report reliability and raw reason |
| Provider failure | Auth rejection, quota exhaustion, provider outage | Report separately; no fabricated quality zero |
| Runner failure | Harbor orchestration or collection fails | Invalid/missing grade |
| Verifier failure | Hidden checker crashes or fails to produce valid evidence | Invalid/missing grade |
| Infrastructure failure | Docker startup, image, host/storage failure | Invalid/missing grade |
| Cancellation | Owner or scheduler cancels | Preserve partial evidence; no completed score |

Record timeout explicitly with phase, elapsed limit, and observed cause. A policy
budget exhaustion during an otherwise healthy agent run can still produce a
grade if complete trustworthy artifacts exist; show both termination and grade.
Never guess an underlying cause from a zero exit status or empty reward alone.

## Scheduling and comparison

Freeze the execution plan before the first invocation. It contains arms, tasks,
replicates, blocks, ordering seed, budgets, and immutable identities. V1
subscription concurrency is exactly one, not a tunable default. Record requested
and effective concurrency plus enforcement status. Run arms within each
task/replicate block in seeded interleaved order. Do not run all A followed by all
B. Resume only skips completed immutable run IDs; failed/retried attempts remain
separate records under a declared retry policy. Keep incomplete experiments
reportable.

Start and finish both arms of a task/replicate block within 24 hours measured from
the first arm start. A known model, CLI, provider, runner, Harbor-configuration, or
harness change during that interval invalidates the block even when it finishes on
time. If the window expires or a known change occurs, retain the attempts but rerun
the complete block under new immutable IDs; do not use the old block for a causal
harness claim.

Compare per-task paired deltas and win/tie/loss using a declared tie rule, pass
rates, facet deltas, reliability such as all-pass-across-repeats, duration, and
observed usage distributions. Report paired coverage and every omitted pair with
its failure reason. Do not selectively retry only a losing arm or claim causality
from unmatched historical runs.

For uncertainty, resample task clusters with replacement while keeping paired
arms and repeats together; aggregate within task before overall deltas. Record
bootstrap seed, resample count, interval method, and analysis revision. The pilot's
five tasks and three repeats per arm support descriptive evidence with wide
uncertainty, not universal significance or general model rankings. Issue 11 must
validate the estimator on known synthetic data and show small-sample limitations.

Reject harness-effect comparisons with incompatible task, suite, environment,
runner, verifier, scoring, budget, or uncontrolled stack differences. Regrade both
arms to an explicitly shared scoring/verifier revision when appropriate, preserving
the original results. Provider-hidden model changes remain a stated limitation.

## Run manifest contract

The v1 Valibot schemas record at least the following, with explicit `unknown` for
unavailable provider values. Serialized fields use `snake_case`; the names below
are grouped for readability and map directly to the checked-in contracts.

| Group | Required fields |
| --- | --- |
| Identity | `run_id`, `created_at`, `benchmark_repo_commit` |
| Suite and task | `suite_id`, `suite_revision`, `task_id`, `task_revision`, `task_base_commit`, `task_source_digest`, `task_environment_image_digest` |
| Verification | `verifier_revision`, `verifier_image_digest`, verifier network-enforcement sidecar digest or explicit `not_applicable`, `scoring_revision` |
| Collection | `collector_revision`, `collector_image_digest`, quiescence/collection/manifest/hash enforcement status |
| Runner | `runner.name`, `runner.version`, `runner.config_digest`, effective telemetry setting, requested/effective concurrency and enforcement status |
| Agent | `agent.product`, `agent.cli_version`, `agent.model`, `agent.effort`, `agent.auth_mode`, observed provider identity when exposed |
| Harness and policy | `harness.id`, `harness.digest`, `network_policy_digest`, effective permissions and MCP/tool configuration digest |
| Budget | `budget.wall_clock_seconds`, `budget.token_or_turn_limits`, CPU/memory limits and enforcement status |
| Experiment | `experiment.id`, `experiment.arm`, `experiment.block`, `experiment.replicate`, ordering seed, plan digest, block first-start/deadline/completion timestamps, contemporaneity status and invalidation reason |
| Host | `host.os`, macOS version, Apple Silicon model/architecture, Docker Desktop/Engine versions, LinuxKit kernel, container architecture |
| Completion record | `result.status`, `result.termination_reason`, `result.raw_artifact_path`, collection hashes, attempt ID, observed timings/usage |

Record initial and completion manifests separately, linked by ID/digest. Suite,
task, harness, collector, verifier, scoring, network policy, sidecar/image, runner
configuration, concurrency enforcement, and analysis revisions are independently
versioned. Never overwrite raw artifacts when correcting normalization or grading.
Subscription money is `not_applicable` or `unknown`, never API-token price
multiplied into a supposed bill.

The score document keeps Harbor numeric rewards as upstream metadata and records
facet applicability, evidence, gates, and failures separately. A composite is
allowed only for a valid grade with numeric direct-behavior, repository-contract,
regression, and scope-integrity facets. A verifier failure has no valid quality
score. Runtime cross-document validation additionally checks immutable
initial/completion linkage, exact suite/task/stack/harness references, and that a
harness-effect comparison changes only the declared harness treatment.

For issue 2 revision `public-1`, freeze two identical sequential invocations with
unrestricted agent internet. Concurrency is one and retries are zero. A timeout or
infrastructure failure is retained as its own outcome and never triggers another
run. Two invocations are the revision's ceiling, not an automatic reset of the old
approval. Obtain a new explicit run-card authorization before inference.

The owner changed the experiment objective to realistic internet access on
2026-09-05. Keep the failed restricted-network record and its owner no-go unchanged;
do not pool it with the public-network results or claim that removing a requirement
proved the former requirement. Public internet permits changing remote content and
downloads, so identical inputs do not imply a hermetic or bit-reproducible run.
Record observable commands and external dependencies in the native evidence.

Execution qualification: after public-01 started at medium, the owner requested
low for public-02. Both completed, but they are not an identical-repeat experiment.
The owner accepted this deviation for the temporary issue 2 feasibility gate on
2026-09-05, then explicitly authorized one additional low invocation. Public-03
passed with the same recorded stack settings and byte-identical task inputs as
public-02, resolving the missing repeat. Four total invocations are now consumed,
including the historical failure; the supplemental root does not renew the budget.
This small fixture pair does not relax paired/repeated methodology for later comparisons.

## Human calibration

After issue 6, approve realism, evidence, alternate implementations, and scope
grading. After issue 13, inspect a dry run and one authorized subscription canary.
After issue 16, freeze the pilot and separate calibration observations from the
final comparison. After issue 17, inspect trajectories and patches before accepting
findings. Do not retune tasks based on which final harness arm won. A general sealed
suite workflow is deferred to M4; manual pilot freezing is required in v1.
