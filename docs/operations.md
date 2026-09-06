# Operations

## Development installation

The development skeleton requires exact versions of Node.js `26.8.1`, pnpm `11.25.0`, Vite+ `0.3.0`, Python `3.14.7`, and uv `0.12.9`. Node `26.8.1` is intentionally the current stable release rather than an LTS release. Locked project dependencies provide Harbor `0.22.0`, Codex CLI `0.153.2`, TypeScript `7.0.2`, Vitest `5.0.0`, Valibot `1.4.2`, its JSON Schema converter `1.7.1`, `smol-toml` `1.8.0`, Markdownlint CLI2 `0.23.2`, Oxlint `1.81.0`, Worsier `3.5.0`, and Ruff `0.16.6`.

Node 26 executes the `benchctl` TypeScript entry point directly; harness commands do not pass the obsolete experimental type-stripping flag.

Vite+ is installed globally and is intentionally not a project dependency. A clean, isolated environment can install the exact required version with:

```sh
curl -fsSL https://vite.plus | VP_VERSION=0.3.0 bash
```

Install the locked environments without authenticating either provider tool:

```sh
vp install --frozen-lockfile
uv sync --locked
```

## Current runnable surface

The aggregate development check is:

```sh
vp run check
```

It runs the following read-only checks in order:

```sh
vp run format:check
vp run lint
vp run typecheck
vp run schemas:check
vp run test
vp run test:planning
vp run validate:planning
vp run verify:toolchain
```

`vp run verify:toolchain` compares every repository runtime and tool version with its exact pin. It invokes Harbor only as `harbor --version` through uv with `HARBOR_TELEMETRY=off`, and invokes Codex only as `codex --version` through the locked project package manager. Neither command logs in or contacts a model provider. The corresponding write-mode formatter is `vp run format`. Worsier runs from the repository root with its default configuration and selects its supported JavaScript, TypeScript, and Vue files; Markdownlint checks every non-ignored Markdown file without a line-length rule and is also available separately as `vp run lint:markdown`; Ruff remains authoritative for the planning Python files. The accepted issue 2 spike remains protected by its reference patch regression.

The versioned schemas are provider-free development inputs:

```sh
vp run schemas:check
vp run schemas:generate
```

The first command regenerates all seven JSON Schema documents in memory, verifies the exact `*.schema.json` inventory, fails on missing, stale, or unexpected files, and never writes in check mode. The second rewrites missing or expected inspection artifacts after an intentional pre-freeze structural change, but fails on unexpected artifacts instead of silently deleting them. Both use Draft 2020-12 and fail on unsupported Valibot constructs. Runtime Valibot validation remains authoritative for relationships and rules that JSON Schema cannot express.

Once v1 is merged, an incompatible shape or semantic change requires v2 and retained v1 validation/artifacts; `schemas:generate` is not a migration mechanism.

## Immutable harness bundles

Issue 5 implements the first production `benchctl` surface. A capture source is a dedicated directory, not an ambient home:

```text
harness-source/
├── AGENTS.md                  # optional
├── AGENTS.override.md         # optional
├── config.toml                # required
├── mcp-tools.json             # required; {"mcp_servers":[]} is valid
├── skills/
│   └── <skill-name>/
│       ├── SKILL.md           # required for every direct child
│       └── ...                # regular descendant files
└── rules/
    └── *.rules                # optional and flat
```

Unknown inputs, all symlinks, special files, unsafe or colliding paths, known Codex auth/history/cache paths, conservative secret patterns, credential-bearing MCP declarations, and external config references fail capture. Each MCP server is either strict `stdio` with `name`, `command`, and optional string `args`, or strict `sse`/`streamable-http` with `name` and an unauthenticated URL. Tool credentials cannot be stored in the bundle; a tool that requires them makes this harness unsupported rather than silently changing the declared tool set.

