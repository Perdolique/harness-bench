# feat: normalize Harbor outputs while preserving immutable raw records

<!-- agent-stack-benchmark:planning-issue:08 -->

Planning item: 8 | Milestone: M1 Vertical-slice MVP

## Context

Harbor data and derived results need an explicit version boundary without losing original evidence.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 8; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Normalize supported Harbor outputs while preserving immutable raw records.

## In scope

- Retain/hash raw directories and native/ATIF trajectory references.
- Normalize facets, applicability, statuses, timing, usage and provenance.
- Scan capture/export boundaries and produce separate sanitized derived records.

## Out of scope

- Rewriting source results, fabricating subscription cost, reports, or supporting arbitrary unknown Harbor versions.

## Technical constraints

- Record upstream estimated cost as provenance only; subscription monetary cost is not applicable/unknown.
- Artifact collection must be complete and trusted before marking a grade valid.
- Secrets must be excluded before durable raw retention, not only scrubbed from public reports.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Raw Harbor job directory is copied or referenced immutably and never rewritten.
- [ ] Normalized run result contains score facets, status, timings, available usage, artifact paths, and trajectory references.
- [ ] Parser tolerates explicitly supported Harbor output versions and fails loudly on unknown incompatible versions.
- [ ] Hashes detect accidental mutation.
- [ ] Secret/redaction scan runs before a result is marked publishable.
- [ ] Unit tests use checked-in sanitized fixtures.

## Test/evidence plan

- Parse sanitized fixtures from the exact supported Harbor revision, including absent tokens and merged log events.
- Reject incompatible formats, mutated hashes, missing/failed/skipped collection entries and unsafe export content.
- Assert normalization leaves every original byte/hash unchanged.

## Documentation changes

- docs/architecture.md normalized/raw boundary; docs/operations.md retention and supported formats.

## Dependencies/blockers with links

<!-- dependencies:start -->
- Blocked by [planning issue 7 / GitHub #7](https://github.com/Perdolique/harness-bench/issues/7).
<!-- dependencies:end -->

## Risks/open questions

- ATIF conversion may be lossy; retain native output as the evidence source.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
