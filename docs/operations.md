# Operations

## Development installation

The development skeleton requires exact versions of Node.js `26.8.1`, pnpm
`11.25.0`, Python `3.14.7`, and uv `0.12.9`. Node `26.8.1` is intentionally the
current stable release rather than an LTS release. Locked project dependencies
provide Harbor `0.22.0`, Codex CLI `0.153.2`, TypeScript `7.0.2`, Vitest `5.0.0`,
Oxlint `1.81.0`, Prettier `3.9.6`, and Ruff `0.16.6`.

Install the locked environments without authenticating either provider tool:

```sh
pnpm install --frozen-lockfile
uv sync --locked
```

## Current runnable surface

The aggregate development check is:

```sh
pnpm check
```

It runs the following read-only checks in order:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:planning
pnpm validate:planning
pnpm verify:toolchain
```

`pnpm verify:toolchain` compares every actual version with its exact pin. It invokes
Harbor only as `harbor --version` through uv with `HARBOR_TELEMETRY=off`, and invokes
Codex only as `codex --version` through pnpm. Neither command logs in or contacts a
model provider. The corresponding write-mode formatter is `pnpm format`.

Planning publication remains separate:

```sh
python3 .planning/validate.py
python3 .planning/sync-github.py --check
```

The first command validates local documents and the issue graph without network or
providers. The second reads GitHub and checks publication state without mutation.
Publication uses `python3 .planning/sync-github.py --apply`; see
[planning maintenance](../.planning/README.md). No `benchctl` command exists yet.

Future task materialization creates an agent-visible local Git repository with one
base commit. It does not copy the source object database, refs, remotes, hooks,
credentials, or future history and retains only objects reachable from the new
commit. The completed issue 2 spike remains Git-free; issue 6 and issue 14 own
implementation and verification of the accepted Git shape.

Issue 2 has an isolated spike surface outside `benchctl`:

```sh
BENCH_RUN_ROOT=/absolute/external/issue-2-root pnpm spike:issue-2:check
CODEX_AUTH_JSON_PATH=/absolute/external/codex-home/auth.json \
  BENCH_RUN_ROOT=/absolute/external/issue-2-root \
  pnpm spike:issue-2 -- --phase public --run-id public-01
```

The check command builds pinned arm64 images and runs unit, fake-agent collector,
public-agent/offline-verifier lifecycle, config, secret-scanner, and offline-verifier controls without a
provider invocation. The run command executes exactly one selected subscription
invocation; it does not choose another phase, retry, or fallback model. It requires
both explicit paths and rejects an existing run ID.

An explicit `--effort low` override is available for the owner's temporary spike;
the default remains `medium`. The selected value is recorded in the intent and
checked against Harbor/native evidence. Changing effort does not reset the run
budget or make mixed-effort samples an identical repeated pair.

The authorized issue 2 budget is now exhausted: one historical restricted-network
failure and three successful public-network runs. The third public run was an
explicitly authorized one-call extension to complete the low pair after owner go;
these command examples do not authorize another run or resetting the budget with
a new run root. See the [evidence report](spikes/harbor-codex-subscription.md).

The exact release evidence is recorded in [research](research-snapshot.md). Use
the project lockfiles rather than an unversioned global Harbor or Codex installation.
Issue 2 pins all relevant OCI images, including agent, verifier, collector, and
verifier-only no-network sidecar images. Agent execution has no egress sidecar.

The v1 execution target is macOS on Apple Silicon with Docker Desktop Linux/arm64
containers. Record the macOS version, Apple Silicon model/architecture, Docker
Desktop and Engine versions, LinuxKit kernel, and container architecture. The
network check must exercise public agent HTTPS and an offline separate verifier
through the actual Harbor lifecycle on Docker Desktop. Intel Mac, WSL2, and arbitrary Docker hosts are not supported claims.

## Provider-free CI

The `Check` workflow runs for pull requests and pushes to `master` on the standard
`ubuntu-24.04` GitHub-hosted runner with a 15-minute timeout. It installs only from
the committed pnpm and uv lockfiles and runs `pnpm check`. Repository permissions
are read-only, checkout credentials are not persisted, Harbor telemetry is off,
dependency caches are disabled, and no artifacts are uploaded. The workflow has no
configured repository or provider secrets, provider credentials, Harbor execution,
Codex execution, login, scheduled job, Windows/WSL2 claim, or benchmark behavior.
GitHub still creates an ephemeral `GITHUB_TOKEN` for the job; it is limited to
`contents: read`, and checkout does not persist it. Actions can access this token
through the [`github.token` context](https://docs.github.com/en/actions/concepts/security/github_token),
so it remains part of the CI trust boundary.

Because this repository is public, its standard GitHub-hosted runner usage is
free under [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Larger runners are excluded. Disabling caches and artifact uploads avoids those
storage categories and their incremental charges. GitHub still retains public
workflow logs according to the repository's
[Actions retention setting](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository),
so logs must remain free of credentials and other sensitive data.

## Authentication and first execution

The owner performs login separately from the revised two-invocation budget. Use a
dedicated external `CODEX_HOME`, never the ambient Codex home or a repository path:

```sh
install -d -m 700 /absolute/external/codex-home
install -m 600 spikes/harbor-codex-subscription/harness/config.toml \
  /absolute/external/codex-home/config.toml
