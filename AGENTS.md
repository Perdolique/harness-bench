# Agent Stack Benchmark development instructions

## Work scope

This is a pre-release benchmark. Issues 1–15 are implemented. Owner-only exploratory work on the five-task suite is in progress. The formal issue 17 pilot has not started.

- Work on the user-authorized outcome. Do not start unrelated backlog work.
- Use `docs/roadmap.md` for formal milestone order. Bootstrap plans and completed issues are history, not new gates.
- Read an issue and its dependencies when the task depends on them. A small fix does not need a new issue, session, branch or PR.
- Use a short plan for non-trivial work. Do not create extra cards or checklists when built-in plans and reports already record the facts.
- Reuse checks when their inputs and toolchain still match. Rerun checks affected by the change.
- Source inspection is not a successful runtime experiment.

## Owner decisions

The owner decides provider-call limits, access to a new private source, task fairness, and whether benchmark conclusions are accepted.

- A clear instruction in chat is enough. Do not require a separate approval document.
- One authorization covers its stated tasks, arms, model and total call ceiling. Attempted calls count against that ceiling.
- Provider-free fixes, inspection and resume of untouched assignments need no new approval when the authorized scope and ceiling stay unchanged.
- Ask again only when using a new private source, changing the authorized tasks, arms or model, or increasing the total call ceiling.
- Formal roadmap gates control formal claims. They do not block owner-only exploratory work.
- Built-in plans, progress records and results are enough for local work. A run card, stop card, issue update, branch or PR is optional unless the owner asks for it or the result is prepared for external review.

## Communication

Assume the user is an experienced engineer. Explain benchmark-specific terms when needed, but do not explain general engineering basics. Keep updates short. Lead with the outcome, blocker or decision.

## Architecture and experimental integrity

- Harbor owns generic environment lifecycle, native-agent adaptation, transport of declared artifacts, trajectories, and separate-verifier orchestration. The project owns schemas, validation, trusted collector/verifier tooling, grading, and fail-closed semantics. `benchctl` is a thin TypeScript control plane. Python is limited to pinned Harbor/tooling needs.
- The issue 2 feasibility and issue 3 evidence decisions are accepted with their recorded limits. Keep the spike isolated.
- If native-agent adaptation fails but trusted collection and separate verification still work, use a focused adapter issue and ADR. If trusted collection or separate verification fails, stop. A fallback cannot depend on a lost trust property.
- Evaluate a different execution boundary only in a separate issue and ADR. Do not build a custom sandbox platform by default.
- Pin tool versions, OCI digests, task bases, and available stable model IDs. Record unavailable/provider-hidden identities as `unknown`.
- Record exact run artifacts. Revise an identity only when its contract changes. A new digest or run ID is not a release.
- Freeze checked images by digest. Independent builds need not reproduce an old image ID. Never replace frozen inputs or combine incompatible results.
- Grade observable behavior and evidence-backed repository contracts, not resemblance to a reference diff. Preserve score facets and scope violations.
- Compare harnesses with paired, blocked and repeated runs. Subscription concurrency is one.
- Complete a task/replicate block within 24 hours. Invalidate it after a known model, CLI, provider, runner, Harbor configuration or harness change.
- Keep task failure separate from agent, provider, runner, verifier, infrastructure failure and cancellation. Retain the timeout stage and cause.

## Trust boundary

- Agent environments never receive hidden tests, reference solutions, future Git history, host home directories, Docker sockets, or undeclared secrets. Local absence is insufficient under unrestricted internet: task eligibility must also exclude grading material or future solutions that the agent can reacquire from a public repository, mirror, package, cache, or other reachable source.
- Materialize task source as a new local repository with one base commit. Do not copy the source object database, refs, remotes, hooks, credentials, or later history; retain only objects reachable from the new commit. Collector truth never depends on agent-controlled Git metadata.
- Codex authentication uses a dedicated external credential directory. A fresh non-auth `CODEX_HOME` and explicit harness are materialized for every run. Credentials never enter source control, harnesses, run artifacts, logs, or the verifier. Refresh and read-only refresh compatibility remain unproved; stop and require owner login on authentication failure.
- The verifier starts from the immutable base in a fresh separate container, with no network and no credentials, and consumes only declared validated artifacts.
- Capture the repository change independently of an agent's voluntary export, commit, or success message. Missing, failed, conflicting, or mutable evidence blocks a valid grade; Harbor's best-effort collection is not a success signal.
- Keep raw results immutable while retained. Publication uses a separate sanitized record with provenance.
- A possible secret blocks normal retention and publication until the security procedure is complete. Private tasks declare an expiry; the default is 90 days. Deletion leaves a redacted tombstone without source or secret bytes.
- Default Harbor telemetry to `off`; record any explicit owner opt-in.
- Never fabricate subscription monetary cost or buy/redeem provider credits.

## Implementation and verification

Use the simplest change that meets the authorized outcome. Avoid unrelated refactors, speculative compatibility, unused abstractions and dependency churn. Development schema changes follow `docs/architecture.md`. Old raw records do not require permanent support for every development format. Keep repository text in English.

Use deterministic fake agents, reference solutions and sanitized fixtures for ordinary tests and CI. Ordinary CI never calls a provider. A regression test must fail when its protected behavior is removed. Record commands, outcomes and unavailable checks in the final handoff or PR. Keep raw technical errors in restricted diagnostics and show safe user-facing messages.

When changing a Codex `config.toml`, validate with the selected Codex CLI: `codex doctor --json` must report `checks.config.load.status` as `ok`, and a supported `--strict-config` invocation must reject unknown fields. For non-active configs, use a dedicated temporary `CODEX_HOME`; never edit the owner's active configuration as a shortcut. These local checks do not authorize provider calls.

Respect existing user changes and staging. Stage only the requested commit scope. Never unstage or restage unrelated files. When a commit is requested, use conventional English and preserve hooks. Stop when the authorized outcome is complete. See [CONTRIBUTING.md](CONTRIBUTING.md) for checks.