Capture validates TOML locally and runs the selected workspace Codex `0.153.2` from a fresh temporary workspace with an isolated non-auth home. It requires `codex --strict-config doctor --json` to report `checks["config.load"].status=ok`. Because pinned doctor does not reject unknown fields, capture also runs the accepted provider-free strict-config rejection control against a temporary copy with a final unknown control table and requires the parser to reject that exact control before any `thread.started` event. A different unknown-field error rejects the captured config. Finally, `codex mcp list --json` must return an empty server list. The overall doctor result may still report unavailable auth or network checks. These commands perform no inference. Bundle validation, materialization, and diff repeat the effective-config checks before trusting captured bytes. Unit and CI tests inject a deterministic fake executable and make no Codex or provider call.

Use the root package command:

```sh
vp run benchctl -- harness capture \
  --source /absolute/harness-source \
  --store /absolute/harness-store \
  --id daily-harness \
  --revision v1

vp run benchctl -- harness validate \
  /absolute/harness-store/<64-lowercase-hex-digest>

vp run benchctl -- harness materialize \
  /absolute/harness-store/<64-lowercase-hex-digest> \
  --destination /absolute/new-run-root

vp run benchctl -- harness diff \
  /absolute/harness-store/<left-digest> \
  /absolute/harness-store/<right-digest>
```

Capture, validate, and materialize emit one compact JSON object. Diff emits the two identities followed by sorted identity and entry changes; it prints paths and short digests, never file content. Exit `0` means success or an identical diff, exit `1` means two valid bundles differ, and exit `2` means usage, validation, or integrity failure.

Each bundle is addressed by the SHA-256 of its canonical v1 manifest preimage: fixed identity fields plus path/kind-sorted entries, excluding the manifest's own digest. Entry digests cover raw bytes. Source location, enumeration order, timestamps, ownership, and source modes do not affect identity. The store must be a real mode-`0700` directory outside the physical source tree. Final bundle files are exactly mode `0444` and directories exactly `0555`; validation checks the schema, address, canonical order, exact file/directory inventory, modes, every digest, and the effective pinned-Codex configuration. Existing valid addresses are idempotent and are never overwritten.

Materialization requires a destination that does not exist. It creates a mode `0700` root with `codex-home` for config/global instructions/rules, `home/.agents/skills`, the declared `mcp-tools.json`, and an empty `workspace`. Config, instruction, rule, and MCP files use `0600`; skill files use `0500` so scripts remain executable without retaining source mode variance. It creates no auth, history, session, or cache state. Issue 6 owns the task repository and issue 7 owns Harbor execution and credential injection.

Planning publication remains separate:

```sh
python3 .planning/validate.py
python3 .planning/sync-github.py --check
```

The first command validates local documents and the issue graph without network or providers. The second reads GitHub and checks publication state without mutation. Publication uses `python3 .planning/sync-github.py --apply`; see [planning maintenance](../.planning/README.md). The implemented `benchctl harness` commands above do not run Harbor; run orchestration remains issue 7.

Canonical task materialization creates an agent-visible local Git repository with one deterministic base commit. It does not copy the source object database, refs, remotes, hooks, credentials, alternates, or future history and retains only objects reachable from the new commit. The trusted collector snapshots the stopped workspace twice, ignores agent-controlled Git metadata, and emits exactly `workspace.patch` and `workspace-metadata.json`. Replay checks the exact inventory, hashes, source identity, base commit, safe paths, regular-file types, and final tree before grading. The completed issue 2 spike remains Git-free; issue 14 owns the later private-import path.

## One-run orchestration

Issue 7 adds one deliberately narrow execution command. It consumes a frozen experiment assignment; it does not generate a matrix, schedule another run, resume an existing directory, or retry a failure:

```sh
vp run benchctl -- run \
  --experiment /absolute/experiment.json \
  --run-id assigned-run-id \
  --stack /absolute/stack-a.json \
  --stack /absolute/stack-b.json \
  --harness-document /absolute/harness-a.json \
  --harness-document /absolute/harness-b.json \
  --suite /absolute/suite.json \
  --task /absolute/task-a.json \
  --task-source /absolute/task-source \
  --task-package /absolute/harbor-task \
  --harness-bundle /absolute/harness-store/<selected-digest> \
  --runs-dir /absolute/local-runs \
  --dry-run
```

