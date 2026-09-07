# Methodology

## Experimental identity and controls

The unit under test is the complete stack described in [the product specification](product-spec.md). For a harness-effect claim, hold agent version, model/effort, auth mode, task/suite revisions, environment, runner, verifier, scoring, tool access, and budgets fixed. Only the named harness difference is the treatment. Model/effort or native-agent changes compare complete stacks and must be labelled accordingly.

Use a fixed base snapshot with no future history. The pristine base must fail the new direct requirement for the intended reason while existing regressions pass. A known-good reference patch and a structurally different valid implementation must pass the canonical task. Never grade source/diff similarity. Every implicit contract has a path in the pristine snapshot and observable expected behavior.

Materialize the agent-visible source as a new local Git repository with exactly one base commit. Do not copy the source object database, refs, remotes, hooks, credentials, or later history; retain only objects reachable from the new commit. Record source provenance outside that repository, and capture the result independently of agent-controlled Git metadata.

With unrestricted agent internet, local absence is not secrecy. Exclude a task from hidden-material or future-history claims when the exact grading material, later solution, or identifiable source history is publicly reachable. A public synthetic fixture can test orchestration but cannot establish this online isolation property.

## Score vector and applicability

| Dimension | Meaning | Gate |
| --- | --- | --- |
| Direct behavior | Explicit requested behavior | Required pass |
| Repository contracts | Evidence-backed analytics, tests, logging, accessibility, localization | Per-task declared checks |
| Regression | Existing supported behavior remains correct | Required pass |
| Scope integrity | Changes stay within the justified envelope | Score plus violation evidence |
| Maintainability | Optional deterministic rubric | Not part of v1 composite |

Each applicable facet is a number in `[0,1]` with evidence and rubric revision. `not_applicable` means no justified obligation; `unknown` means evidence is unavailable. Neither is zero. Repository-contract aggregation uses task-declared weights over applicable facets, frozen before runs. If none apply, the aggregate is `not_applicable` and the optional composite is omitted. Missing required scores also suppress the composite rather than silently redistributing weights.

The initial convenience composite, for complete applicable grades, is:

```text
gate = direct_behavior_pass * regression_pass * verifier_integrity_pass
composite = gate * (
  0.45 * direct_behavior
  + 0.35 * repository_contracts
  + 0.20 * scope_integrity
)
```

Raw facets remain authoritative. Failed direct/regression checks yield a valid task-quality failure and a gated zero composite. Missing or compromised verifier evidence is an invalid grade, not a numeric zero. The integrity gate is a condition for scoring; it does not convert verifier execution failures into task failures.

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

Record timeout explicitly with phase, elapsed limit, and observed cause. A policy budget exhaustion during an otherwise healthy agent run can still produce a grade if complete trustworthy artifacts exist; show both termination and grade. Never guess an underlying cause from a zero exit status or empty reward alone.

## Reading a single-run report

`benchctl results report NORMALIZED_RECORD` prints the selected normalized result and retained evidence paths. Raw facets and verifier check evidence remain authoritative; the three-decimal composite is a convenience display, not a replacement for them.

For a completed task with trustworthy verification but failed direct behavior, the relevant lines can be:

```text
Classification: task_failure
Valid grade: true
direct_behavior_pass: failed
regression_pass: passed
verifier_integrity_pass: passed
direct_behavior: 0.000
Composite (convenience): 0.000
```

An infrastructure failure instead has no valid quality grade:

```text
Classification: infrastructure_failure
Valid grade: false
direct_behavior_pass: unavailable (Execution outcome has no valid quality grade)
direct_behavior: unavailable (Execution outcome has no valid quality grade)
Composite (convenience): unavailable (Execution outcome has no valid quality grade)
```

Both reports can render successfully with exit `0`; the command's exit code describes inspection, while `Classification` describes the benchmark outcome. Unknown evidence and inapplicable obligations retain explicit reasons rather than becoming zero. The report does not recompute a composite or substitute Harbor reward values for structured score facets. Timings and tokens preserve observed zero, and upstream API-price estimates never represent subscription charges.

