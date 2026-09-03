# feat: produce paired experiment comparisons and uncertainty estimates

<!-- agent-stack-benchmark:planning-issue:11 -->

Planning item: 11 | Milestone: M2 Controlled experiments

## Context

Repeated results need paired analysis with explicit uncertainty and compatibility checks.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 11; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Report paired facet effects and uncertainty without hiding failure or revision mismatches.

## In scope

- Compute per-task paired deltas, win/tie/loss, pass/facet summaries and reliability.
- Use seeded paired task-cluster bootstrap with recorded method/count and keep repeats paired.
- Show timing/usage distributions, missing pairs and separate failure classes.

## Out of scope

- Universal model rankings, unpaired causal claims, LLM judgments or task retuning.

## Technical constraints

- Reject incompatible task/scoring/verifier/environment/runner/budget identities for harness-effect claims.
- Do not translate provider/runner/verifier failures into quality zeroes by default.
- Freeze tie rules and analysis revision; report limited pilot sample size.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Per-task paired deltas.
- [ ] Win/tie/loss counts.
- [ ] Pass rate and facet deltas.
- [ ] Paired bootstrap confidence intervals with recorded seed.
- [ ] Reliability metric such as all-pass-across-repeats.
- [ ] Duration and usage distributions.
- [ ] Infrastructure failures reported separately, never converted into task-quality zeroes by default.
- [ ] Report refuses invalid comparisons when task/scoring/environment revisions are incompatible.
- [ ] Unit tests use known synthetic datasets.

## Test/evidence plan

- Use known synthetic zero-effect and positive/negative paired datasets.
- Check deterministic seed output, clustering of repeats, missing-pair coverage and invalid comparison rejection.
- Validate all-pass reliability and duration/usage summaries against hand-computed examples.

## Documentation changes

- docs/methodology.md estimator details and limitations; docs/operations.md comparison usage.

## Dependencies/blockers with links

<!-- dependencies:start -->
- Blocked by [planning issue 10 / GitHub #10](https://github.com/Perdolique/harness-bench/issues/10).
<!-- dependencies:end -->

## Risks/open questions

- Five tasks do not support a universal ranking or precise confidence claim.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
