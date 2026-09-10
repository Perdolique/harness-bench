# feat: evaluate remote sandbox/executor backends

<!-- agent-stack-benchmark:planning-issue:25 -->

Planning item: 25 | Milestone: M4 Hardening and expansion

## Context

Remote execution is outside v1 and should be considered only after a local pilot demonstrates value.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 25; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Evaluate one owner-selected Harbor-supported remote executor with a documented go/no-go.

## In scope

- Compare one provider against the local baseline using a synthetic deterministic task.
- Document image pinning, network denial, artifact trust, cleanup, privacy and actual billing dimensions.

## Out of scope

- Distributed scheduler, production migration, new sandbox platform, multiple-provider integration and private task upload.

## Technical constraints

- Owner selection/access and any metered remote execution must be explicit.
- Reject candidates that cannot preserve separate offline verification and immutable evidence.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] One bounded candidate report includes reproducible evidence and explicit go/no-go.
- [ ] No remote execution is enabled as default.
- [ ] Separate-verifier and immutable-result invariants are checked, not waived.
- [ ] No actual private data/provider inference is used without explicit authorization.

## Test/evidence plan

- Use a fake agent/reference patch and repeat isolation/network/collection probes.
- Record current official capabilities, costs if observed, failure evidence and decision.

## Documentation changes

- Remote-executor evaluation report and ADR; docs/security.md exposure comparison.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
- Outside the v1 critical path. Owner pilot review after [planning issue 17](https://github.com/Perdolique/harness-bench/issues/17) must justify this work before it starts.
<!-- dependencies:end -->

## Risks/open questions

- Provider, account, region, budget and private-data suitability are intentionally unresolved.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] Work stays within the authorized outcome, including small required fixes; unrelated work is deferred.
- [ ] Material assumptions and relevant owner decisions are recorded under the current development policy in CONTRIBUTING.md and docs/roadmap.md.
- [ ] Credentials, private source, offline verification, and immutable raw evidence retain their existing protections.
