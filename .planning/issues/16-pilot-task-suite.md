# content: author and calibrate the first five real benchmark tasks

<!-- agent-stack-benchmark:planning-issue:16 -->

Planning item: 16 | Milestone: M3 Pilot benchmark

## Context

A calibrated pilot needs realistic tasks. First finish one task and inspect the full workflow, then expand the catalog. Early development feedback must remain separate from final comparative evidence.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 16. The 2026-09-11 development revision in docs/roadmap.md brings one-task feedback before full suite authoring; the accepted ADRs retain the trust boundary.

## Goal

Deliver one usable real task first, then five calibrated pilot tasks across at least three task categories.

## In scope

- Build five small tasks using the accepted import/rubric workflows.
- Supply realistic prompts, direct/regression/scope checks and evidence-backed implicit contracts.
- Document ambiguity, difficulty, alternate implementations and frozen suite identities.
- First stage: calibrate one task and prepare a skill-disabled/v1/v2 matrix with one repeat per arm. Execute these three exploratory invocations only after explicit authorization and inspect the report before expanding authoring.
- Second stage: finish the five-task suite using the proven authoring path. A useful first stage can be delivered in its own PR without closing this issue or creating another issue.

## Out of scope

- New benchmark infrastructure, a broad public registry, final harness comparison and tuning based on sealed results.

## Technical constraints

- Use owner-authorized source and keep private task data external.
- Use existing tooling and include small fixes required to finish the authorized task. Independently useful infrastructure work outside this scope needs a follow-up.
- Keep exploratory runs separate from issue 17's final 45-call pilot; the three-call development budget does not authorize pilot execution or retries.
- Disclose task and harness tuning from exploratory results. Replace a task tuned from observed arm outcomes before final comparative claims; unchanged tasks can remain with their exploratory use disclosed.
- Do not run Codex in ordinary CI.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Five tasks represent at least three task categories.
- [ ] Before expanding authoring, one task has complete calibration and a concrete three-call exploratory dry-run plan. If authorized, retain and inspect its native results; if not, record that execution is pending without blocking provider-free authoring.
- [ ] Each has a short realistic prompt.
- [ ] Each has direct checks, regression checks, scope checks, and only evidence-backed implicit contracts.
- [ ] Pristine base fails; reference patch passes.
- [ ] At least one alternate implementation is tested for each task where practical.
- [ ] Tasks pass `benchctl doctor`.
- [ ] Task difficulty and known ambiguities are documented.
- [ ] No task is tuned using the sealed final experiment result.
- [ ] Record owner acceptance of the frozen pilot suite before issue 17 execution; combine this review with the final invocation-budget decision.
- [ ] Exploratory results are excluded from final pilot statistics and outcome-driven tuning is disclosed; tuned tasks are replaced before final comparative claims.

## Test/evidence plan

- For every task retain base-fails/reference-passes and regression evidence.
- Try at least one alternate valid implementation where practical, documenting any exception.
- Run doctor for every task and repeat deterministic verification.
- Obtain owner review and freeze suite/task/verifier/scoring revisions before final experiment outcomes are visible.
- Retain the first task's calibration, exploratory plan, actual authorized outcomes, and findings. One repeat on one task is development feedback, not a reliable skill ranking.

## Documentation changes

- docs/task-authoring.md pilot catalog, calibration notes and freeze procedure; external private catalog where necessary.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
<!-- dependencies:end -->

## Risks/open questions

- Source availability and task complexity may require several sessions or focused PRs. Deliver useful stages within this issue; do not create per-task follow-ups solely because a session ends.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] Work stays within the authorized outcome, including small required fixes; unrelated work is deferred.
- [ ] Material assumptions and relevant owner decisions are recorded under the current development policy in CONTRIBUTING.md and docs/roadmap.md.
- [ ] Credentials, private source, offline verification, and immutable raw evidence retain their existing protections.
