# content: author and calibrate the first five real benchmark tasks

<!-- agent-stack-benchmark:planning-issue:16 -->

Planning item: 16 | Milestone: M3 Pilot benchmark

## Context

A calibrated pilot needs several realistic tasks without learning from final arm outcomes.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 16; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Author and calibrate the first five real tasks across at least three task categories.

## In scope

- Build five small tasks using the accepted import/rubric workflows.
- Supply realistic prompts, direct/regression/scope checks and evidence-backed implicit contracts.
- Document ambiguity, difficulty, alternate implementations and frozen suite identities.

## Out of scope

- New benchmark infrastructure, a broad public registry, final harness comparison and tuning based on sealed results.

## Technical constraints

- Use owner-authorized source and keep private task data external.
- Each task is a small application of existing tooling; infrastructure changes require a separate issue.
- Do not run Codex in ordinary CI.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Five tasks represent at least three task categories.
- [ ] Each has a short realistic prompt.
- [ ] Each has direct checks, regression checks, scope checks, and only evidence-backed implicit contracts.
- [ ] Pristine base fails; reference patch passes.
- [ ] At least one alternate implementation is tested for each task where practical.
- [ ] Tasks pass `benchctl doctor`.
- [ ] Task difficulty and known ambiguities are documented.
- [ ] No task is tuned using the sealed final experiment result.
- [ ] Record owner acceptance of the frozen pilot suite before issue 17 begins.

## Test/evidence plan

- For every task retain base-fails/reference-passes and regression evidence.
- Try at least one alternate valid implementation where practical, documenting any exception.
- Run doctor for every task and repeat deterministic verification.
- Obtain owner review and freeze suite/task/verifier/scoring revisions before final experiment outcomes are visible.

## Documentation changes

- docs/task-authoring.md pilot catalog, calibration notes and freeze procedure; external private catalog where necessary.

## Dependencies/blockers with links

<!-- dependencies:start -->
- Blocked by [planning issue 14 / GitHub #14](https://github.com/Perdolique/harness-bench/issues/14).
- Blocked by [planning issue 15 / GitHub #15](https://github.com/Perdolique/harness-bench/issues/15).
<!-- dependencies:end -->

## Risks/open questions

- Source availability and task complexity may exceed one session; if so, split per-task content follow-ups before work instead of broadening infrastructure.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
