# spike: prove Harbor + native Codex subscription + separate verifier end to end

<!-- agent-stack-benchmark:planning-issue:02 -->

Planning item: 2 | Milestone: M0 Feasibility

## Context

At issue creation, the native subscription workflow and trustworthy collector were unproved. The spike now demonstrates the public-network path with the qualifications below. Source inspection found sandbox bypass, merged stderr/stdout, best-effort cleanup/collection, and warning-only main-stop failures. The owner selected macOS Apple Silicon with Docker Desktop Linux/arm64 containers as the v1 target; the original WSL2 bootstrap target is historical only.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 2; docs/research-snapshot.md and the accepted ADRs constrain implementation.

The owner recorded no-go for the earlier restricted-network protocol, then selected unrestricted agent internet on 2026-09-05. Revision `public-1` replaces the discovery and allowlist requirements. Preserve the earlier raw failure; do not open a fallback issue merely to repair the retired requirement. Native runs need a new redacted run-card approval, followed by a separate owner gate. Both approvals were obtained; the owner accepted qualified go on 2026-09-05. Issue 3 is not started.

## Goal

Current evidence: all three authorized public-network runs completed with all four reward facets equal to 1, clean secret scans, successful independent collection, and separate offline verification. The owner requested low effort while the first medium run was already active, so those first samples were not identical repeats. After qualified go on 2026-09-05, the owner explicitly authorized one additional low invocation. Public-02 and public-03 now demonstrate the matching-input repeat criterion: recorded stack settings and materialized task files are identical. The earlier missing-repeat qualification is resolved. Git-free workspace behavior, auth refresh, merged native streams, and public-network risks remain inputs for issue 3; this is not production readiness or a comparative study. All four subscription invocations including the historical failure and the separately approved one-call extension are consumed; no further call is authorized. See docs/spikes/harbor-codex-subscription.md for the immutable-record hashes, native evidence, usage, observed Git-workspace limitation, and exact commands.

Prove the complete Harbor/native Codex/subscription/independent-artifact/offline-verifier path with the smallest disposable fixture.

## In scope

- Use one fixed synthetic task with Harbor 0.22.0, Codex 0.153.2, `gpt-5.6-luna`, and initially `medium`, then owner-requested `low` effort.
- Discover login files, refresh behavior, and native-client requirements from current official behavior with a dedicated external login.
- Exercise two identical public-network native runs, non-cooperative output collection, and a separate verifier.
- Keep experimental code under spikes/ unless deliberately promoted; write a go/no-go evidence report.

## Out of scope

- Production schemas, reusable orchestration framework, dashboards, real private tasks, automatic provider purchases, and any issue 4–13 implementation.

## Technical constraints

- Target macOS Apple Silicon plus Docker Desktop Linux/arm64 only. Do not claim Intel Mac, WSL2, or arbitrary Docker-host compatibility.
- No guessed auth files/hosts and no ambient user home mount; require explicit external `CODEX_AUTH_JSON_PATH` and `BENCH_RUN_ROOT`.
- Verifier starts from the same base with no network/credentials; hidden tests and reference solution remain absent from agent access.
- Harbor owns lifecycle. A sidecar collector is only a candidate and must use a trusted baseline/tooling independent of agent Git metadata.
- Retain native traces as well as ATIF; prove actual effective harness/config/permission behavior.
- Owner-authorized local subscription runs only: two initial public-network invocations plus one separately authorized low confirmation, sequentially, with concurrency one, zero retries, and no fallback model. Login is outside this invocation limit. All four calls including the historical failure are consumed.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Exact Harbor and Codex CLI versions are pinned and printed in the run record.
- [ ] Harbor telemetry is disabled for the spike and the effective setting is recorded.
- [ ] A documented one-time local login flow uses a dedicated credential directory outside the repository.
- [ ] A fresh ephemeral Codex home/config is assembled per run.
- [ ] The macOS version, Apple Silicon architecture, Docker Desktop/Engine versions, LinuxKit kernel, container architecture, and exact local image IDs are retained.
- [ ] The actual Docker Desktop Linux VM passes public-agent HTTPS and separate offline-verifier lifecycle controls.
- [ ] A minimal task runs through Harbor using native Codex and ChatGPT subscription auth.
- [ ] Agent internet access is unrestricted during setup and execution, with no allowlist, egress proxy, or packet observer.
- [ ] The agent modifies a fixed synthetic repository.
- [ ] The resulting change is collected without trusting the agent to report success.
- [ ] A fresh separate verifier applies the change.
- [ ] Verifier has no network, no credentials, no hidden-test exposure to the agent.
- [ ] The base snapshot fails the task-specific verifier.
- [ ] A known-good patch passes.
- [ ] Two identical public-network agent runs are retained without automatic retry under revision public-1.
- [ ] Native JSONL, ATIF, Harbor merged `codex.txt`, trial log, patch/artifacts, timings, termination reason, and available usage data are saved; irreversible stdout/stderr merging is reported as a limitation rather than reconstructed.
- [ ] `docs/spikes/harbor-codex-subscription.md` records exact commands, public/offline network evidence, security caveats, failures, and a go/no-go conclusion.
- [ ] Experimental code is either promoted deliberately or isolated under `spikes/`; no premature framework abstraction.
- [ ] Fail closed when required artifact collection or main-stop evidence is missing, failed, or conflicted.
- [ ] Demonstrate full effective harness loading and record upstream flag overrides, including sandbox behavior.
- [x] Obtain an explicit owner go/no-go after the evidence report. If not green, stop issues 4–13 and open a narrow fallback issue plus ADR: Harbor adapter, host-managed Codex with Harbor verification, then Pier evaluation.

## Test/evidence plan

- Show pristine direct-check failure, existing regression success, and known-good patch success with verifier network denied.
- Retain two identical public-network agent runs; inspect logs/events, changes, available usage, timing, termination, manifests and score.
- Probe credential/hidden-file exposure, public agent access and offline verifier rejection, uncommitted/untracked/binary edits, mutable .git, lingering processes, failed stop/collection, and artifact path collisions.
- Use dummy sentinels to prove secret exclusion before durable artifact retention without printing real credentials.
- Record macOS/Apple Silicon/Docker Desktop/LinuxKit details and refresh/cleanup behavior; source code alone cannot satisfy a criterion.

## Documentation changes

- docs/spikes/harbor-codex-subscription.md with exact commands, public/offline network evidence, evidence locations/digests, failures and decision; update research/security/operations.

## Dependencies/blockers with links

<!-- dependencies:start -->
- Satisfied by closed and merged [planning issue 1 / GitHub #1](https://github.com/Perdolique/harness-bench/issues/1).
<!-- dependencies:end -->

## Risks/open questions

- Issue 3 must review R1–R6 against the retained native evidence and qualified owner go; auth refresh was not exercised and may change the dedicated external file.
- The upstream adapter may not preserve the daily sandbox semantics or enough stderr/event fidelity; do not claim equivalence without evidence.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
