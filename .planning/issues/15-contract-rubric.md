# feat: define blast-radius rubric and repository-contract evidence format

<!-- agent-stack-benchmark:planning-issue:15 -->

Planning item: 15 | Milestone: M3 Pilot benchmark

## Context

The canonical task has a concrete rubric; real tasks need a reusable evidence format without speculative obligations.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 15; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Formalize and validate blast-radius rubrics anchored to pristine repository evidence.

## In scope

- Support direct behavior, analytics, logging, tests, accessibility, localization, regression and scope.
- Represent facet applicability, evidence paths, expectations and deterministic check references.
- Define allowed, conditional and forbidden scope zones with justified exceptions.

## Out of scope

- LLM judging, reference-diff similarity, full mutation testing, generic unsupported contracts and authoring five tasks.

## Technical constraints

- Evidence must resolve at the pristine base, not a solution or agent-edited snapshot.
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

## Test/evidence plan

- Reject nonexistent evidence, contradictory expectations and unsupported obligations.
- Validate not-applicable facets and justified alternate file choices.
- Provide good/bad examples including behavioral negative controls.

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
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
