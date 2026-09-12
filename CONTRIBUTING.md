# Contributing

Use [the roadmap](docs/roadmap.md) to choose work that advances the user-authorized outcome. Native GitHub dependencies describe prerequisites; the roadmap distinguishes technical checks from owner decisions. Historical bootstrap gates do not add approval steps to routine development.

Keep a branch and PR focused on one reviewable outcome. Link existing issues when applicable; a planning correction or small required fix does not need a new issue. A larger issue may take several useful PRs or sessions. Read [AGENTS.md](AGENTS.md), inspect the checkout, and map the plan to acceptance criteria. Create a linked follow-up for independently useful work outside the authorized outcome. Do not silently change accepted contracts or start unrelated backlog work.

## Definition of Done

- [ ] The authorized outcome is complete; no unrelated refactoring.
- [ ] Tool versions, image digests, and stable model identifiers are pinned where available; unknown values are explicit.
- [ ] Meaningful deterministic tests cover changed behavior, including negative controls that fail when the protected contract is removed.
- [ ] Operational documentation and relevant ADRs reflect actual behavior.
- [ ] The PR records exact commands, results, and any unverified criteria.
- [ ] Ordinary tests and CI consume no subscription quota and make no provider calls.
- [ ] No credentials or private source code are committed or published.
- [ ] Agent visibility excludes hidden tests, reference solutions, and future history.
- [ ] Verification occurs separately with no network or credentials.
- [ ] Raw run artifacts remain immutable and new derived records retain provenance.
- [ ] Task, agent, provider, runner, verifier, infrastructure failure, and cancellation remain distinguishable; timeouts carry the failing stage.
- [ ] Material assumptions and limits are explained; only necessary out-of-scope work becomes a follow-up.
- [ ] Relevant owner decisions are recorded. Existing authorization is reused within its scope.

## Development checks and revisions

Before the first reviewed pilot, formats and workflows may evolve. Preserve old raw evidence and its producing commit; follow the [schema policy](docs/architecture.md#versioned-document-boundary) instead of adding speculative compatibility. Run IDs, content digests, contract revisions, and product releases have different purposes. Do not bump every revision or open an issue just because one artifact changes.

Verification follows the change. Documentation and planning edits need relevant lint, links, backlog checks, and diff inspection. Code changes need focused tests plus the applicable repository checks; changes to schemas, collection, credentials, or shared execution need broader coverage. Full Docker calibration is needed when task or execution changes affect its evidence, not after every prose edit. Existing green evidence can be reused while its relevant inputs and toolchain match. A provider-backed canary always needs an explicit invocation budget; ordinary CI remains provider-free.

Use the [PR template](.github/pull_request_template.md) and [ADR format](docs/adr/README.md).

## Development prerequisites

Install these exact versions before working in the repository:

- Node.js `26.8.2`
- pnpm `12.4.1`
- Vite+ `0.3.0`
- Python `3.14.7`
- uv `0.12.13`

Node `26.8.2` is a current, non-LTS release selected deliberately for the newest stable toolchain. The project installs Harbor `0.23.0`, Codex CLI `0.154.0`, and all formatting, linting, type-checking, and test tools from committed lockfiles. Installation does not sign in to Codex.

Vite+ is a global CLI rather than a project dependency. In an isolated environment where `vp` is unavailable, install the exact required version with the official installer:

```sh
curl -fsSL https://vite.plus | VP_VERSION=0.3.0 bash
```

```sh
vp install --frozen-lockfile
uv sync --locked
vp run check
```

`vp run check` is read-only and runs formatting checks, linting, TypeScript checks, Vitest, planning tests and validation, and exact toolchain verification. Individual commands are documented in [Operations](docs/operations.md).

The `Check` workflow repeats only those locked installation and read-only check steps on the standard `ubuntu-24.04` GitHub-hosted runner. It has read-only contents permission, does not persist checkout credentials, disables dependency caches, uploads no artifacts, and never runs Harbor jobs or Codex provider commands.
