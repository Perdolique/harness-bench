# feat: static HTML/web dashboard over normalized experiment data

<!-- agent-stack-benchmark:planning-issue:19 -->

Planning item: 19 | Milestone: M4 Hardening and expansion

## Context

A terminal report may become cumbersome once pilot comparisons are useful.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 19; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Generate one local static HTML report from normalized experiment data.

## In scope

- Render identities, facets, paired uncertainty and artifact references from existing normalized records.
- Support local static viewing with explicit sanitized export.

## Out of scope

- Hosted service, authentication system, live cloud ingestion, a new scoring engine and automatic publication.

## Technical constraints

- No credentials/private raw source embedded in HTML; raw records stay immutable.
- No agent execution is triggered by report viewing.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Static output preserves score facets and failure distinctions.
- [ ] Incompatible comparisons are rejected consistently with the terminal report.
- [ ] Untrusted content is escaped and export scan passes.
- [ ] No provider call, verifier change or raw mutation occurs.

## Test/evidence plan

- Render sanitized success/failure/partial experiment fixtures and validate escaped untrusted content.
- Confirm facet/applicability and revision compatibility match terminal output.

## Documentation changes

- docs/operations.md local generation/export and report limitations.

## Dependencies/blockers with links

<!-- dependencies:start -->
- Blocked by [planning issue 11 / GitHub #11](https://github.com/Perdolique/harness-bench/issues/11).
- Blocked by [planning issue 13 / GitHub #13](https://github.com/Perdolique/harness-bench/issues/13).
- Blocked by [planning issue 17 / GitHub #17](https://github.com/Perdolique/harness-bench/issues/17).
- Outside the v1 critical path. Owner pilot review after [planning issue 17](https://github.com/Perdolique/harness-bench/issues/17) must justify this work before it starts.
<!-- dependencies:end -->

## Risks/open questions

- Untrusted task text or paths must not execute as HTML or leak private artifacts.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
