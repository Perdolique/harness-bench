# feat: add explicitly opted-in metered experiment schedules

<!-- agent-stack-benchmark:planning-issue:27 -->

Planning item: 27 | Milestone: M4 Hardening and expansion

## Context

This is the scheduling portion split from planning item 18. Ordinary CI must remain provider-free.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 18; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Add one explicitly enabled, bounded scheduled experiment entry point separate from ordinary CI.

## In scope

- Use the existing API-auth experiment mode and explicit owner-selected schedule/budget.
- Isolate credentials/triggers from PR CI and retain manifest, quota/cost provenance and sanitized artifacts.
- Keep the workflow disabled until the owner supplies account/budget and deliberately enables it.

## Out of scope

- Subscription calls in ordinary CI, auto-purchases, automatic enablement, and a general scheduling service.

## Technical constraints

- A saved schedule must not grant untrusted PR code access to keys.
- Document actual Actions runner/storage and provider billing dimensions; remaining allowances are unknown until checked.
- Default concurrency one unless a separately justified explicit configuration changes it.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] The scheduled entry point is disabled by default and explicitly separable from ordinary CI.
- [ ] Invocation/budget/concurrency limits and owner opt-in are recorded.
- [ ] Fork/PR jobs cannot access credentials or start provider calls.
- [ ] Separate offline verification, immutable evidence, redaction and failure taxonomy remain intact.

## Test/evidence plan

- Test schedule dispatch/limits/failure handling with fake agents and no live credentials.
- Verify normal push/PR checks cannot invoke the metered path.
- A first actual scheduled canary requires explicit owner enablement and records all costs/usage that are available.

## Documentation changes

- docs/operations.md opt-in/disable/budget workflow; docs/security.md credential and trigger boundary.

## Dependencies/blockers with links

<!-- dependencies:start -->
- Blocked by [planning issue 18 / GitHub #18](https://github.com/Perdolique/harness-bench/issues/18).
- Blocked by [planning issue 21 / GitHub #21](https://github.com/Perdolique/harness-bench/issues/21).
- Outside the v1 critical path. Owner pilot review after [planning issue 17](https://github.com/Perdolique/harness-bench/issues/17) must justify this work before it starts.
<!-- dependencies:end -->

## Risks/open questions

- Owner account, budget, cadence, access and plan headroom remain unresolved until this M4 issue.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