## Scheduling and comparison

Freeze the execution plan before the first invocation. It contains arms, tasks, replicates, blocks, ordering seed, budgets, and immutable identities. V1 subscription concurrency is exactly one, not a tunable default. Record requested and effective concurrency plus enforcement status. Run arms within each task/replicate block in seeded interleaved order. Do not run all A followed by all B. Resume only skips completed immutable run IDs; failed/retried attempts remain separate records under a declared retry policy. Keep incomplete experiments reportable.

Start and finish both arms of a task/replicate block within 24 hours measured from the first arm start. A known model, CLI, provider, runner, Harbor-configuration, or harness change during that interval invalidates the block even when it finishes on time. If the window expires or a known change occurs, retain the attempts but rerun the complete block under new immutable IDs; do not use the old block for a causal harness claim.

Issue 10 implements ordering by sorting block identities with SHA-256 over the ordering seed, a scope label, and `task_id:replicate`; within each block it independently sorts arm IDs with the same seeded hash rule. Lexical IDs break hash ties. Input binding order does not change the schedule. All arms of one block remain adjacent, including experiments with three or more arms. The full logical matrix and immutable run assignments are saved before any invocation; started/finished/invalidation records append separately.

The implemented retry policy is zero automatic retries and one attempt per assignment. Task-quality failures remain eligible outcomes. Technical failures stop execution, retain their classification, and make that block incomplete. Explicit resume may proceed with other untouched blocks; only explicit whole-block replacement allocates new IDs. A child plan carries unaffected assignments with their original plan references and preserves the frozen predecessor history. Reports keep excluded attempts visible rather than selecting a favorable arm. Changed physical inputs require a new definition revision.

The block clock starts immediately before preparing its first invocation; the deadline is exactly 24 hours later. Completion at the deadline is eligible; completion after it is not. The controller checks deadlines and known input changes before invocations and after results, comparing each harness against its own planned identity. Distinct verified provider identities invalidate the block; unavailable provider values remain unknown. Public remote content and provider-hidden changes cannot be inferred from equal local hashes.

Compare per-task paired deltas and win/tie/loss using a declared tie rule, pass rates, facet deltas, reliability such as all-pass-across-repeats, duration, and observed usage distributions. Report paired coverage and every omitted pair with its failure reason. Do not selectively retry only a losing arm or claim causality from unmatched historical runs.

For uncertainty, resample task clusters with replacement while keeping paired arms and repeats together; aggregate within task before overall deltas. Record bootstrap seed, resample count, interval method, and analysis revision. The pilot's five tasks and three repeats per arm support descriptive evidence with wide uncertainty, not universal significance or general model rankings. Issue 11 must validate the estimator on known synthetic data and show small-sample limitations.

Reject harness-effect comparisons with incompatible task, suite, environment, runner, verifier, scoring, budget, or uncontrolled stack differences. Regrade both arms to an explicitly shared scoring/verifier revision when appropriate, preserving the original results. Provider-hidden model changes remain a stated limitation.

## Run manifest contract

The v1 Valibot schemas record at least the following, with explicit `unknown` for unavailable provider values. Serialized fields use `snake_case`; every name below is an actual checked-in serialized path.

