# docs: finalize architecture ADRs and threat model from feasibility evidence

<!-- agent-stack-benchmark:planning-issue:03 -->

Planning item: 3 | Milestone: M0 Feasibility

## Context

Bootstrap ADRs are proposed decisions supported by source research; they are not accepted runtime architecture.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 3; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Finalize the five ADRs and threat model from the accepted feasibility evidence.

## In scope

- Resolve every proposed decision against actual spike evidence and owner review.
- Document the effective auth, network, collection, verifier and logging boundaries.
- Record accepted limitations and fallback triggers without replacing failed evidence with assumptions.

## Out of scope

- Runtime implementation, production schemas, another spike, and adding a fallback dependency without its own accepted issue/ADR.

## Technical constraints

- A source-supported feature is not evidence of successful operation on WSL/Docker.
- Preserve separate offline verification and immutable records regardless of the selected adapter.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] ADR: Harbor as execution kernel.
- [ ] ADR: TypeScript control plane.
- [ ] ADR: separate verifier and artifact boundary.
- [ ] ADR: local ChatGPT subscription authentication.
- [ ] ADR: raw artifacts as immutable source of truth.
- [ ] Security document covers credentials, source-code leakage, network, hidden tests, malicious patches, logs, and local host exposure.
- [ ] Each decision references evidence from the spike rather than assumptions.
- [ ] Pier/custom adapter fallback criteria are explicit.

## Test/evidence plan

- Trace each decision and threat mitigation to exact spike commands and retained evidence/digests.
- Check consistency across architecture, operations, methodology, task authoring, issues and all five ADRs.
- Confirm issue 2 owner acceptance is recorded; otherwise this issue remains blocked.

## Documentation changes

- All five docs/adr/ records and index; docs/architecture.md, docs/security.md, docs/operations.md, docs/research-snapshot.md.

## Dependencies/blockers with links

<!-- dependencies:start -->
- Blocked by [planning issue 2 / GitHub #2](https://github.com/Perdolique/harness-bench/issues/2).
- Required gate: [planning issue 2](https://github.com/Perdolique/harness-bench/issues/2) must be green and explicitly accepted by the owner.
<!-- dependencies:end -->

## Risks/open questions

- Any unresolved feasibility requirement blocks acceptance rather than becoming a hidden assumption.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
