# feat: add code-review benchmark task type and finding matcher

<!-- agent-stack-benchmark:planning-issue:22 -->

Planning item: 22 | Milestone: M4 Hardening and expansion

## Context

Patch-task methodology must stabilize before grading review findings.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 22; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Add one deterministic review-task fixture and a justified finding-matching contract.

## In scope

- Define supported finding fields and evidence-backed ground-truth locations/behavior.
- Match equivalent valid findings without demanding exact prose.
- Calibrate one small review task with positive/negative finding controls.

## Out of scope

- LLM judges, a review benchmark registry, multi-step conversations and grading only text similarity.

## Technical constraints

- Hidden ground truth stays verifier-only; matcher executes separately offline.
- Preserve precision/recall-like facets and false-positive evidence instead of one opaque score.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] One documented review-task format and canonical fixture exist.
- [ ] Equivalent valid findings pass while incorrect/unsupported findings fail.
- [ ] Hidden ground truth and matcher stay outside agent visibility.
- [ ] Results/regrades preserve immutable raw findings and verifier/scoring revisions.

## Test/evidence plan

- Use equivalent wording/locations plus false-positive/missed-finding fixtures.
- Show deterministic grades and no ground-truth leakage.

## Documentation changes

- docs/task-authoring.md review task format; docs/methodology.md finding facets and ambiguity.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
- Outside the v1 critical path. Owner pilot review after [planning issue 17](https://github.com/Perdolique/harness-bench/issues/17) must justify this work before it starts.
<!-- dependencies:end -->

## Risks/open questions

- Equivalent findings and partially correct findings need explicit task-specific matching rules.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] Work stays within the authorized outcome, including small required fixes; unrelated work is deferred.
- [ ] Material assumptions and relevant owner decisions are recorded under the current development policy in CONTRIBUTING.md and docs/roadmap.md.
- [ ] Credentials, private source, offline verification, and immutable raw evidence retain their existing protections.