Repeat `--stack` for every experiment arm, `--harness-document` for every arm harness, and `--task` for every suite task. The resolver applies all v1 schemas and cross-document relationships, then requires exactly one unselected assignment in an `in_progress` block and checks the immutable bundle and source bytes, ready task package, exact runner projection, telemetry, concurrency, retries, resources, and pins. Budget values come only from the experiment and stacks. A known token or turn cap is rejected because the pinned subscription path cannot enforce one. Dry-run prints the safe immutable resolved plan and stops without reading authentication, creating the run directory, or starting Harbor, Docker, or Codex.

A real local execution uses the same command without `--dry-run` and requires an external mode-`0600` regular file selected only through `CODEX_AUTH_JSON_PATH`. The credential must be outside the repository, run storage, documents, harness, task source, and task package; hard links to any input are rejected. The selected path and bytes are absent from arguments, configs, standard output, and records. The runner validates and retains one read-only descriptor, gives Harbor that descriptor as `/dev/fd/3`, and never reopens the pathname. It also supplies a fresh run-local `HOME`, a strict environment allowlist, and no ambient Codex home, API key, or fallback credential. Authentication failure is a provider failure and stops the assigned attempt; issue 10 owns any later retry or resume policy.

The command requires a clean benchmark checkout, a supported macOS Apple Silicon/Docker Desktop host, and locally resolved Linux/arm64 image IDs matching the TaskDocument. It creates `<runs-dir>/<run-id>` exactly once at mode `0700`; an existing ID is never resumed or overwritten. It copies and rehashes only identified input bytes, materializes the selected harness, compiles `AGENTS.override.md` (or `AGENTS.md` when no override exists) after any existing `developer_instructions`, and repeats the pinned Codex doctor and strict-config checks. A separate derived task package replaces mutable image references with the verified immutable image IDs while the copied input package remains unchanged. Task Compose files are parsed structurally and restricted to the exact main/collector/verifier service and named-volume contract; bind mounts, Docker sockets, extra sidecars, build/image overrides, resource overrides, privilege controls, host namespaces, and interpolation are rejected. Policy files under `rules/*.rules` are rejected because Harbor's Codex adapter uses bypass mode and cannot enforce those policies faithfully. The run-local Harbor job uses one task, one attempt, one concurrent trial and agent, zero retries, telemetry off, enforced CPU/RAM overrides, native config/skill/MCP inputs, and Harbor-owned Docker lifecycle.

`initial.json` is atomically written read-only before Harbor starts. Harbor stdout, stderr, job tree, native trajectory, collected artifacts, and verifier files remain under restricted raw evidence. A valid grade requires ordered main-service stop and collector completion evidence, the exact successful Harbor artifact manifest, declared artifact hashes, successful host replay, and a separate credential-free verifier with networking disabled. Every score evidence item must bind to exactly one verifier check with the same facet, outcome, and digest; gates and scope violations must match that evidence. `completion.json` is a second immutable record; the initial record is never extended. Before host replay and grading, and again before completion, the raw tree is checked for the selected credential, credential leaves, and known credential patterns, listed in a canonical manifest, and made read-only. A secret finding moves the raw tree to `quarantine/raw`; a symlink or special entry moves the untouched tree to `quarantine/invalid-raw` and manifests only safe terminal diagnostics. Both cases produce an ungraded runner failure without printing secret bytes. Issue 8 implements publication eligibility, redaction, expiry, and tombstone workflows as separate derived records without rewriting these issue-7 sources.

Harbor `0.22.0` does not provide a host-controlled pause between its collector hook and built-in separate verifier. Consequently, the host scan cannot prove it ran before Harbor exposed collected bytes to that verifier. Issue 7 instead requires the offline verifier's own credential-absence evidence and performs the host scan immediately after Harbor returns, before host replay or grading. This limitation must remain explicit until a later Harbor/adapter revision re-proves a stronger ordering boundary.

Exit `0` means dry-run or `task_success`; exit `1` means a valid graded `task_failure`; exit `2` means usage/input rejection or an ungraded agent, provider, runner, verifier, infrastructure, or cancellation outcome. Never reuse an existing run ID. Recovery starts from the unchanged frozen assignment with a new policy-authorized attempt in issue 10; it does not delete, overwrite, or continue the failed directory.

