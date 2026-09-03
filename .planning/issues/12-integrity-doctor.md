# feat: add benchctl doctor for task, verifier, environment, and harness integrity

<!-- agent-stack-benchmark:planning-issue:12 -->

Planning item: 12 | Milestone: M2 Controlled experiments

## Context

Bad tasks or untrusted environments can produce misleading scores even when orchestration works.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 12; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Implement benchctl doctor for task, verifier, environment and harness integrity.

## In scope

- Validate Harbor structure, image/dependency pins and artifact interfaces.
- Run deterministic base/reference controls and offline verifier checks.
- Inspect hidden-file/credential isolation, scope violations and evidence integrity.

## Out of scope

- Calling Codex, automatically fixing tasks, suppressing actionable failures, and a full mutation framework.

## Technical constraints

- Doctor must consume no provider quota.
- Differentiate actionable failures from informational warnings; never downgrade a broken trust boundary.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Checks required Harbor task structure and pinned images/dependencies.
- [ ] Confirms pristine base fails the task-specific direct checks.
- [ ] Confirms reference solution passes.
- [ ] Confirms verifier runs with no network.
- [ ] Confirms credentials are absent.
- [ ] Confirms hidden tests/reference solution are absent from agent-visible filesystem.
- [ ] Confirms deterministic verifier result across repeated runs.
- [ ] Detects deletion/disablement of tests and forbidden-file edits.
- [ ] Reports actionable failures and non-actionable warnings separately.

## Test/evidence plan

- Use deliberately malformed tasks, exposed sentinel secrets/tests, mutable image refs and unsafe artifact paths.
- Detect base unexpectedly passing, reference failing, verifier nondeterminism, network access, disabled checks and forbidden edits.
- Use local deterministic controls on the proven Docker target with no provider credentials.

## Documentation changes

- docs/task-authoring.md doctor workflow; docs/operations.md actionable diagnostics.

## Dependencies/blockers with links

<!-- dependencies:start -->
- Blocked by [planning issue 6 / GitHub #6](https://github.com/Perdolique/harness-bench/issues/6).
- Blocked by [planning issue 7 / GitHub #7](https://github.com/Perdolique/harness-bench/issues/7).
- Blocked by [planning issue 8 / GitHub #8](https://github.com/Perdolique/harness-bench/issues/8).
<!-- dependencies:end -->

## Risks/open questions

- A static file scan alone cannot establish runtime network denial or hidden-file isolation.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
