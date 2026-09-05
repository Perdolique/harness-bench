# feat: execute versioned experiment matrices with A/B arms, repeats, and blocked interleaving

<!-- agent-stack-benchmark:planning-issue:10 -->

Planning item: 10 | Milestone: M2 Controlled experiments

## Context

Historical before/after comparisons confound time and provider changes with harness effects.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 10; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Execute immutable experiment plans with arms, repeats, blocked interleaving and safe resume.

## In scope

- Freeze a complete seeded execution plan before any invocation.
- Schedule by task/replicate block with v1 subscription concurrency exactly one and both arms completed within 24 hours of the first arm start.
- Retain attempts and partial results; resume only completed immutable IDs.

## Out of scope

- Statistical estimation, adaptive optimization, distributed scheduling and hidden retries.

## Technical constraints

- Dry-run must show invocation count, budget and full matrix without quota use.
- Changed inputs produce a new plan/revision; never overwrite a previous experiment.
- A known model, CLI, provider, runner, Harbor-config, or harness change invalidates the affected block even inside the 24-hour window.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Experiment definition contains tasks, arms, repeats, ordering seed, budgets, and stack/harness references.
- [ ] Old and new harness arms are run contemporaneously.
- [ ] Scheduling is blocked/interleaved by task and replicate, not all A then all B.
- [ ] Default subscription concurrency is one.
- [ ] V1 records requested/effective concurrency and enforcement status and rejects any subscription value other than one.
- [ ] Each block records first-start, deadline, completion, contemporaneity status, and invalidation reason.
- [ ] An expired window or known stack/provider change retains both attempts but excludes the block from causal comparison and requires a complete rerun with new IDs.
- [ ] Resume skips only completed immutable run IDs.
- [ ] A plan file records complete execution order before the first run.
- [ ] Partial experiments remain reportable.
- [ ] Dry-run displays the full matrix and estimated number of agent invocations.

## Test/evidence plan

- Use fake runs to prove seeded order, interleaving, partial reporting and exact resume behavior.
- Interrupt between attempts; incomplete/failed IDs must not masquerade as completed runs.
- Cross the 24-hour boundary and inject each known-change class; require block invalidation and full-block rescheduling rather than selective retry.
- Assert no real provider call occurs in CI.

## Documentation changes

- docs/operations.md matrix/dry-run/resume workflow; docs/methodology.md ordering and retry policy.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
<!-- dependencies:end -->

## Risks/open questions

- Provider availability varies over time even with pairing; document blocked runs and coverage.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
