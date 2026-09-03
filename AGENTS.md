# Agent Stack Benchmark development instructions

## Current phase and issue boundary

This repository currently contains planning artifacts only. Do not treat the
presence of governance documents as completion of the repository skeleton.
Implement exactly one selected GitHub issue per session and PR. Do not start the
next issue after completing it. Bootstrap work stops after committing its
planning artifacts; it does not implement issue 1.

Before implementation, read the selected issue and linked dependencies, then
`docs/product-spec.md`, `docs/architecture.md`, `docs/methodology.md`,
`docs/security.md`, and relevant ADRs and operations/task guidance. Verify blocking
work is closed and merged, and required owner gates are recorded. Write a short
plan mapped to acceptance criteria and identify evidence this environment cannot
produce. Source inspection is not a successful runtime experiment.

## Architecture and experimental integrity

- Harbor owns environments, agent adaptation, network enforcement, artifact
  collection, trajectories, and separate verification. `benchctl` is a thin
  TypeScript control plane. Python is limited to pinned Harbor/tooling needs.
- No production abstractions before the issue 2 feasibility gate and issue 3
  evidence review. Keep a failed spike isolated; create a narrow fallback issue
  and ADR. Prefer a small Harbor adapter, then host-managed Codex with an ephemeral
  Docker workspace and Harbor verification, then an evaluated Pier replacement.
  Never build a custom sandbox platform or install competing kernels by default.
- Pin tool versions, OCI digests, task bases, and available stable model IDs.
  Record unavailable/provider-hidden identities as `unknown`.
- Revise task, suite, verifier, scoring, environment, runner, and harness identities
  independently. Never silently combine incompatible results.
- Grade observable behavior and evidence-backed repository contracts, not
  resemblance to a reference diff. Preserve score facets and scope violations.
- Compare harnesses contemporaneously using paired, blocked, repeated runs.
  Keep task-quality failure distinct from agent, provider, runner, verifier,
  infrastructure failure, and cancellation. Retain timeout stage and cause.

## Trust boundary

- Agent environments never receive hidden tests, reference solutions, future git
  history, host home directories, Docker sockets, or undeclared secrets.
- Codex authentication uses a dedicated external credential directory. A fresh
  non-auth `CODEX_HOME` and explicit harness are materialized for every run.
  Credentials never enter source control, harnesses, run artifacts, logs, or the
  verifier. Read-only materialization is preferred; refresh behavior needs proof.
- The verifier starts from the immutable base in a fresh separate container, with
  no network and no credentials, and consumes only declared validated artifacts.
- Capture the repository change independently of an agent's voluntary export,
  commit, or success message. Missing, failed, conflicting, or mutable evidence
  blocks a valid grade; Harbor's best-effort collection is not a success signal.
- Preserve immutable raw results. Sanitized publication is a separate derived
  record with provenance, never an in-place rewrite. Potential secrets block
  retention/publication until the security procedure is followed.
- Default Harbor telemetry to `off`; record any explicit owner opt-in.
- Never fabricate subscription monetary cost or buy/redeem provider credits.

## Implementation and verification

Use the simplest change that meets the selected issue. Avoid unrelated refactors,
speculative compatibility, unused abstractions, and dependency churn. Keep code,
documentation, ADRs, issue bodies, and commit/PR text in English.

Use deterministic fake agents, reference solutions, and sanitized fixtures for
ordinary tests and CI. Never call Codex or another provider in ordinary CI.
Tests must fail if the protected behavior is removed. Record exact commands and
actual outcomes, including unavailable checks, in the PR. Keep raw technical
errors in restricted diagnostics while presenting appropriate user-facing text.

When changing a Codex `config.toml`, validate with the selected Codex CLI:
`codex doctor --json` must report `checks.config.load.status` as `ok`, and a
supported `--strict-config` invocation must reject unknown fields. For non-active
configs, use a dedicated temporary `CODEX_HOME`; never edit the owner's active
configuration as a shortcut. These local checks do not authorize provider calls.

Respect existing user changes and staging. Stage only the explicitly requested
commit scope, never unstage or restage unrelated files. Use a conventional English
commit, preserve hooks, and stop after the selected issue. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full Definition of Done and review gates.