The ordinary check uses fake process, clock, and host adapters and never needs Docker. The separate supported-host integration uses real Harbor `0.22.0`, locally built deterministic fake Codex `0.153.2`, a public fixture, and no provider:

```sh
vp run run:integration:check
```

It covers successful collection and offline verification, controlled agent failure, cancellation, concurrency one, one attempt, zero retries, telemetry off, immutable image-ID materialization, and `provider_calls: 0`. The last value comes from a host-side provider canary that counts every request to the fake agent's configured API base; it is not an agent self-report. Disposable raw records remain under the printed `/tmp/harness-bench-issue-7-integration-*` path.

## Derived result normalization and disposition

Issue 8 adds an independently versioned derived layer. It never rewrites `initial.json`, `completion.json`, `raw-manifest.json`, or retained raw bytes:

```sh
vp run benchctl -- results normalize /absolute/local-runs/<run-id>
vp run benchctl -- results export \
  /absolute/local-runs/.results/<run-id>/normalized/<sha256>/record.json
vp run benchctl -- results dispose /absolute/local-runs/<run-id> \
  --confirm-run-id <run-id> \
  --reason retention-expired \
  --disposition delete
```

Normalization accepts only a real direct child of its mode-`0700` runs root, with a basename matching the immutable run identity. The run and raw tree must retain issue 7's read-only modes. The command validates the v1 initial and completion schemas, identity and revision links, raw path containment, exact manifest inventory, sizes, executable bits, SHA-256 values, score/reward relationships, and source stability after parsing. It rejects any nested `sha256-manifest.json`, symlink, special entry, incompatible Harbor version, or incompatible ATIF version. The supported parser pins are Harbor `0.22.0`, normalization revision `1`, and ATIF `ATIF-v1.7`; issue 2's legacy layout is not accepted.

A task success or task failure requires a native rollout JSONL, ATIF trajectory, merged `codex.txt`, separate-verifier result, and structured score. Ungraded agent, provider, runner, verifier, infrastructure, or cancellation outcomes never receive a numeric zero; present evidence is referenced and absent evidence is explicit. `codex.txt` remains labelled as irreversibly merged stdout/stderr. Complete Harbor `started_at`/`finished_at` pairs produce whole seconds rounded upward, while incomplete pairs remain unknown. Trial `agent_result` supplies tokens and preserves a reported zero. ATIF totals must agree when present. Harbor `cost_usd` is stored only as an upstream Harbor/Codex/LiteLLM API-price estimate with provenance; subscription money is not applicable.

Derived records use this local layout:

```text
<runs-dir>/.results/<run-id>/
├── normalized/<sha256>/record.json
├── exports/<sha256>/record.json
└── restrictions/<sha256>/record.json
```

Managed parent directories are mode `0700`, address directories are `0500`, and records are `0400`. Serialized references are relative to the immutable run. APIs and CLI output may return the resolved absolute record path to the local caller, but it is not embedded in the record.

A positive credential-pattern finding or an existing issue-7 quarantine produces only a restriction record and exit `2`. It reports safe category/path metadata, blocks publication, and records rotation/revocation and disposition as pending. It never copies the matched value or hashes that value. The CLI output is owner notification, not evidence that an external credential was rotated or revoked.

Export revalidates the exact normalized content address, rebuilds an allowlisted metadata record, scans the completed bytes, and seals it separately. It contains identities and revisions, classifications, score/applicability states, safe evidence digests, timings, usage, and provenance. It excludes local/repository paths and prompt, source, patch, log, trajectory, traceback, and free verifier text. `publication_authorized: false` is deliberate: a passing scan does not prove that every secret is absent and does not grant publication permission. No upload is implemented.

Disposition is private-record lifecycle handling, not a backup manager. `--confirm-run-id` must match exactly. `retention-expired` is allowed only after a private `expires_at`; `owner-request` is private only. Restricted evidence must use `credential-detected` and requires `--credential-action rotated|revoked`, which records an owner attestation rather than performing the external action. Incident retention additionally requires a future expiry:

```sh
vp run benchctl -- results dispose /absolute/local-runs/<run-id> \
  --confirm-run-id <run-id> \
  --reason credential-detected \
  --disposition incident-retain \
  --credential-action revoked \
  --incident-expires-at 2026-12-05T12:00:00Z
```

