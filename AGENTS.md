# Agent Stack Benchmark development instructions

## Current phase and work scope

This is a pre-release benchmark under development. The engine is implemented through issue 15; the first real task and pilot remain ahead. Follow the current sequence in `docs/roadmap.md`. The bootstrap plan and completed issue bodies describe history, not additional gates for new work.

Work on the user-authorized outcome. Use an existing issue when it fits and keep PRs focused, but do not require a new issue or session for small fixes needed to finish that outcome. Create a follow-up only for independently useful work outside the authorized scope. Do not start unrelated backlog work.

Before implementation, read the selected issue and its native dependencies, then the relevant product, architecture, methodology, security, and operations guidance. Check prerequisites for the affected work. Write a short plan and identify unavailable evidence. Reuse prior checks when their inputs and toolchain still match; rerun affected checks after changes. Source inspection is not a successful runtime experiment.

Owner decisions cover provider budgets, private-data access, task fairness, and accepting benchmark conclusions. Use existing authorization within its scope. Routine development checks and identity bookkeeping do not create new owner gates. Provider-free implementation on sanitized fixtures can proceed while a native canary is pending; private-data use remains gated by the roadmap.

## Communication

Assume the user is an experienced professional engineer with years of coding-agent experience, but may be new to the specific benchmark, evaluation, or other domain under discussion. When domain knowledge is not established, prefer plain language: briefly explain the purpose, actors, basic flow, and essential terms before detailed findings. Do not explain general software-engineering or coding-agent fundamentals unless they are necessary to understand the domain-specific point.

## Architecture and experimental integrity

- Harbor owns generic environment lifecycle, native-agent adaptation, transport of declared artifacts, trajectories, and separate-verifier orchestration. The project owns schemas, validation, trusted collector/verifier tooling, grading, and fail-closed semantics. `benchctl` is a thin TypeScript control plane. Python is limited to pinned Harbor/tooling needs.
- The issue 2 feasibility gate and issue 3 evidence review are accepted with the documented Git, auth-refresh, merged-stream, public-network, and platform limitations. Keep the spike isolated. If native-agent adaptation is lost while trustworthy collection and separate verification still work, create a narrow fallback issue and ADR for a supported Harbor adapter, then consider host-managed Codex with an ephemeral Docker workspace and the still-trusted Harbor verifier. If trustworthy collection or separate verification is lost, stop: no fallback may depend on that lost property. Evaluate Pier or another boundary only through a separate issue and ADR that re-proves the trust contract. Never build a custom sandbox platform or install competing kernels by default.
- Pin tool versions, OCI digests, task bases, and available stable model IDs. Record unavailable/provider-hidden identities as `unknown`.
- Record exact artifacts for each run. Revise task, suite, verifier, scoring, environment, runner, and harness declarations only when their corresponding contract changes. A fresh artifact digest or run ID is not a release. Freeze checked images for an experiment and reuse them by digest; independent builds need not reproduce a historical Docker image ID. Never substitute inputs in a frozen plan or silently combine incompatible results.
- Grade observable behavior and evidence-backed repository contracts, not resemblance to a reference diff. Preserve score facets and scope violations.
- Compare harnesses using paired, blocked, repeated runs with subscription concurrency exactly one. Complete both arms of a task/replicate block within 24 hours; invalidate the block on a known model, CLI, provider, runner, Harbor configuration, or harness change. Keep task-quality failure distinct from agent, provider, runner, verifier, infrastructure failure, and cancellation. Retain timeout stage and cause.

## Trust boundary

- Agent environments never receive hidden tests, reference solutions, future Git history, host home directories, Docker sockets, or undeclared secrets. Local absence is insufficient under unrestricted internet: task eligibility must also exclude grading material or future solutions that the agent can reacquire from a public repository, mirror, package, cache, or other reachable source.
- Materialize task source as a new local repository with one base commit. Do not copy the source object database, refs, remotes, hooks, credentials, or later history; retain only objects reachable from the new commit. Collector truth never depends on agent-controlled Git metadata.
- Codex authentication uses a dedicated external credential directory. A fresh non-auth `CODEX_HOME` and explicit harness are materialized for every run. Credentials never enter source control, harnesses, run artifacts, logs, or the verifier. Refresh and read-only refresh compatibility remain unproved; stop and require owner login on authentication failure.
- The verifier starts from the immutable base in a fresh separate container, with no network and no credentials, and consumes only declared validated artifacts.
- Capture the repository change independently of an agent's voluntary export, commit, or success message. Missing, failed, conflicting, or mutable evidence blocks a valid grade; Harbor's best-effort collection is not a success signal.
- Preserve immutable raw results while retained. Sanitized publication is a separate derived record with provenance, never an in-place rewrite. Potential secrets block retention/publication until the security procedure is followed. Every private task declares an expiry; the default is 90 days. Deletion leaves only a redacted intent-linked tombstone without source or secret bytes.
- Default Harbor telemetry to `off`; record any explicit owner opt-in.
- Never fabricate subscription monetary cost or buy/redeem provider credits.

## Implementation and verification

Use the simplest change that meets the authorized outcome. Avoid unrelated refactors, speculative compatibility, unused abstractions, and dependency churn. Development schema changes follow `docs/architecture.md`; preserving old raw records does not require supporting every development format in the current executable. Keep code, documentation, ADRs, issue bodies, and commit/PR text in English.

Use deterministic fake agents, reference solutions, and sanitized fixtures for ordinary tests and CI. Never call Codex or another provider in ordinary CI. Tests must fail if the protected behavior is removed. Record exact commands and actual outcomes, including unavailable checks, in the PR. Keep raw technical errors in restricted diagnostics while presenting appropriate user-facing text.

When changing a Codex `config.toml`, validate with the selected Codex CLI: `codex doctor --json` must report `checks.config.load.status` as `ok`, and a supported `--strict-config` invocation must reject unknown fields. For non-active configs, use a dedicated temporary `CODEX_HOME`; never edit the owner's active configuration as a shortcut. These local checks do not authorize provider calls.

Respect existing user changes and staging. Stage only the explicitly requested commit scope, never unstage or restage unrelated files. When a commit is requested, use conventional English and preserve hooks. Stop when the authorized outcome is complete. See [CONTRIBUTING.md](CONTRIBUTING.md) for verification and review guidance.
