# feat: add API-auth and billing-aware experiment mode

<!-- agent-stack-benchmark:planning-issue:21 -->

Planning item: 21 | Milestone: M4 Hardening and expansion

## Context

API-backed experiments have different credentials and billing semantics from the primary subscription workflow.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 21; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Add an explicit opt-in API-auth mode for the existing native stack with billing provenance.

## In scope

- Separate auth/billing identities and external credentials.
- Record actual available provider billing/usage metadata and label estimates separately.
- Show invocation/budget limits before an authorized run.

## Out of scope

- Automatic purchasing, silent subscription-to-API fallback, scheduled jobs, and another provider.

## Technical constraints

- No key in harnesses, logs, run records or verifier; no keys in ordinary CI.
- Never retroactively price subscription runs as API runs; version price assumptions when estimates are displayed.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] API auth is explicit and cannot be selected by ambient credentials.
- [ ] Money fields have observed/estimated/unknown provenance and currency.
- [ ] Subscription reporting is unchanged and has no fabricated per-task cost.
- [ ] No credit purchases, provider calls in ordinary CI, or raw-record mutation.

## Test/evidence plan

- Use synthetic metered/unknown billing fixtures and missing-credential cases.
- Prove accidental auth-mode fallback is rejected and verifier remains offline.

## Documentation changes

- docs/operations.md API setup and budgets; docs/methodology.md billing interpretation; auth ADR.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
- Outside the v1 critical path. Owner pilot review after [planning issue 17](https://github.com/Perdolique/harness-bench/issues/17) must justify this work before it starts.
<!-- dependencies:end -->

## Risks/open questions

- Account, budget and price source are unknown until owner selects API mode; verify current official terms then.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
