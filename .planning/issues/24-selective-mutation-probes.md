# feat: add selective mutation probes for agent-authored tests

<!-- agent-stack-benchmark:planning-issue:24 -->

Planning item: 24 | Milestone: M4 Hardening and expansion

## Context

A passing agent-authored test may not protect the required behavior.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 24; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Add a small fixed set of behavior-removal probes for one calibrated task.

## In scope

- Define task-specific mutations tied to evidenced obligations.
- Check that authored tests fail under the targeted regression and report probe facets.

## Out of scope

- General mutation framework, broad automatic mutation generation and source-shape grading.

## Technical constraints

- Probes run only in the separate offline verifier; pristine/reference control behavior is explicit.
- Mutations and scoring changes carry new verifier/scoring revisions; raw records are unchanged.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] A bounded fixed probe set detects the selected missing behavioral protection.
- [ ] Reference/alternate valid tests pass calibration and vacuous tests fail.
- [ ] Probe evidence, bounds and revisions are retained separately.
- [ ] No full mutation framework, networked verifier or provider call is introduced.

## Test/evidence plan

- Include meaningful and vacuous authored-test fixtures with known expected probe outcomes.
- Confirm runtime bounds and deterministic regrade with no agent invocation.

## Documentation changes

- docs/task-authoring.md selective probe examples; docs/methodology.md test-quality limits.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
- Outside the v1 critical path. Owner pilot review after [planning issue 17](https://github.com/Perdolique/harness-bench/issues/17) must justify this work before it starts.
<!-- dependencies:end -->

## Risks/open questions

- A surviving mutation is evidence for one missing test property, not proof of universally bad tests.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
