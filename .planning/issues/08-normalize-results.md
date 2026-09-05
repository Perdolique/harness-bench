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
- Validate the exact staged filesystem inventory and implement declared private-record expiry and redacted deletion tombstones.

## Out of scope

- Rewriting source results, fabricating subscription cost, reports, or supporting arbitrary unknown Harbor versions.

## Technical constraints

- Record upstream estimated cost as provenance only; subscription monetary cost is not applicable/unknown.
- Artifact collection must be complete and trusted before marking a grade valid.
- Secrets must be excluded before durable raw retention, not only scrubbed from public reports.
- Reject reserved manifest-name collisions, including any nested `sha256-manifest.json`, rather than silently omitting them from inventory.
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
- [ ] A positive credential sentinel restricts the record and produces owner-response state for rotation/revocation and declared deletion or incident retention, without copying secret bytes.
- [ ] Every private task/run has an explicit retention deadline defaulting to 90 days; expiry or owner deletion removes private bytes and leaves an immutable safe intent-linked tombstone.
- [ ] Exact inventory validation rejects reserved-name collisions and any staged entry missing from the manifest.

## Test/evidence plan

- Parse sanitized fixtures from the exact supported Harbor revision, including absent tokens and merged log events.
- Reject incompatible formats, mutated hashes, missing/failed/skipped collection entries and unsafe export content.
- Reject a nested reserved manifest name and prove deletion tombstones contain identifiers, safe provenance, timestamps, and reason but no source, prompt, trajectory, or secret bytes.
- Assert normalization leaves every original byte/hash unchanged.

## Documentation changes

- docs/architecture.md normalized/raw boundary; docs/operations.md retention and supported formats.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
<!-- dependencies:end -->

## Risks/open questions

- ATIF conversion may be lossy; retain native output as the evidence source.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