Deletion stages the exact run and its managed `.results` state, removes them, then leaves a mode-`0500` run directory containing one content-addressed redacted tombstone file. The existing directory prevents run-ID reuse. Incident retention keeps restricted bytes and records the new expiry in a tombstone without changing the raw record. If staging or deletion fails, the command exits `2`, does not install a false `deleted` tombstone, and keeps remaining private bytes restricted. Recover by inspecting the safe diagnostic and exact staged path; do not fabricate completion or reuse the ID. The tool claims nothing about unknown external copies. There is no automatic expiry sweep.

Successful result commands emit JSON and exit `0`. Restricted normalization and all input, integrity, version, export, or lifecycle failures exit `2` with safe diagnostics that omit raw causes. Exit `1` remains exclusive to a valid task-quality failure from `benchctl run`.

## Canonical task calibration

The ordinary aggregate check covers source materialization, artifact validation and replay, task contracts, and all formatted negative-control mutators without Docker or provider calls:

```sh
vp run check
```

Run the complete issue 6 calibration locally on the supported Apple Silicon Docker environment:

```sh
vp run task:canonical:check
```

The command builds the pinned agent, collector, and verifier images first. Image builds may install the locked packages; every subsequent Harbor evaluation runs from those images without downloading dependencies or browsers. Playwright package `1.62.1` and the Chromium/WebKit revisions come from the same official image, pinned by OCI digest.

The command then runs pristine with Harbor `nop`, two valid solutions and every negative control with deterministic `oracle`, and an identical reference replay. Effective concurrency is one, attempts are one, automatic retries are zero, provider calls are zero, and `HARBOR_TELEMETRY` is `off`. The verifier runs in a fresh separate container with `network_mode: none`, no credentials, its own immutable base, and only the two validated declared artifacts. Harbor's implicit `/logs/artifacts` transfer must remain empty. A verifier or integrity failure produces an invalid score and no numeric reward; an ordinary task failure remains a valid graded result.

The command writes its complete local jobs and generated `TaskDocument` to the printed `/tmp/harness-bench-issue-6-*` directory. These are disposable local calibration records, not committed benchmark results. The checked-in [evidence card](tasks/order-receipt.md) records the accepted command shape and latest calibration identities for owner review.

Issue 2 has an isolated historical spike surface outside `benchctl`. The provider-free check remains usable. **Do not run the second command:** all four authorized provider invocations are consumed, and changing the run root does not renew authorization.

```sh
BENCH_RUN_ROOT=/absolute/external/issue-2-root vp run spike:issue-2:check
CODEX_AUTH_JSON_PATH=/absolute/external/codex-home/auth.json \
  BENCH_RUN_ROOT=/absolute/external/issue-2-root \
  vp run spike:issue-2 -- --phase public --run-id public-01
```

The check command builds pinned arm64 images and runs unit, fake-agent collector, public-agent/offline-verifier lifecycle, config, secret-scanner, and offline-verifier controls without a provider invocation. The historical run command executed exactly one selected subscription invocation; it did not choose another phase, retry, or fallback model. It required both explicit paths and rejected an existing run ID.

An explicit `--effort low` override was available for the owner's temporary spike; the default was `medium`. The selected value was recorded in the intent and checked against Harbor/native evidence. Changing effort did not reset the run budget or make mixed-effort samples an identical repeated pair.

The authorized issue 2 budget is now exhausted: one historical restricted-network failure and three successful public-network runs. The third public run was an explicitly authorized one-call extension to complete the low pair after owner go; these command examples do not authorize another run or resetting the budget with a new run root. See the [evidence report](spikes/harbor-codex-subscription.md).

The exact release evidence is recorded in [research](research-snapshot.md). Use the project lockfiles rather than an unversioned global Harbor or Codex installation. Issue 2 pins all relevant OCI images, including agent, verifier, collector, and verifier-only no-network sidecar images. Agent execution has no egress sidecar.

