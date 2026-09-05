---
name: Focused implementation issue
about: One dependency-scoped agent session and pull request
title: ""
labels: no-provider-call-in-ci
---

## Context

Describe the observed problem and link the relevant specification or evidence.

## Goal

State one reviewable outcome.

## In scope

- List the necessary changes for this outcome.

## Out of scope

- Name adjacent work that belongs in another issue.

## Technical constraints

Preserve Harbor ownership, exact pins, immutable records, separate offline verification, credential isolation, and the complete-stack measurement model.

## Acceptance criteria

- [ ] Define observable behavior and evidence, including relevant failure paths.

## Test/evidence plan

Use deterministic controls and sanitized fixtures. Ordinary CI makes no provider calls. Identify any explicitly authorized local canary and unavailable environment.

## Documentation changes

List the operations, architecture, methodology, or ADR updates required.

## Dependencies/blockers with links

Link blocking issues and owner gates; distinguish prerequisites from follow-ups.

## Risks/open questions

Record unknowns directly. Do not invent provider behavior or permission.

## Definition of Done

- [ ] All acceptance criteria have evidence and the global Definition of Done in CONTRIBUTING.md is satisfied.
- [ ] Exact commands/results and unverified criteria are recorded in the PR.
- [ ] Scope remains one issue; implementation stops after this PR.
