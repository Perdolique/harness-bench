# Contributing

Select one unblocked issue from [the roadmap](docs/roadmap.md). Dependency closure
alone does not replace the owner gates after issues 2, 6, 13, 16, and 17. Record the
decision and evidence in the issue or PR before downstream work starts.

Use a focused branch and one PR per issue. Read [AGENTS.md](AGENTS.md), inspect the
actual checkout, and map a concise implementation plan to the issue's acceptance
criteria. If an independently reviewable outcome is discovered, create a linked
follow-up rather than expanding the PR. Do not silently change accepted contracts.

## Definition of Done

- [ ] Only the selected issue is implemented; no unrelated refactoring.
- [ ] Tool versions, image digests, and stable model identifiers are pinned where
  available; unknown values are explicit.
- [ ] Meaningful deterministic tests cover changed behavior, including negative
  controls that fail when the protected contract is removed.
- [ ] Operational documentation and relevant ADRs reflect actual behavior.
- [ ] The PR records exact commands, results, and any unverified criteria.
- [ ] Ordinary tests and CI consume no subscription quota and make no provider calls.
- [ ] No credentials or private source code are committed or published.
- [ ] Agent visibility excludes hidden tests, reference solutions, and future history.
- [ ] Verification occurs separately with no network or credentials.
- [ ] Raw run artifacts remain immutable and new derived records retain provenance.
- [ ] Task, agent, provider, runner, verifier, infrastructure failure, and cancellation
  remain distinguishable; timeouts carry the failing stage.
- [ ] New assumptions are documented or converted into linked follow-up issues.
- [ ] Required owner gates are satisfied and implementation stops after this issue.

Use the [PR template](.github/pull_request_template.md) and
[ADR format](docs/adr/README.md). During bootstrap, the only runnable repository
checks are planning validation and publication tooling documented in
[.planning/README.md](.planning/README.md). The implementation check command and
CI belong to issue 1.
