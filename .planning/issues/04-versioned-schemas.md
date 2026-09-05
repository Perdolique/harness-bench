# feat: define versioned stack, harness, suite, experiment, task, run, and score schemas

<!-- agent-stack-benchmark:planning-issue:04 -->

Planning item: 4 | Milestone: M1 Vertical-slice MVP

## Context

Configuration and result identities need one explicit contract after the runtime boundary is proven.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 4; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Define versioned runtime-validated stack, harness, suite, experiment, task, run and score contracts.

## In scope

- Create Valibot schemas and serialized inspection artifacts for the seven named document types.
- Represent the full manifest contract, failure taxonomy, applicability, independent revisions and immutable completion records, including collection, verifier-network and concurrency identities.
- Add minimal sanitized valid/invalid examples; explicitly defer schema migrations.

## Out of scope

- Runner execution, capture commands, full migration machinery, generic provider framework, and new benchmark tasks.

## Technical constraints

- Unknown provider values and not-applicable facets must not become invented zeroes.
- Harbor numeric rewards cannot hold all non-numeric evidence/applicability metadata; model that boundary explicitly.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Runtime-validated Valibot schemas.
- [ ] Serialized schema artifacts for inspection.
- [ ] Schema versions are explicit.
- [ ] Unknown provider fields are representable without invented values.
- [ ] Invalid combinations fail with actionable errors.
- [ ] Unit tests cover valid/invalid examples and migrations are deferred explicitly.
- [ ] Example configurations exist but contain no credentials.
- [ ] Run identity records collector revision/image digest and quiescence, collection, exact-manifest, and hash enforcement status.
- [ ] Verifier identity records its image digest and network-enforcement sidecar digest, or explicit `not_applicable` when no sidecar participates.
- [ ] Requested/effective concurrency and enforcement status are explicit; v1 subscription schemas reject values other than one.
- [ ] Experiment identity records the 24-hour block deadline, completion status, known-change invalidation status, and reason.

## Test/evidence plan

- Validate representative valid examples and reject incompatible auth/config/revision combinations.
- Exercise absent facets, invalid ranges, unknown provider identity, distinct failure classes, and initial/completion manifest linkage.
- Reject missing collector/network-enforcement identities, v1 subscription concurrency other than one, and incompatible or invalidated experiment blocks.
- Generate serialized artifacts deterministically with no provider calls.

## Documentation changes

- docs/architecture.md and docs/methodology.md schema contracts and examples.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
<!-- dependencies:end -->

## Risks/open questions

- Keep the schemas aligned with the accepted spike rather than hypothetical future agents.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