The v1 execution target is macOS on Apple Silicon with Docker Desktop Linux/arm64 containers. Record the macOS version, Apple Silicon model/architecture, Docker Desktop and Engine versions, LinuxKit kernel, and container architecture. The network check must exercise public agent HTTPS and an offline separate verifier through the actual Harbor lifecycle on Docker Desktop. Intel Mac, WSL2, and arbitrary Docker hosts are not supported claims.

## Provider-free CI

The `Check` workflow runs for pull requests and pushes to `master` on the standard `ubuntu-24.04` GitHub-hosted runner with a 15-minute timeout. It uses the official `voidzero-dev/setup-vp` action pinned to an immutable commit, installs Vite+ `0.3.0` and the exact Node.js and pnpm repository pins, then runs `vp install --frozen-lockfile` and `vp run check`. Repository permissions are read-only, checkout credentials are not persisted, Harbor telemetry is off, dependency caches are disabled, and no artifacts are uploaded. The workflow has no configured repository or provider secrets, provider credentials, Harbor execution, Codex execution, login, scheduled job, Windows/WSL2 claim, or benchmark behavior. GitHub still creates an ephemeral `GITHUB_TOKEN` for the job; it is limited to `contents: read`, and checkout does not persist it. Actions can access this token through the [`github.token` context](https://docs.github.com/en/actions/concepts/security/github_token), so it remains part of the CI trust boundary.

Because this repository is public, its standard GitHub-hosted runner usage is free under [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions). Larger runners are excluded. Disabling caches and artifact uploads avoids those storage categories and their incremental charges. GitHub still retains public workflow logs according to the repository's [Actions retention setting](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository), so logs must remain free of credentials and other sensitive data.

## Historical issue 2 authentication

The owner performed login separately from the revised two-invocation budget using a dedicated external `CODEX_HOME`, never the ambient Codex home or a repository path:

```sh
install -d -m 700 /absolute/external/codex-home
install -m 600 spikes/harbor-codex-subscription/harness/config.toml \
  /absolute/external/codex-home/config.toml
CODEX_HOME=/absolute/external/codex-home vp exec codex login
chmod 600 /absolute/external/codex-home/auth.json
```

The spike harness pins `forced_login_method = "chatgpt"` and `cli_auth_credentials_store = "file"`. The runner accepts only the absolute `CODEX_AUTH_JSON_PATH`, rejects group/other-readable or symlinked files and private parent-directory violations, and records only path/source hashes, modes, size, timestamps, and before/after metadata. It never copies the auth file into the run root. This follows the official [Codex authentication flow](https://learn.chatgpt.com/docs/auth). The spike did not exercise token expiry, refresh persistence, or read-only refresh compatibility. An authentication or refresh failure stops the run and requires owner login; it does not trigger an API-auth fallback or automatic retry.

`auth.json` contains plaintext access tokens and is password-equivalent. Never put it in source control, an issue/ticket, chat, logs, artifacts, a shared folder, or an uncontrolled cloud-sync/backup path. Do not duplicate it casually; only the owner and the explicit local run receive access.

Harbor creates fresh `/tmp/codex-home` and `/tmp/codex-secrets` volumes for every trial. The native session is copied to agent logs before best-effort cleanup, while the collector records only safe cleanup booleans. Do not use `codex exec --ephemeral` because the spike requires native JSONL evidence. The pinned config is checked with `codex doctor --json`, a positive `codex --strict-config doctor --json`, and a negative unknown-field case.

In pinned CLI 0.153.2, require `checks["config.load"].status=ok` in both doctor reports, not overall exit zero: the provider-free container deliberately has no auth or network, so those unrelated checks fail. Doctor does not reject an unknown top-level key even with `--strict-config`. The negative control therefore uses `codex exec --strict-config --skip-git-repo-check --json` against a copied config with an unknown field, inside Docker with no network or credentials. It must exit before any `thread.started` event and explicitly report the unknown configuration field. This proves parser rejection without making a provider request.

Before the first revised inference, the owner received one redacted run card covering two identical public-network invocations; model `gpt-5.6-luna`; effort `medium`; ChatGPT file auth; exact image IDs; network policy; concurrency `1`; retries `0`; agent/verifier/build timeouts `600`/`120`/`900` seconds; CPU `2`; and RAM `2 GiB`. The owner explicitly authorized those two invocations. The earlier restricted-network approval did not reset or authorize a different protocol. Provider-backed runs are local only and never automatic CI.

## Telemetry, artifacts, and quota

All future local benchmark commands default to `HARBOR_TELEMETRY=off`, including spike and regrade commands. Record the effective setting and owner-authorized exceptions. Upstream enables usage telemetry by default. [Pinned telemetry documentation](https://github.com/harbor-framework/harbor/blob/4407eb5227a2ff4f0d3f16b2eb48849382fdf276/docs/content/docs/usage-stats.mdx).

The issue 2 run root is a required absolute external `BENCH_RUN_ROOT` with mode `0700`; each run is staged there, secret-scanned, hashed, and made read-only. A suspected secret leaves the record quarantined and blocks commit/publication. Immutable raw records contain source-sensitive data; only explicitly sanitized derived exports can be considered for sharing. Credentials never enter that root.

A positive credential finding immediately restricts access and triggers owner notification plus rotation/revocation. The staged content is then deleted under the declared disposal policy or retained only in owner-approved incident storage. Keep an immutable redacted intent-linked tombstone with identifiers, non-secret hashes, timestamps, response status, and reason, but no source or secret bytes.

Before every private task/run, record a retention deadline; the default is 90 days. Raw records are immutable while retained, not permanent. At expiry or on owner request, remove the private content from managed storage and controlled backups according to their lifecycle, then retain only an immutable redacted deletion tombstone with identifiers, safe provenance, timestamp, and reason.

V1 subscription concurrency is exactly one. Record requested/effective concurrency and enforcement status. Complete both arms of each task/replicate block within 24 hours of the first arm start. A known model, CLI, provider, runner, Harbor-config, or harness change invalidates the block and requires a complete new block with new IDs. Record observed usage/quota when exposed, otherwise `unknown`; do not estimate subscription money using API rates. On quota or authentication failure, retain safe diagnostics and stop/resume under a declared policy. Do not purchase credits, redeem resets, switch billing modes, or retry indefinitely. Estimated invocation count is not a quota guarantee.

Issue 2 revision `public-1` permits at most two identical public-network invocations, sequentially. There is no discovery phase, hostname allowlist, packet observer, or agent egress proxy. Built-in Codex web search remains disabled in this fixed harness; that tool setting is distinct from internet access available to shell commands. Any timeout or infrastructure failure is retained without automatic retry.

Use a fresh external run root for this revision. Image locks, preflight reports, intents, and completions carry `protocolRevision: public-1`; the runner rejects old records, changed images, duplicate IDs, and a third invocation. Preserve the earlier restricted-network run and no-go without editing or merging its results.

For the completed one-call extension only, `issue-2-low-confirmation` reused the byte-identical image lock and preflight from `issue-2-public-1-final`, with current image IDs rechecked before execution. Its `public-03` intent has root-local `invocation: 1` but is invocation four overall. The unchanged per-root two-call guard is not authorization for another call; the explicit extension allowed one, now consumed. No Docker controls or images were rebuilt for this evidence-only confirmation. See the report for source hashes and the actual command.

## Recovery and regrade

Preserve failed attempts and stage-specific termination reasons. Resume from the frozen plan, skipping only completed immutable IDs. Regrade uses retained declared artifacts and a new separate offline verifier; it never reruns the agent or overwrites source results. Verify hashes and source lineage first. Missing inputs require a new explicitly authorized run, not invented reconstruction.

## Required owner reviews

An owner review is a go/no-go decision over a short redacted evidence card prepared by the implementing agent; it is not a request for the owner to run Harbor, inspect raw credentials, or invent a test procedure. The owner confirms that the stated risk, task realism, or result is acceptable, or says what must change.

After issue 2: auth safety, daily-stack fidelity, public-agent/offline-verifier boundaries, collection, and trace/usage quality. After issue 6: task realism and fair latent contracts. After issue 13: full dry run plus one explicitly authorized subscription canary before private import. After issue 16: freeze tasks. After issue 17: inspect raw evidence before accepting findings or starting justified M4 work.

M4 may add provider-free CI integrity checks, static reports, and separately opted-in metered schedules. No scheduled job is enabled by this planning run or v1.
