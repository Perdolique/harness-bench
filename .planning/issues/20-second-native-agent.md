# feat: add a second native agent/provider as a complete stack

<!-- agent-stack-benchmark:planning-issue:20 -->

Planning item: 20 | Milestone: M4 Hardening and expansion

## Context

Only after the Codex pilot can another complete daily-use stack be meaningfully compared.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 20; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Integrate one owner-selected native agent through an existing Harbor adapter where possible.

## In scope

- Select one candidate and exact version from current official sources.
- Map one explicit ported harness, auth mode, permissions and trajectory/usage behavior.
- Prove the same separate verifier and collection boundaries.

## Out of scope

- Generic provider/plugin framework, multiple candidates, custom sandboxing or claiming a bare-model comparison.

## Technical constraints

- Owner must choose/authenticate the candidate and authorize any local canary.
- Ported harness differences are recorded as stack differences, not silently treated as identical.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] One pinned second native stack is represented with full provenance.
- [ ] Harness/tool/permission differences are visible in reports.
- [ ] Offline separate verification and immutable raw retention are proven.
- [ ] Ordinary CI makes no provider calls.

## Test/evidence plan

- Use sanitized fake trajectories in CI and one explicitly authorized local parity canary.
- Repeat hidden-test/credential/network/collection controls with the new adapter.

## Documentation changes

- docs/architecture.md stack extension; candidate ADR, research snapshot and operations.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
- Outside the v1 critical path. Owner pilot review after [planning issue 17](https://github.com/Perdolique/harness-bench/issues/17) must justify this work before it starts.
<!-- dependencies:end -->

## Risks/open questions

- Agent choice and billing/credential access are intentionally undecided.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] Work stays within the authorized outcome, including small required fixes; unrelated work is deferred.
- [ ] Material assumptions and relevant owner decisions are recorded under the current development policy in CONTRIBUTING.md and docs/roadmap.md.
- [ ] Credentials, private source, offline verification, and immutable raw evidence retain their existing protections.
