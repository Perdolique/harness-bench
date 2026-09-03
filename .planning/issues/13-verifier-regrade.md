# feat: support verifier-only regrade and scoring revision migration

<!-- agent-stack-benchmark:planning-issue:13 -->

Planning item: 13 | Milestone: M2 Controlled experiments

## Context

Grading corrections must not require another Codex run or overwrite previous results.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 13; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Add verifier-only regrade with explicit scoring/verifier lineage and compatible reporting.

## In scope

- Invoke the supported Harbor single-step regrade path over retained declared artifacts.
- Create new results and complete source/config/lock/revision provenance.
- Regenerate comparable reports with explicit new scoring/verifier identities.

## Out of scope

- Agent reruns, invented missing artifacts, in-place result edits and general multi-step migration support.

## Technical constraints

- Verifier remains separate, offline and credential-free.
- Retain source agent identity/usage without counting regrade as another provider invocation.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Regrade uses retained agent artifacts without another provider call.
- [ ] Original and new verifier/scoring revisions remain distinguishable.
- [ ] Raw original results are never overwritten.
- [ ] Comparison report prevents accidental mixing.
- [ ] Migration/regrade provenance is complete.
- [ ] Demonstration changes one scoring rule and regenerates a report without rerunning Codex.
- [ ] After completion, stop for the MVP owner gate: a complete local dry run plus one explicitly authorized subscription canary, reviewed before issue 14/private import.

## Test/evidence plan

- Change one deterministic scoring rule and regenerate the report with zero provider calls.
- Reject missing/hash-mutated/incompatible artifacts and accidental mixed revisions.
- Assert original raw file hashes remain identical.

## Documentation changes

- docs/operations.md regrade recipe and provenance; docs/methodology.md comparison migration rules.

## Dependencies/blockers with links

<!-- dependencies:start -->
- Blocked by [planning issue 8 / GitHub #8](https://github.com/Perdolique/harness-bench/issues/8).
- Blocked by [planning issue 11 / GitHub #11](https://github.com/Perdolique/harness-bench/issues/11).
- Blocked by [planning issue 12 / GitHub #12](https://github.com/Perdolique/harness-bench/issues/12).
<!-- dependencies:end -->

## Risks/open questions

- Harbor regrade requires completed single-step source records and compatible declared inputs.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
