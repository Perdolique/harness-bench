# research: evaluate Pier trajectory fidelity against current Harbor

<!-- agent-stack-benchmark:planning-issue:26 -->

Planning item: 26 | Milestone: M4 Hardening and expansion

## Context

Pier is a fallback, not a second v1 dependency; this post-pilot research evaluates whether a proven fidelity gap justifies change.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 26; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Compare one pinned Pier candidate against the pinned Harbor baseline for a concrete trajectory gap.

## In scope

- Define a narrow fidelity checklist from observed Harbor limitations.
- Inspect current official Pier sources and a disposable synthetic replay/canary if explicitly authorized.
- Record native events, usage, failure classification, artifacts and separate-verifier support.

## Out of scope

- Installing both kernels into v1, migration implementation, generic adapter platform and private task exposure.

## Technical constraints

- If the pre-v1 spike fails, open a separate narrowly scoped fallback issue/ADR at that time; this M4 issue does not waive the gate.
- No candidate is acceptable if it weakens offline verification or immutable retention.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Pinned sources and the exact fidelity question are recorded.
- [ ] A comparison table links each claim to observed or source-only evidence.
- [ ] Decision explicitly preserves separate verifier and immutable results.
- [ ] No kernel migration/dependency is introduced without a follow-up accepted decision.

## Test/evidence plan

- Use deterministic traces and compare event coverage, loss and provenance.
- Report unsupported behavior and native canary authorization separately from source inspection.

## Documentation changes

- Pier fidelity research report and accept/reject ADR, updated research snapshot.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
- Outside the v1 critical path. Owner pilot review after [planning issue 17](https://github.com/Perdolique/harness-bench/issues/17) must justify this work before it starts.
<!-- dependencies:end -->

## Risks/open questions

- Pier version, capabilities and measurable advantage are unknown; do not assume equivalence.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
