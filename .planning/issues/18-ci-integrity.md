# feat: add provider-free CI integrity and redaction validation

<!-- agent-stack-benchmark:planning-issue:18 -->

Planning item: 18 | Milestone: M4 Hardening and expansion

## Context

Planning item 18 contains two independently reviewable outcomes. This issue owns provider-free validation; planning item 27 owns optional metered scheduling.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 18; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Add ordinary CI validation of sanitized task/result integrity without provider calls.

## In scope

- Reuse check/doctor and deterministic fixtures in CI.
- Validate redaction/export integrity and safe artifact handling on sanitized inputs.

## Out of scope

- Metered runs or schedules (item 27), private source upload, credentials in PR jobs, and a dashboard.

## Technical constraints

- Fork/PR CI must never receive provider credentials or invoke an agent.
- Document the actual repository Actions plan, retention and incremental runner/storage implications before expanding CI.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] CI runs static/unit and deterministic integrity checks only.
- [ ] Sensitive/tampered artifact fixtures fail validation before publication.
- [ ] Private code/credentials are absent from retained CI artifacts.
- [ ] Optional metered scheduling is explicitly deferred to planning item 27 and disabled by default.

## Test/evidence plan

- Run valid and tampered/sensitive fixture jobs; failing controls must block unsafe publication.
- Inspect CI triggers/permissions and prove no provider command/secret is available.

## Documentation changes

- docs/operations.md CI and sanitized artifacts; docs/security.md publication boundary.

## Dependencies/blockers with links

<!-- dependencies:start -->
- Blocked by [planning issue 12 / GitHub #12](https://github.com/Perdolique/harness-bench/issues/12).
- Blocked by [planning issue 13 / GitHub #13](https://github.com/Perdolique/harness-bench/issues/13).
- Blocked by [planning issue 17 / GitHub #17](https://github.com/Perdolique/harness-bench/issues/17).
- Outside the v1 critical path. Owner pilot review after [planning issue 17](https://github.com/Perdolique/harness-bench/issues/17) must justify this work before it starts.
<!-- dependencies:end -->

## Risks/open questions

- GitHub Actions allowance and retention headroom are unknown until implementation; do not assume unused free capacity.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
