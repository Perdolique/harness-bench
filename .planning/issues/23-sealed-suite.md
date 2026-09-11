# feat: add holdout/sealed-suite workflow

<!-- agent-stack-benchmark:planning-issue:23 -->

Planning item: 23 | Milestone: M4 Hardening and expansion

## Context

Manual pilot freezing is required in v1; a reusable holdout workflow is a later control against feedback leakage.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 23; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Freeze and audit one holdout suite lifecycle without silently exposing grading data.

## In scope

- Create sealed revision/digest records and explicit calibration versus holdout membership.
- Record owner-authorized evaluation and unsealing events with provenance.

## Out of scope

- Public registry, automatic task retuning, new scoring, and access-control infrastructure beyond local scope.

## Technical constraints

- Sealing must not falsely claim secrecy against the local machine owner.
- Sealing must not claim secrecy for checks, solutions, future history, images, packages, or source identity reachable through the unrestricted agent internet.
- Hidden verifier/solution data stays outside agent access and raw results remain immutable.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Calibration and holdout membership/revisions are immutable and inspectable.
- [ ] Unsealing is explicit and provenance-recorded.
- [ ] Task changes produce a new suite identity and cannot inherit sealed results.
- [ ] Verification remains offline and provider-free controls cover the workflow.
- [ ] Every holdout records and passes an online-reachability assessment before it can make a secrecy-dependent claim.

## Test/evidence plan

- Attempt revision mutation, repeated unauthorized lifecycle transitions and incompatible comparisons.
- Use a deliberately public solution/check fixture and require rejection from the sealed-quality path while preserving smoke-test eligibility.
- Prove audit history and frozen suite identities survive reporting/regrade.

## Documentation changes

- docs/methodology.md holdout policy; docs/operations.md seal/unseal workflow.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
- Outside the v1 critical path. Owner pilot review after [planning issue 17](https://github.com/Perdolique/harness-bench/issues/17) must justify this work before it starts.
<!-- dependencies:end -->

## Risks/open questions

- Define who can inspect a local sealed suite and what leakage guarantees are actually possible.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] Work stays within the authorized outcome, including small required fixes; unrelated work is deferred.
- [ ] Material assumptions and relevant owner decisions are recorded under the current development policy in CONTRIBUTING.md and docs/roadmap.md.
- [ ] Credentials, private source, offline verification, and immutable raw evidence retain their existing protections.
