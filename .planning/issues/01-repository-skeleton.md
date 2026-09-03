# chore: initialize repository, pinned toolchains, and project governance

<!-- agent-stack-benchmark:planning-issue:01 -->

Planning item: 1 | Milestone: M0 Feasibility

## Context

Bootstrap has produced governance documents, but no runtime or development skeleton exists.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 1; docs/research-snapshot.md and the accepted ADRs constrain implementation.

## Goal

Establish a deterministic development skeleton without benchmark behavior.

## In scope

- Create the strict TypeScript workspace and exact runtime/package-manager pins.
- Add only the locked Python environment needed for Harbor/tooling.
- Wire formatting, lint, typecheck, unit-test and aggregate check commands plus provider-free CI.
- Reuse and reconcile the existing planning governance/templates; add artifact/generated-file ignores.

## Out of scope

- Harbor execution, task fixtures, production schemas, benchmark commands, provider calls, or implementing issue 2.

## Technical constraints

- No floating versions; research candidates are Harbor 0.22.0 and Codex 0.153.0.
- The planned run root is configurable and ignored; local benchmark commands must default Harbor telemetry off when introduced.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] TypeScript monorepo with strict type checking.
- [ ] Package manager and runtime versions pinned; no floating versions.
- [ ] Python environment exists only for Harbor/tooling and is locked with `uv`.
- [ ] Formatting, linting, type checking, unit-test commands, and a single `check` command exist.
- [ ] CI performs static checks and unit tests only; it does not consume subscription quota.
- [ ] Root `AGENTS.md`, contribution rules, PR template, issue template, and ADR format exist.
- [ ] Generated files and run artifacts are ignored.
- [ ] `README.md` clearly states scope and non-goals.
- [ ] Harbor telemetry behavior is documented and local benchmark commands default to `HARBOR_TELEMETRY=off`.

## Test/evidence plan

- Use clean locked installs and run every new static/unit/check command.
- Verify CI contains no provider invocation or credentials and ignores exclude sample generated/run paths.
- Do not mark issue 1 complete merely because planning created README, AGENTS, and templates.

## Documentation changes

- README.md, CONTRIBUTING.md, docs/operations.md, and toolchain decisions.

## Dependencies/blockers with links

<!-- dependencies:start -->
- No issue dependencies. This is the first implementation issue after planning is committed.
<!-- dependencies:end -->

## Risks/open questions

- Select exact supported Node/pnpm/Python/uv patches during this issue; do not invent them from the plan.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] No unrelated refactoring, next-issue work, credentials/private code, verifier network access, or raw-artifact rewriting.
- [ ] New assumptions are documented or linked as follow-up issues; required owner gates are recorded.
- [ ] Commit the focused change with an English conventional commit and stop after this issue.
