# feat: import and freeze a task from a real repository commit or merged PR

<!-- agent-stack-benchmark:planning-issue:14 -->

Planning item: 14 | Milestone: M3 Pilot benchmark

## Context

Real work requires immutable source provenance without exposing private code or future solutions. Deliver one usable import path that feeds the first real task; avoid building a general repository management platform.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 14. The 2026-09-11 development revision in docs/roadmap.md defines the current scope and owner decisions; the accepted ADRs retain the trust boundary.

## Goal

Import and freeze one explicit local repository base into an authorable task artifact.

## In scope

- Accept a local repository and exact base commit, optionally identifying a merged PR as provenance.
- Remove future history and freeze source/environment artifacts.
- Scan obvious secrets and support external private task storage with manual hidden-check authoring.
- Record public-online reachability and a private-data retention deadline before finalization.

## Out of scope

- Automatic hidden-test generation, repository discovery, moving-branch runtime clones, public upload, five-task calibration, and reproducible Docker rebuilds.

## Technical constraints

- No private remote credentials in metadata and no private source in the benchmark source repository.
- A one-commit snapshot removes local history but cannot hide a public repository's later commits; exclude publicly reachable future solutions or grading material from secrecy-dependent claims.
- Materialize imported bytes as a new local repository with exactly one base commit; do not copy the source object database, refs, remotes, hooks, credentials, alternates or later history, and retain no unreachable objects.
- Provider-free implementation and tests use sanitized fixtures and can proceed while the post-13 canary is pending. Owner private-data use requires the technical canary review and permission for that source.
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
- [ ] Provides one complete sanitized import example that can feed the existing task package and doctor workflow; further real-task work can start from it.

## Test/evidence plan

- Import an ordinary local fixture with future commits, remotes, hooks, and alternates; verify a functional one-commit repository and local history absence.
- Use a separate secret-sentinel fixture and require safe rejection before snapshot finalization. The ordinary fixture must succeed, and the secret fixture must fail, so neither expected outcome masks the other.
- Check reproducible source snapshot digest, fixed-base provenance and no runtime fetch. Freeze the actual checked environment image; byte-identical image rebuilds are not an acceptance condition.
- Exercise public-history rejection plus 90-day/default and explicit retention expiry using sanitized fixtures; verify the deletion tombstone contains no private content.
- Inspect private output paths and confirm no provider call.

## Documentation changes

- docs/task-authoring.md import/freeze/manual authoring; docs/security.md provenance handling.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
- Required gate: technical canary review after [planning issue 13](https://github.com/Perdolique/harness-bench/issues/13) and source permission before owner private-data use; provider-free fixture implementation may proceed.
<!-- dependencies:end -->

## Risks/open questions

- Owner permission to process a particular private repository must be established before its import.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] Work stays within the authorized outcome, including small required fixes; unrelated work is deferred.
- [ ] Material assumptions and relevant owner decisions are recorded under the current development policy in CONTRIBUTING.md and docs/roadmap.md.
- [ ] Credentials, private source, offline verification, and immutable raw evidence retain their existing protections.
