# Operations

## Current runnable surface

Only planning maintenance exists:

```sh
python3 .planning/validate.py
python3 .planning/sync-github.py --check
```

The first command validates local documents and the issue graph without network or
providers. The second reads GitHub and checks publication state without mutation.
Publication uses `python3 .planning/sync-github.py --apply`; see
[planning maintenance](../.planning/README.md). No `benchctl` command exists yet.

## Planned installation

Issue 1 selects exact Node, pnpm, Python, and uv versions and locks the environments.
Research candidates are `harbor==0.22.0` and `@openai/codex@0.153.0`, with release
SHAs in [research](research-snapshot.md). Python must satisfy Harbor's declared
minimum 3.12, but the project will pin a specific supported patch version. Use
project-local uv locking; do not rely on an unversioned global Harbor installation.
Pin all relevant OCI images, including verifier and any collector/egress sidecars.

The execution target is Windows/WSL2 with Docker Linux containers. Record Docker,
WSL, kernel, and image identity. The planning host is macOS; no Windows/WSL runtime
result has been produced here. Issue 2 must verify the actual target runtime's
network capabilities rather than extrapolate from this host.

## Authentication and first execution

Issue 2 discovers the exact one-time login command, minimum credential layout,
refresh behavior, and measured host allowlist from official docs and local evidence.
Use a dedicated external directory such as
`~/.agent-stack-bench/credentials/codex/`. The researched Harbor selector
`CODEX_AUTH_JSON_PATH` accepts a specific file; do not use the ambient-home fallback.
This is a researched interface, not a validated setup recipe.

Create a fresh non-auth Codex home for every run. Preserve only the explicitly
captured harness and minimum auth material. Do not reuse history, sessions, caches,
or plugin state across trials. Retain native rollout evidence separately after
safe capture; an ephemeral home does not mean suppressing all session logs with
`codex exec --ephemeral`. Validate any produced config with the pinned CLI.

Before a real invocation, show the resolved stack, identity digests, budgets,
concurrency, and planned invocation count. Provider-backed runs are explicit local
operations, never automatic CI. Fail if requested identity, auth mode, required
tooling, or enforced network policy cannot be established.

## Telemetry, artifacts, and quota

All future local benchmark commands default to `HARBOR_TELEMETRY=off`, including
spike and regrade commands. Record the effective setting and owner-authorized
exceptions. Upstream enables usage telemetry by default.
[Pinned telemetry documentation](https://github.com/harbor-framework/harbor/blob/4407eb5227a2ff4f0d3f16b2eb48849382fdf276/docs/content/docs/usage-stats.mdx).

The configurable run root defaults to `.agent-stack-bench/runs/<run-id>/` and must
be ignored by issue 1. For private tasks prefer an external restricted directory.
Immutable raw records contain source-sensitive data; only explicitly sanitized
derived exports can be considered for sharing. Credentials never enter that root.

Default subscription concurrency is one. Record observed usage/quota when exposed,
otherwise `unknown`; do not estimate subscription money using API rates. On quota
or authentication failure, retain safe diagnostics and stop/resume under a declared
policy. Do not purchase credits, redeem resets, switch billing modes, or retry
indefinitely. Estimated invocation count is not a quota guarantee.

## Recovery and regrade

Preserve failed attempts and stage-specific termination reasons. Resume from the
frozen plan, skipping only completed immutable IDs. Regrade uses retained declared
artifacts and a new separate offline verifier; it never reruns the agent or
overwrites source results. Verify hashes and source lineage first. Missing inputs
require a new explicitly authorized run, not invented reconstruction.

## Required owner reviews

After issue 2: auth safety, daily-stack fidelity, network enforcement, collection,
and trace/usage quality. After issue 6: task realism and fair latent contracts.
After issue 13: full dry run plus one explicitly authorized subscription canary
before private import. After issue 16: freeze tasks. After issue 17: inspect raw
evidence before accepting findings or starting justified M4 work.

M4 may add provider-free CI integrity checks, static reports, and separately opted-in
metered schedules. No scheduled job is enabled by this planning run or v1.