CODEX_HOME=/absolute/external/codex-home pnpm exec codex login
chmod 600 /absolute/external/codex-home/auth.json
```

The spike harness pins `forced_login_method = "chatgpt"` and
`cli_auth_credentials_store = "file"`. The runner accepts only the absolute
`CODEX_AUTH_JSON_PATH`, rejects group/other-readable or symlinked files and private
parent-directory violations, and records only path/source hashes, modes, size,
timestamps, and before/after metadata. It never copies the auth file into the run
root. This follows the official
[Codex authentication flow](https://learn.chatgpt.com/docs/auth). The spike did not
exercise token expiry, refresh persistence, or read-only refresh compatibility.
An authentication or refresh failure stops the run and requires owner login; it
does not trigger an API-auth fallback or automatic retry.

Harbor creates fresh `/tmp/codex-home` and `/tmp/codex-secrets` volumes for every
trial. The native session is copied to agent logs before best-effort cleanup, while
the collector records only safe cleanup booleans. Do not use `codex exec --ephemeral`
because the spike requires native JSONL evidence. The pinned config is checked with
`codex doctor --json`, a positive `codex --strict-config doctor --json`, and a
negative unknown-field case.

In pinned CLI 0.153.2, require `checks["config.load"].status=ok` in both doctor
reports, not overall exit zero: the provider-free container deliberately has no
auth or network, so those unrelated checks fail. Doctor does not reject an unknown
top-level key even with `--strict-config`. The negative control therefore uses
`codex exec --strict-config --skip-git-repo-check --json` against a copied config
with an unknown field, inside Docker with no network or credentials. It must exit
before any `thread.started` event and explicitly report the unknown configuration
field. This proves parser rejection without making a provider request.

Before the first revised inference, present one redacted run card covering two
identical public-network invocations; model `gpt-5.6-luna`; effort
`medium`; ChatGPT file auth; exact image IDs; network policy; concurrency `1`;
retries `0`; agent/verifier/build timeouts `600`/`120`/`900` seconds; CPU `2`; and
RAM `2 GiB`. Obtain one explicit owner authorization for those two invocations. The earlier restricted-network approval does not
reset or authorize a different protocol.
Provider-backed runs are local only and never automatic CI.

## Telemetry, artifacts, and quota

All future local benchmark commands default to `HARBOR_TELEMETRY=off`, including
spike and regrade commands. Record the effective setting and owner-authorized
exceptions. Upstream enables usage telemetry by default.
[Pinned telemetry documentation](https://github.com/harbor-framework/harbor/blob/4407eb5227a2ff4f0d3f16b2eb48849382fdf276/docs/content/docs/usage-stats.mdx).

The issue 2 run root is a required absolute external `BENCH_RUN_ROOT` with mode
`0700`; each run is staged there, secret-scanned, hashed, and made read-only. A
suspected secret leaves the record quarantined and blocks commit/publication.
Immutable raw records contain source-sensitive data; only explicitly sanitized
derived exports can be considered for sharing. Credentials never enter that root.

Default subscription concurrency is one. Record observed usage/quota when exposed,
otherwise `unknown`; do not estimate subscription money using API rates. On quota
or authentication failure, retain safe diagnostics and stop/resume under a declared
policy. Do not purchase credits, redeem resets, switch billing modes, or retry
indefinitely. Estimated invocation count is not a quota guarantee.

Issue 2 revision `public-1` permits at most two identical public-network invocations,
sequentially. There is no discovery phase, hostname allowlist, packet observer, or
agent egress proxy. Built-in Codex web search remains disabled in this fixed
harness; that tool setting is distinct from internet access available to shell
commands. Any timeout or infrastructure failure is retained without automatic retry.

Use a fresh external run root for this revision. Image locks, preflight reports,
intents, and completions carry `protocolRevision: public-1`; the runner rejects
old records, changed images, duplicate IDs, and a third invocation. Preserve the
earlier restricted-network run and no-go without editing or merging its results.

For the completed one-call extension only, `issue-2-low-confirmation` reused the
byte-identical image lock and preflight from `issue-2-public-1-final`, with current
image IDs rechecked before execution. Its `public-03` intent has root-local
`invocation: 1` but is invocation four overall. The unchanged per-root two-call
guard is not authorization for another call; the explicit extension allowed one,
now consumed. No Docker controls or images were rebuilt for this evidence-only
confirmation. See the report for source hashes and the actual command.

## Recovery and regrade

Preserve failed attempts and stage-specific termination reasons. Resume from the
frozen plan, skipping only completed immutable IDs. Regrade uses retained declared
artifacts and a new separate offline verifier; it never reruns the agent or
overwrites source results. Verify hashes and source lineage first. Missing inputs
require a new explicitly authorized run, not invented reconstruction.

## Required owner reviews

After issue 2: auth safety, daily-stack fidelity, public-agent/offline-verifier boundaries, collection,
and trace/usage quality. After issue 6: task realism and fair latent contracts.
After issue 13: full dry run plus one explicitly authorized subscription canary
before private import. After issue 16: freeze tasks. After issue 17: inspect raw
evidence before accepting findings or starting justified M4 work.

M4 may add provider-free CI integrity checks, static reports, and separately opted-in
metered schedules. No scheduled job is enabled by this planning run or v1.
