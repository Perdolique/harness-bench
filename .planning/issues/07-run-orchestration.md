# feat: implement benchctl run over pinned Harbor

<!-- agent-stack-benchmark:planning-issue:07 -->

Planning item: 7 | Milestone: M1 Vertical-slice MVP

## Context

The accepted spike and canonical task now provide concrete inputs for a thin control-plane invocation.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 7; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Implement one benchctl run over the pinned Harbor executable.

## In scope

- Resolve a stack/harness/task or suite selection and explicit budgets.
- Create unique immutable initial and separate completion records and invoke Harbor.
- Support dry-run, stage-specific failures, cancellation and v1 subscription concurrency exactly one.

## Out of scope

- Experiment matrices, statistics, custom container lifecycle, a second adapter/provider, and automatic paid invocations in tests.

## Technical constraints

- Keep Harbor ownership and the proven collection/verifier boundaries intact.
- Never log credentials; enforce effective telemetry off by default.
- A failed/missing artifact or verifier is not task-quality zero.
- Loss of trustworthy collection or separate verification is fail-closed; no fallback may continue through the lost property.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] `benchctl run` resolves one stack, harness, suite/task, and budget.
- [ ] It invokes the pinned Harbor executable without duplicating Harbor lifecycle logic.
- [ ] It creates a unique run directory and immutable initial manifest.
- [ ] It handles success, agent failure, verifier failure, timeout, cancellation, and infrastructure failure distinctly.
- [ ] It never logs credentials.
- [ ] Default concurrency for subscription runs is one.
- [ ] V1 rejects requested or effective subscription concurrency other than one and records enforcement status.
- [ ] Successful quiescence, trusted collection, exact manifest, and verified hashes are required before a grade is valid.
- [ ] Dry-run prints the resolved plan without starting an agent.
- [ ] Integration test uses a deterministic fake agent or reference solution and does not consume provider quota.

## Test/evidence plan

- Use a deterministic fake agent/reference solution to cover success and failure outcomes without quota.
- Exercise timeout, cancellation, provider/runner/verifier/infrastructure errors and incomplete artifacts.
- Prove stop/collection/manifest/hash and separate-verifier failures stop grading without fallback.
- Verify dry-run starts no environment/agent and immutable inputs remain unchanged.

## Documentation changes

- docs/operations.md run/dry-run examples and failure recovery; architecture ownership.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
- Required gate: owner calibration review after [planning issue 6](https://github.com/Perdolique/harness-bench/issues/6).
<!-- dependencies:end -->

## Risks/open questions

- Subprocess exit status may not identify provider cause; preserve raw evidence and unknown causes.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
