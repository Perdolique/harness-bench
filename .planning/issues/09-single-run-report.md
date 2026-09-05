# feat: render a terminal report for one run

<!-- agent-stack-benchmark:planning-issue:09 -->

Planning item: 9 | Milestone: M1 Vertical-slice MVP

## Context

A single run must be inspectable before a comparison can be meaningful.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 9; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Render a terminal report with identities, facets, reliability context and artifact paths.

## In scope

- Show complete stack/harness/task revisions and applicable score dimensions.
- Show direct/regression gates, scope violations, elapsed time and available usage.
- Provide local paths to manifest, patch, trajectory and verifier logs.

## Out of scope

- Dashboard, experiment statistics, scalar-only leaderboard and fabricated subscription cost.

## Technical constraints

- Distinguish a valid zero from an invalid grade or infrastructure failure.
- Unknown/not-applicable data must be visible and preserve numeric zero when observed.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Shows stack/harness/task identities and revisions.
- [ ] Shows direct behavior, repository contracts, regression, scope integrity, and composite.
- [ ] Distinguishes zero score from infrastructure failure.
- [ ] Shows time and available usage without inventing subscription monetary cost.
- [ ] Links/prints local paths to patch, trajectory, verifier logs, and manifest.
- [ ] Snapshot tests cover success, task failure, and infrastructure failure.

## Test/evidence plan

- Snapshot success, task-quality failure, missing facets and infrastructure failure.
- Verify emitted paths point to retained fixtures and no invalid composite/cost is invented.

## Documentation changes

- docs/operations.md report usage and interpretation; methodology examples.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
<!-- dependencies:end -->

## Risks/open questions

- A convenience composite must not obscure contract facets or invalid evidence.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
