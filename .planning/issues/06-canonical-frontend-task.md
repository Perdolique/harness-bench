# feat: add canonical frontend blast-radius task with separate deterministic verifier

<!-- agent-stack-benchmark:planning-issue:06 -->

Planning item: 6 | Milestone: M1 Vertical-slice MVP

## Context

The first representative task must measure real repository obligations rather than reference-diff resemblance.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 6; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Create one canonical TypeScript/Vue frontend blast-radius task with an independent deterministic verifier.

## In scope

- Author a small repository and realistic secondary-action prompt without listing implicit obligations.
- Supply analytics, localization, tests and accessibility precedents in the pristine base.
- Build a separate offline verifier for direct behavior, evidenced contracts, regressions and harmful scope changes.

## Out of scope

- Production run orchestration, five real tasks, generic rubric engine, LLM judges, and source/diff similarity grading.

## Technical constraints

- Hidden tests/reference solution/future history are absent from agent-visible files and layers.
- Unrestricted internet means local absence is not secrecy. Record whether the exact checks, solution, later history, or identifiable source are publicly reachable; a reachable public fixture is smoke/plumbing evidence only.
- Agent-visible source is a new local repository with exactly one base commit; do not copy the source object database, refs, remotes, hooks, credentials or later history, and retain no unreachable objects.
- Verifier image includes all dependencies and consumes only declared safe artifacts.
- Only evidenced obligations may affect scoring; alternate justified file edits are permitted.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Pristine base fails task-specific checks for the intended reason.
- [ ] Reference implementation passes.
- [ ] At least one structurally different valid implementation can pass.
- [ ] Existing regression tests pass.
- [ ] Ordinary Git status/diff commands work against the single base commit.
- [ ] Agent-visible Git has no source refs, remote, hooks, credentials, future history or unreachable objects.
- [ ] Hidden tests are absent from the agent environment.
- [ ] Verifier works with network disabled.
- [ ] Contract expectations include concrete repository evidence.
- [ ] No source/diff similarity grading.
- [ ] Obtain owner review of realism, inferability, evidence, alternate implementations and fair scope grading before issue 7 starts.
- [ ] Online-reachability assessment is recorded; the public checked-in fixture is not presented as proof of hidden-material or future-history secrecy.
- [ ] Any secrecy-sensitive verifier material uses an owner-controlled non-public build/pull path rather than a publicly inspectable image or build context.

## Test/evidence plan

- Prove base direct checks fail for the intended reason while existing regressions pass.
- Require reference and structurally different valid patches to pass.
- Remove each required behavior/contract, delete tests or churn a forbidden dependency, and require appropriate failure.
- Repeat verification offline and inspect agent filesystem for hidden material.
- Inspect Git objects, refs, remotes, hooks and configuration; require exactly one base commit, no unreachable objects and no source provenance beyond its declared digest.
- Exercise the public-reachability gate and prove a reachable solution/check set is excluded from secrecy-dependent quality claims.

## Documentation changes

- docs/task-authoring.md canonical walkthrough, evidence rubric and scope envelope.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
<!-- dependencies:end -->

## Risks/open questions

- A narrow static string check can reward wrong behavior; test actual triggers and user interactions.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
