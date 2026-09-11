# feat: define blast-radius rubric and repository-contract evidence format

<!-- agent-stack-benchmark:planning-issue:15 -->

Planning item: 15 | Milestone: M3 Pilot benchmark

## Context

The canonical task has a concrete rubric. The first imported task needs evidence and checks that another engineer can understand. Use these concrete examples to define the smallest sufficient format.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 15. The 2026-09-11 development revision in docs/roadmap.md defines the current sequence; the accepted ADRs retain the trust boundary.

## Goal

Validate an evidence-backed rubric usable by the first real task and the existing canonical task.

## In scope

- Support direct behavior, analytics, logging, tests, accessibility, localization, regression and scope.
- Represent facet applicability, evidence paths, expectations and deterministic check references.
- Define allowed, conditional and forbidden scope zones with justified exceptions.
- Keep `TaskDocument.schema_version: 1` and the existing rubric shape; bind every obligation ID to one strict verifier check with `facet`, `passed`, `credit`, and `detail`.
- Recompute weighted facet credit in core and use only required direct-behavior and regression outcomes for hard gates.

## Out of scope

- LLM judging, reference-diff similarity, a generalized rule engine, full mutation testing, speculative contract categories, and authoring five tasks.

## Technical constraints

- Evidence must resolve at the pristine base, not a solution or agent-edited snapshot.
- Every declared obligation, including an optional one, has a verifier check and contributes to its facet. A facet with no obligations is not applicable and has no evidence.
- A presence-only static check is insufficient when behavior can be verified.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Contract expectations require evidence paths from the pristine snapshot.
- [ ] Supports direct behavior, analytics, logging, tests, accessibility, localization, regression, and scope.
- [ ] Each facet can be absent/not-applicable.
- [ ] Deterministic checks are preferred; static presence checks alone are discouraged.
- [ ] Authoring guide includes good/bad examples.
- [ ] Scope envelope supports allowed, conditional, and forbidden zones.
- [ ] Rubric validation catches contradictory or unsupported expectations.
- [ ] The canonical task and a sanitized first-real-task example use the format without extra unused abstractions or mandatory not-applicable checks.

## Test/evidence plan

- Reject nonexistent evidence, unknown or missing checks, facet mismatches, invalid credit, incorrect weighted values, gate mismatches, and invalid applicability.
- Validate not-applicable facets and the sanitized `notification-retry` direct-edit and conditional-helper alternatives.
- Run pristine, reference, alternate, repeat, test deletion, test disablement, forbidden edit, and all task-specific behavioral negative controls with provider calls at zero.

## Documentation changes

- docs/task-authoring.md rubric examples and docs/methodology.md applicability rules.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
<!-- dependencies:end -->

## Risks/open questions

- Overly broad scope bans can penalize valid implementations; tie each ban to harmful blast radius.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] Work stays within the authorized outcome, including small required fixes; unrelated work is deferred.
- [ ] Material assumptions and relevant owner decisions are recorded under the current development policy in CONTRIBUTING.md and docs/roadmap.md.
- [ ] Credentials, private source, offline verification, and immutable raw evidence retain their existing protections.
