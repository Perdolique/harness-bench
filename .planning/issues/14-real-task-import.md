# feat: import and freeze a task from a real repository commit or merged PR

<!-- agent-stack-benchmark:planning-issue:14 -->

Planning item: 14 | Milestone: M3 Pilot benchmark

## Context

Real work requires immutable source provenance without exposing private code or future solutions.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 14; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Import and freeze one explicit local repository base into an authorable task artifact.

## In scope

- Accept a local repository and exact base commit, optionally identifying a merged PR as provenance.
- Remove future history and freeze source/environment artifacts.
- Scan obvious secrets and support external private task storage with manual hidden-check authoring.
- Record public-online reachability and a private-data retention deadline before finalization.

## Out of scope

- Automatic hidden-test generation, moving-branch runtime clones, public upload and five-task calibration.

## Technical constraints

- No private remote credentials in metadata and no private source in the benchmark source repository.
- A one-commit snapshot removes local history but cannot hide a public repository's later commits; exclude publicly reachable future solutions or grading material from secrecy-dependent claims.
- Materialize imported bytes as a new local repository with exactly one base commit; do not copy the source object database, refs, remotes, hooks, credentials, alternates or later history, and retain no unreachable objects.
- Import starts only after the issue 13 dry-run/canary owner gate.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Accepts a local repository and explicit base commit.
- [ ] Removes future history from the agent-visible snapshot.
- [ ] Agent-visible Git contains exactly one base commit and no source refs, remotes, hooks, credentials, alternates or unreachable objects.
- [ ] Builds an immutable local task/environment artifact; no runtime clone from a moving branch.
- [ ] Detects obvious secrets before snapshotting.
- [ ] Records provenance without embedding private remote credentials.
- [ ] Provides a manual authoring workflow rather than pretending hidden tests can be generated perfectly.
- [ ] Supports keeping private task data outside the benchmark source repository.
- [ ] Records a retention deadline defaulting to 90 days and supports expiry/owner deletion with an immutable redacted intent-linked tombstone and no private bytes.
- [ ] Records an online-reachability assessment and rejects secrecy claims for publicly reachable source history, solutions, checks, images, or packages.

## Test/evidence plan

- Import an ordinary local fixture with future commits, remotes, hooks, and alternates; verify a functional one-commit repository and local history absence.
- Use a separate secret-sentinel fixture and require safe rejection before snapshot finalization. The ordinary fixture must succeed, and the secret fixture must fail, so neither expected outcome masks the other.
- Check reproducible snapshot digest, fixed-base provenance and no runtime fetch.
- Exercise public-history rejection plus 90-day/default and explicit retention expiry using sanitized fixtures; verify the deletion tombstone contains no private content.
- Inspect private output paths and confirm no provider call.

## Documentation changes

- docs/task-authoring.md import/freeze/manual authoring; docs/security.md provenance handling.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
- Required gate: owner dry-run and subscription-canary review after [planning issue 13](https://github.com/Perdolique/harness-bench/issues/13).
<!-- dependencies:end -->

## Risks/open questions

- Owner permission to process a particular private repository must be established before its import.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
