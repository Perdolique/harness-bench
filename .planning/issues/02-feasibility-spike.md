# spike: prove Harbor + native Codex subscription + separate verifier end to end

<!-- agent-stack-benchmark:planning-issue:02 -->

Planning item: 2 | Milestone: M0 Feasibility

## Context

The required native subscription workflow and trustworthy collector have not been demonstrated. Source inspection found sandbox bypass, merged stderr/stdout, best-effort cleanup/collection, and warning-only main-stop failures.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 2; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Prove the complete Harbor/native Codex/subscription/independent-artifact/offline-verifier path with the smallest disposable fixture.

## In scope

- Use one fixed synthetic task and pinned Harbor 0.22.0 / Codex 0.153.0 candidates, recording any justified pin change.
- Discover login files, refresh behavior, and required hosts from current official behavior with a dedicated external login.
- Exercise non-cooperative output collection, a separate verifier, and two repeated native runs.
- Keep experimental code under spikes/ unless deliberately promoted; write a go/no-go evidence report.

## Out of scope

- Production schemas, reusable orchestration framework, dashboards, real private tasks, automatic provider purchases, and any issue 4–13 implementation.

## Technical constraints

- No guessed auth files/hosts and no ambient user home mount; explicit CODEX_AUTH_JSON_PATH is a researched interface, not proof.
- Verifier starts from the same base with no network/credentials; hidden tests and reference solution remain absent from agent access.
- Harbor owns lifecycle. A sidecar collector is only a candidate and must use a trusted baseline/tooling independent of agent Git metadata.
- Retain native traces as well as ATIF; prove actual effective harness/config/permission behavior.
- Owner-authorized local subscription runs only; no such run in ordinary CI.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Exact Harbor and Codex CLI versions are pinned and printed in the run record.
- [ ] Harbor telemetry is disabled for the spike and the effective setting is recorded.
- [ ] A documented one-time local login flow uses a dedicated credential directory outside the repository.
- [ ] A fresh ephemeral Codex home/config is assembled per run.
- [ ] A minimal task runs through Harbor using native Codex and ChatGPT subscription auth.
- [ ] Agent network access is measured and reduced to a documented allowlist, or the unresolved blocker is proven with logs.
- [ ] The agent modifies a fixed synthetic repository.
- [ ] The resulting change is collected without trusting the agent to report success.
- [ ] A fresh separate verifier applies the change.
- [ ] Verifier has no network, no credentials, no hidden-test exposure to the agent.
- [ ] The base snapshot fails the task-specific verifier.
- [ ] A known-good patch passes.
- [ ] At least two repeated agent runs are retained.
- [ ] Trajectory, stdout/stderr, patch/artifacts, timings, termination reason, and available usage data are saved.
- [ ] `docs/spikes/harbor-codex-subscription.md` records exact commands, observed required hosts, security caveats, failures, and a go/no-go conclusion.
- [ ] Experimental code is either promoted deliberately or isolated under `spikes/`; no premature framework abstraction.
- [ ] Fail closed when required artifact collection or main-stop evidence is missing, failed, or conflicted.
- [ ] Demonstrate full effective harness loading and record upstream flag overrides, including sandbox behavior.
- [ ] Obtain an explicit owner go/no-go after the evidence report. If not green, stop issues 4–13 and open a narrow fallback issue plus ADR: Harbor adapter, host-managed Codex with Harbor verification, then Pier evaluation.

## Test/evidence plan

- Show pristine direct-check failure, existing regression success, and known-good patch success with verifier network denied.
- Retain at least two agent runs; inspect logs/events, changes, available usage, timing, termination, manifests and score.
- Probe credential/hidden-file exposure, network rejection, uncommitted/untracked/binary edits, mutable .git, lingering processes, failed stop/collection, and artifact path collisions.
- Use dummy sentinels to prove secret exclusion before durable artifact retention without printing real credentials.
- Record WSL/kernel/Docker details and refresh/cleanup behavior; source code alone cannot satisfy a criterion.

## Documentation changes

- docs/spikes/harbor-codex-subscription.md with exact commands, observed hosts, evidence locations/digests, failures and decision; update research/security/operations.

## Dependencies/blockers with links

<!-- dependencies:start -->
- Blocked by [planning issue 1 / GitHub #1](https://github.com/Perdolique/harness-bench/issues/1).
<!-- dependencies:end -->

## Risks/open questions

- R1–R6 in docs/research-snapshot.md remain open; read-only auth may conflict with token refresh.
- The upstream adapter may not preserve the daily sandbox semantics or enough stderr/event fidelity; do not claim equivalence without evidence.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
