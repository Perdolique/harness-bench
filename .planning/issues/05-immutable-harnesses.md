# feat: capture, validate, hash, and materialize immutable harness bundles

<!-- agent-stack-benchmark:planning-issue:05 -->

Planning item: 5 | Milestone: M1 Vertical-slice MVP

## Context

Copying an ambient home confounds harness comparisons and can retain auth or history.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 5; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Capture, validate, hash, materialize and compare immutable allowlisted harness bundles.

## In scope

- Support explicit AGENTS.md, skills, Codex config, MCP/tool declarations and policies.
- Use canonical content hashing and a human-readable diff for complete supported inputs.
- Materialize a fresh one-run home/workspace consistent with the proven native adapter.

## Out of scope

- Credential capture, history/cache migration, arbitrary home backup, plugin marketplace management, and orchestration.

## Technical constraints

- Credentials and secret-like files are rejected, not silently included or omitted as if equivalent.
- Validate paths/symlinks and effective config; required tool auth cannot enter a bundle.
- Config changes require pinned Codex doctor and supported strict-config validation.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Explicit allowlist of supported harness inputs: AGENTS.md, skills, Codex configuration, MCP/tool declarations, and policies.
- [ ] Capture command creates a content-addressed immutable bundle and manifest.
- [ ] Bundle digest is stable across equivalent captures.
- [ ] Secret-like files and known Codex auth/history/cache paths are rejected.
- [ ] Materialization creates an ephemeral agent home/workspace for one run.
- [ ] Tests prove credentials are excluded and changed skill/config content changes the digest.
- [ ] A human-readable diff command compares two harness bundles.

## Test/evidence plan

- Compare equivalent captures from different source directories/orderings and require stable digests.
- Change skill/config content and require changed digests.
- Inject auth/history/cache paths, secret sentinels, and escaping links; capture must reject them.
- Materialize twice and prove source bundle immutability and isolated non-auth state.

## Documentation changes

- docs/operations.md capture/materialize/diff workflow; docs/security.md supported/rejected inputs.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
<!-- dependencies:end -->

## Risks/open questions

- MCP declarations may refer to unavailable credentials; fail explicitly rather than change the tested tool set.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
