# feat: import and freeze a task from a real repository commit or merged PR

<!-- agent-stack-benchmark:planning-issue:14 -->

Planning item: 14 | Milestone: M3 Pilot benchmark

## Context

Real work requires immutable source provenance without exposing private code or future solutions.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 14; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Import and freeze one explicit local repository base into an authorable task artifact.

## In scope

- Accept a local repository and exact base commit, optionally identifying a merged PR as provenance.
- Remove future history and freeze source/environment artifacts.
- Scan obvious secrets and support external private task storage with manual hidden-check authoring.

## Out of scope

- Automatic hidden-test generation, moving-branch runtime clones, public upload and five-task calibration.

## Technical constraints

- No private remote credentials in metadata and no private source in the benchmark source repository.
- Import starts only after the issue 13 dry-run/canary owner gate.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Accepts a local repository and explicit base commit.
- [ ] Removes future history from the agent-visible snapshot.
- [ ] Builds an immutable local task/environment artifact; no runtime clone from a moving branch.
- [ ] Detects obvious secrets before snapshotting.
- [ ] Records provenance without embedding private remote credentials.
- [ ] Provides a manual authoring workflow rather than pretending hidden tests can be generated perfectly.
- [ ] Supports keeping private task data outside the benchmark source repository.

## Test/evidence plan

- Import a local fixture with future commits and sensitive sentinels; verify history absence and safe rejection.
- Check reproducible snapshot digest, fixed-base provenance and no runtime fetch.
- Inspect private output paths and confirm no provider call.

## Documentation changes

- docs/task-authoring.md import/freeze/manual authoring; docs/security.md provenance handling.

## Dependencies/blockers with links

<!-- dependencies:start -->
- Blocked by [planning issue 13 / GitHub #13](https://github.com/Perdolique/harness-bench/issues/13).
- Required gate: owner dry-run and subscription-canary review after [planning issue 13](https://github.com/Perdolique/harness-bench/issues/13).
<!-- dependencies:end -->

## Risks/open questions

- Owner permission to process a particular private repository must be established before its import.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