| Group | Required fields |
| --- | --- |
| Identity | `identity.run_id`, `identity.attempt_id`, `identity.attempt`, `created_at`, `benchmark_repo_commit` |
| Suite and task | `suite.id`, `suite.revision`, `suite.digest`, `task.id`, `task.revision`, `task.base_commit`, `task.source_digest`, `task.environment_image_digest` |
| Verification | `verifier.revision`, `verifier.image_digest`, `verifier.network_enforcement_sidecar_digest`, `scoring_revision` |
| Collection | `collector.revision`, `collector.image_digest`; completion uses `collection.collector_revision`, `collection.collector_image_digest`, `collection.quiescence`, `collection.collection`, `collection.exact_manifest`, and `collection.hashes` |
| Runner | `runner.name`, `runner.version`, `runner.config_digest`, `runner.telemetry`, `runner.requested_concurrency`, `runner.effective_concurrency`, `runner.concurrency_enforcement_status` |
| Agent | `agent.product`, `agent.cli_version`, `agent.requested_model`, `agent.effort`, `agent.auth_mode`, `agent.observed_provider_identity` |
| Harness and policy | `harness.id`, `harness.revision`, `harness.digest`, `network_policy_digest`, `effective_permissions_digest`, `mcp_tools_digest` |
| Budget | `budget.wall_clock_seconds`, `budget.token_or_turn_limit.status`, known `budget.token_or_turn_limit.unit` and `.value`, `budget.cpu_count`, `budget.cpu_enforcement_status`, `budget.memory_megabytes`, `budget.memory_enforcement_status` |
| Experiment | `experiment.experiment_id`, `experiment.experiment_revision`, `experiment.plan_digest`, `experiment.arm_id`, `experiment.block_id`, `experiment.replicate`; plans additionally use `ordering_seed`, `retry_policy`, and each block's `runs[].run_id`, `runs[].arm_id`, `runs[].attempt`, `runs[].selected`, timestamps, completion status, and contemporaneity |
| Retention | `retention.classification`, private `retention.default_days` and `retention.expires_at`, or public `retention.expires_at.status: not_applicable` |
| Host | `host.os`, `host.os_version`, `host.architecture`, `host.apple_silicon_model`, `host.docker_desktop_version`, `host.docker_engine_version`, `host.linuxkit_kernel`, `host.container_architecture` |
| Completion record | `classification`, `termination`, `completed_at`, `initial_manifest_digest`, `valid_grade`, `score_id`, `timings`, `usage`, `raw_artifact_path`, `raw_artifact_manifest_digest` |

Record initial and completion manifests separately, linked by ID/digest. Suite, task, harness, collector, verifier, scoring, network policy, sidecar/image, runner configuration, concurrency enforcement, and analysis revisions are independently versioned. Never overwrite raw artifacts when correcting normalization or grading. Subscription money is `not_applicable` or `unknown`, never API-token price multiplied into a supposed bill.

The score document keeps Harbor numeric rewards as upstream metadata and records facet applicability, evidence, gates, and failures separately. A composite is allowed only for a valid grade with numeric direct-behavior, repository-contract, regression, and scope-integrity facets. A verifier failure has no valid quality score. Runtime cross-document validation additionally checks immutable initial/completion linkage, exact suite/task/stack/harness references, and that a harness-effect comparison changes only the declared harness treatment.

For issue 2 revision `public-1`, freeze two identical sequential invocations with unrestricted agent internet. Concurrency is one and retries are zero. A timeout or infrastructure failure is retained as its own outcome and never triggers another run. Two invocations are the revision's ceiling, not an automatic reset of the old approval. Obtain a new explicit run-card authorization before inference.

The owner changed the experiment objective to realistic internet access on 2026-09-05. Keep the failed restricted-network record and its owner no-go unchanged; do not pool it with the public-network results or claim that removing a requirement proved the former requirement. Public internet permits changing remote content and downloads, so identical inputs do not imply a hermetic or bit-reproducible run. Record observable commands and external dependencies in the native evidence.

Execution qualification: after public-01 started at medium, the owner requested low for public-02. Both completed, but they are not an identical-repeat experiment. The owner accepted this deviation for the temporary issue 2 feasibility gate on 2026-09-05, then explicitly authorized one additional low invocation. Public-03 passed with the same recorded stack settings and byte-identical task inputs as public-02, resolving the missing repeat. Four total invocations are now consumed, including the historical failure; the supplemental root does not renew the budget. This small fixture pair does not relax paired/repeated methodology for later comparisons.

## Human calibration

After issue 6, approve realism, evidence, alternate implementations, and scope grading. After issue 13, inspect a dry run and one authorized subscription canary. After issue 16, freeze the pilot and separate calibration observations from the final comparison. After issue 17, inspect trajectories and patches before accepting findings. Do not retune tasks based on which final harness arm won. A general sealed suite workflow is deferred to M4; manual pilot freezing is required in v1.
