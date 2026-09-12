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

The first command regenerates all seven JSON Schema documents in memory, verifies the exact `*.schema.json` inventory, fails on missing, stale, or unexpected files, and never writes in check mode. The second rewrites missing or expected inspection artifacts after an intentional schema change, but fails on unexpected artifacts instead of silently deleting them. Both use Draft 2020-12 and fail on unsupported Valibot constructs. Runtime Valibot validation remains authoritative for relationships and rules that JSON Schema cannot express.

Follow the [pre-release schema policy](architecture.md#versioned-document-boundary): identify incompatible formats explicitly, preserve historical evidence with its producing commit, and add current-code compatibility only when needed. `schemas:generate` is not a migration mechanism. Documentation-only work needs relevant lint and planning validation, not a new full Docker calibration.

## Task integrity doctor

Run doctor against one prepared task definition:

```sh
vp run benchctl -- doctor /absolute/doctor-definition.json \
  --output-dir /absolute/new-doctor-record --purpose smoke
```

The default purpose is `quality`. Missing, invalid, or `unknown` online-reachability assessments block either purpose. A recorded `ineligible` task passes only with explicit `--purpose smoke`, a visible warning, and `allowed_use: smoke`; public `order-receipt` must use that mode. An eligible assessment is recorded evidence, not a proof of global Internet secrecy.

Doctor requires local immutable image IDs matching `TaskDocument`, Harbor `0.22.0`, and macOS Apple Silicon with Docker Desktop Linux/arm64. It never builds images or falls back to static-only success. Prepare images and a Harbor package first. `vp run task:canonical:check` prepares one shared base package and separate solution directories, then calls the same doctor CLI, including all thirteen negative controls and a second reference run. It also requires exact canonical numeric facets, rewards, and composites from the retained scores and writes their paths and digests to `canonical-score-checks.json` beside the doctor directory. The generated definition path is printed for subsequent diagnostics with a new output directory.

Doctor validates the existing task schema v1, prompt/source/base identity, exact pnpm dependency pins and lockfile, bundle contents and modes, Compose/service/volume/artifact declarations, and separate offline verification. Bundle inspection does not execute Codex; effective Codex configuration remains the separate harness workflow below. The provider-free canonical and integration fixtures use a content-only synthetic bundle, which is not evidence of an effective native configuration.

After input checks, Harbor runs only built-in `nop` and `oracle`, sequentially, one attempt with zero retries and telemetry off. Each child receives a fresh home and an environment allowlist without provider credentials. The trusted nop collection hook checks the one-commit Git repository, declared hidden-material absences, credential variables, and installed dependency versions. Saved agent image layers are inspected for declared forbidden paths even if later layers delete them. Oracle's deliberately uploaded solution is never used as absence evidence. The verifier must independently report no credentials and loopback-only interfaces. Exact successful stop/collector/artifact manifests are required before patch replay.

The new output directory is created exclusively as `0700`, outside input trees. It contains `initial.json` binding input and tooling digests before execution, `report.json` (doctor report v1 / `doctor-v1`), `evidence-manifest.json`, and `raw/` with input snapshots, host/image evidence, Harbor jobs, diagnostics, and control outcomes. The inventory includes directories and exact file digests; links, special files, extra or missing entries, duplicate/conflicting records, unsafe paths, and nested `sha256-manifest.json` are rejected. Inputs and completed raw cases are reread before finalization. Clean evidence is sealed read-only without overwriting an existing record. Potential secrets or unsafe inventory are moved unchanged under restricted `quarantine/raw`; a safe restriction record blocks use and publication pending the security procedure. Credential-bearing input identifiers are omitted from the derived initial/report digest maps; their original bytes remain only in quarantined inputs.

The English terminal renderer reports stable check and failure codes, `passed`, `failed`, `warning`, or `not_run`, reasons, and next actions. Raw technical errors remain in restricted diagnostics. Exit `0` means all required checks for the selected purpose passed, `1` means a diagnosed problem, and `2` means invocation, infrastructure, interruption, or restricted evidence. Expected pristine and negative-control failures count as successful calibration checks. Timeout/cancellation records retain the stage and process outcome, including cancellation during host inspection. A persistent abort signal also prevents a prepared control from starting after cancellation and stops an active Harbor child using the bounded shutdown grace. Harbor owns normal resource cleanup. Doctor derives the exact main and separate-verifier Compose projects from retained Harbor trial identities, checks containers, volumes, and networks by `com.docker.compose.project`, and retains the queried inventory in `raw/cleanup.json`. Missing ownership evidence or remaining resources blocks cleanup success. Inspect the retained project labels and Harbor Compose configuration before removing only confirmed abandoned resources; never use a global prune.

Run the separate local synthetic integration suite with:

```sh
vp run doctor:integration:check
```

It exercises real Harbor/Docker boundaries with deterministic solutions and deliberate network, credential, visibility, collector, and artifact failures. A provider endpoint canary reports only requests it observes; an executable and Harbor-config audit separately enforces the absence of provider launches. Ordinary CI remains Docker-free and provider-free. Doctor does not test authentication refresh, other host platforms, global material discoverability, or regrade stored runs.

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

Canonical task materialization creates an agent-visible local Git repository with one deterministic base commit. It does not copy the source object database, refs, remotes, hooks, credentials, alternates, or future history and retains only objects reachable from the new commit. The trusted collector snapshots the stopped workspace twice, ignores agent-controlled Git metadata, and emits exactly `workspace.patch` and `workspace-metadata.json`. Replay checks the exact inventory, hashes, source identity, base commit, safe paths, regular-file types, and final tree before grading. The completed issue 2 spike remains Git-free.

## Task source import

Issue 14 adds a local, provider-free import lifecycle for one exact Git SHA-1 commit:

```sh
vp run benchctl -- task import /absolute/task-import-definition.json \
  --store /absolute/external/task-imports

vp run benchctl -- task validate \
  /absolute/external/task-imports/<64-lowercase-hex-digest>

vp run benchctl -- task materialize \
  /absolute/external/task-imports/<64-lowercase-hex-digest> \
  --destination /absolute/new-workspace
```

The definition selects an absolute local repository, full lowercase commit, opaque repository ID, optional known merged-PR ancestry, explicit `eligible` or `ineligible` online-reachability decision, and public/private retention. The store must be a real mode-`0700` directory outside both the complete source Git worktree and this checkout; passing a nested repository directory does not weaken that check. Import never clones, fetches, calls GitHub, runs filters or hooks, or follows symlinks. It rejects submodules, Git LFS hydration, symlinks, special modes, unsafe/colliding paths, files the source reader would omit, credential-like names/content, and non-SHA-1 commit identities.

Definitions and retained metadata are bounded and scanned before storage. Task and repository identifiers are at most 100 characters, task revisions are short identifier tokens, and reachability reasons must not contain credentials, URLs, absolute paths, or control characters. A definition or stored JSON file is at most 1 MiB. One import accepts at most 10,000 regular files, 64 MiB per file, and 256 MiB in total; larger sources fail closed before finalization.

An active address contains only `manifest.json` and `source/`. The manifest contains safe provenance and hashes, not the repository path, remote URL, Git config, prompt, or source bytes. Its `materialized_base_commit`, `source_digest`, reachability, and retention map directly into the existing `TaskDocument`; pass its `source/` to `task_source`. Image building, verifier authoring, and package preparation remain explicit existing steps.

Dispose one private import only after inspecting the exact address and digest:

```sh
vp run benchctl -- task dispose /absolute/external/task-imports/<digest> \
  --confirm-import-digest sha256:<64-lowercase-hex> \
  --reason owner-request
```

`retention-expired` is valid only at or after expiry. `credential-detected` also requires `--credential-action rotated|revoked`; this emergency path still accepts a content-addressed, schema-valid manifest when the source itself now fails credential or integrity scanning. Public imports are immutable and rejected by this lifecycle.

Every address operation uses the same restricted reservation, so import, validation, materialization, disposal, and recovery cannot race through one address. Disposal seals the complete tombstone before moving or deleting source bytes. A failure before deletion restores and revalidates the active import. A failure after deletion, during tombstone installation, or during reservation cleanup returns exit `2` and keeps the reservation plus restricted deterministic recovery state. After confirming that no disposal process is still active, complete that state with the exact digest:

```sh
vp run benchctl -- task recover /absolute/external/task-imports/<digest> \
  --confirm-import-digest sha256:<64-lowercase-hex>
```

Recovery restores and validates staged active source when deletion did not finish, or installs the already sealed tombstone when managed source is gone. It rejects a live disposal owner, conflicting paths, incomplete state, and a mismatched digest. Only after the final tombstone or restored source validates and reservation removal succeeds does the command report success. External repositories and backups are not managed, and there is no automatic expiry sweep.

All task commands emit one compact JSON object. Exit `0` means success. Usage, integrity, conflict, and lifecycle failures return exit `2` with a safe error code and no source bytes or remote URL. `vp run task:canonical:check` now creates a sanitized repository with future history and extra Git state, imports only its base commit, and passes the imported source through the existing package and doctor smoke calibration. It makes no provider call.

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

A real local execution uses the same command without `--dry-run` and requires an external mode-`0600` regular file selected only through `CODEX_AUTH_JSON_PATH`. The credential must be outside the repository, run storage, documents, harness, task source, and task package; hard links to any input are rejected. The selected path and bytes are absent from arguments, configs, standard output, and records. The runner validates and retains one read-only source descriptor. Immediately before Harbor starts, it copies the validated bytes into a private temporary mode-`0700` directory with a mode-`0600` `auth.json`. Harbor receives only the temporary regular-file path through `CODEX_AUTH_JSON_PATH`; the runner never reopens the selected pathname and removes the temporary transport as soon as Harbor returns or throws. It also supplies a fresh run-local `HOME`, a strict environment allowlist, and no ambient Codex home, API key, or fallback credential. Authentication failure is a provider failure and stops the assigned attempt; issue 10 owns any later retry or resume policy.

The command requires a clean benchmark checkout, a supported macOS Apple Silicon/Docker Desktop host, and locally resolved Linux/arm64 image IDs matching the TaskDocument. The task package must declare an agent user that exactly matches the pinned image's Docker `Config.User` and resolves to an effective UID other than `0`; production and doctor preflight both check this. This lets Harbor install private mode-`0600` configuration and authentication files for the non-root agent without weakening their permissions. It creates `<runs-dir>/<run-id>` exactly once at mode `0700`; an existing ID is never resumed or overwritten. It copies and rehashes only identified input bytes, materializes the selected harness, compiles `AGENTS.override.md` (or `AGENTS.md` when no override exists) after any existing `developer_instructions`, and repeats the pinned Codex doctor and strict-config checks. A separate derived task package replaces mutable image references with the verified immutable image IDs while the copied input package remains unchanged. Task Compose files are parsed structurally and restricted to the exact main/collector/verifier service and named-volume contract; bind mounts, Docker sockets, extra sidecars, build/image overrides, resource overrides, privilege controls, host namespaces, and interpolation are rejected. Policy files under `rules/*.rules` are rejected because Harbor's Codex adapter uses bypass mode and cannot enforce those policies faithfully. The run-local Harbor job uses one task, one attempt, one concurrent trial and agent, zero retries, telemetry off, enforced CPU/RAM overrides, native config/skill/MCP inputs, and Harbor-owned Docker lifecycle.

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

Normalization accepts only a real direct child of its mode-`0700` runs root, with a basename matching the immutable run identity. The run and raw tree must retain issue 7's read-only modes. The command validates the v1 initial and completion schemas, identity and revision links, raw path containment, exact manifest inventory, sizes, executable bits, streamed SHA-256 values, score/reward relationships, and source stability after parsing. A valid grade binds completion collection digests to the retained trial log, exact artifact manifest, collector metadata, and collected patch, and binds ATIF agent identity to the initial record. Sealed initial/completion/manifest metadata and final normalized bytes receive the credential-pattern scan before any normalized record is stored. The command rejects any nested `sha256-manifest.json`, symlink, special entry, incompatible Harbor version, or incompatible ATIF version. The supported parser pins are Harbor `0.22.0`, normalization revision `1`, and ATIF `ATIF-v1.7`; issue 2's legacy layout is not accepted.

A task success or task failure requires a native rollout JSONL, ATIF trajectory, merged `codex.txt`, separate-verifier result, and structured score. Ungraded agent, provider, runner, verifier, infrastructure, or cancellation outcomes never receive a numeric zero; present evidence is referenced and absent evidence is explicit. `codex.txt` remains labelled as irreversibly merged stdout/stderr. Complete Harbor `started_at`/`finished_at` pairs produce whole seconds rounded upward, while incomplete pairs remain unknown. Trial `agent_result` supplies tokens and preserves a reported zero. ATIF totals must agree when present. Harbor `cost_usd` is stored only as an upstream Harbor/Codex/LiteLLM API-price estimate with provenance; subscription money is not applicable.

Derived records use this local layout:

```text
<runs-dir>/.results/<run-id>/
├── normalized/<sha256>/record.json
├── exports/<sha256>/record.json
├── regrades/<sha256>/{record.json,inputs/,raw/,raw-manifest.json}
└── restrictions/<sha256>/record.json

<runs-dir>/.experiments/migrations/<sha256>/record.json
```

Managed parent directories are mode `0700`, address directories are `0500`, and records are `0400`. Serialized references are relative to the immutable run. APIs and CLI output may return the resolved absolute record path to the local caller, but it is not embedded in the record.

Normalization, export, regrade, and disposition serialize through a transient mode-`0600` per-run lock below `<runs-dir>/.results/.locks`. Normalization holds the lock from source validation through its normalized or restriction commit; export holds it from normalized-record validation through its export commit. Batch regrade and normalized-run disposition take the experiment-family lease before any result lease because migration manifests are shared across runs; batch regrade then takes every source-run result lease in lexical order. Lock contention fails closed; a stale lock after process termination requires trusted local inspection and removal only after confirming that no result operation is active.

A positive credential-pattern finding or an existing issue-7 quarantine produces only a restriction record and exit `2`. It reports safe category/path metadata, blocks publication, and records rotation/revocation and disposition as pending. It never copies the matched value or hashes that value. The CLI output is owner notification, not evidence that an external credential was rotated or revoked.

Export revalidates the exact normalized content address, rebuilds an allowlisted metadata record field by field, rejects path-bearing metadata, scans the completed bytes, rechecks restriction state while holding the per-run lock, and seals the record separately. It contains identities and revisions, classifications, score/applicability states, safe evidence digests, timings, usage, and provenance. It excludes local/repository paths and prompt, source, patch, log, trajectory, traceback, and free verifier text. `publication_authorized: false` is deliberate: a passing scan does not prove that every secret is absent and does not grant publication permission. No upload is implemented.

Disposition is private-record lifecycle handling, not a backup manager. `--confirm-run-id` must match exactly. `retention-expired` is allowed only after a private `expires_at`; `owner-request` is private only. Restricted evidence must use `credential-detected` and requires `--credential-action rotated|revoked`, which records an owner attestation rather than performing the external action. Incident retention additionally requires a future expiry:

```sh
vp run benchctl -- results dispose /absolute/local-runs/<run-id> \
  --confirm-run-id <run-id> \
  --reason credential-detected \
  --disposition incident-retain \
  --credential-action revoked \
  --incident-expires-at 2026-12-05T12:00:00Z
```

Deletion first validates the exact `.results/<run-id>` category/address/record inventory, modes, schemas, identities, and content addresses. It then installs a durable mode-`0400` `<runs-dir>/.run-reservations/<run-id>` sentinel before moving the canonical run, stages the exact run and managed derived state, removes them, seals the deletion tombstone only after private bytes are gone, and leaves a mode-`0500` run directory containing that one content-addressed redacted tombstone file. Run planning and execution both reject the durable reservation during the rename gap; after successful tombstone installation the canonical directory owns reuse prevention and the sentinel is removed. Incident retention keeps restricted bytes and records the new expiry in a tombstone without changing the raw record.

If staging or deletion fails, the command exits `2`, does not install a false deletion tombstone, and keeps remaining private bytes restricted. Programmatic trusted callers receive existing run-relative recovery locations in `ResultError.recoveryPaths`; the CLI deliberately prints only the safe code and message and does not expose local paths. A pre-deletion rollback restores the canonical source and removes the reservation. A post-deletion failure preserves the reservation plus any sealed `.tombstone-<run-id>-<nonce>` recovery tree. Verify its single address, `record.json`, schema, digest, and modes before manual installation; do not fabricate completion or reuse the ID. The tool claims nothing about unknown external copies. There is no automatic expiry sweep.

Successful result commands emit JSON and exit `0`. Restricted normalization and all input, integrity, version, export, or lifecycle failures exit `2` with safe diagnostics that omit raw causes. Exit `1` remains exclusive to a valid task-quality failure from `benchctl run`.

## Single-run terminal report

Issue 9 renders one explicitly selected normalized record:

```sh
vp run benchctl -- results report \
  /absolute/local-runs/.results/<run-id>/normalized/<sha256>/record.json
```

Use the `record_path` returned by `results normalize`. Reporting reads that exact revision; it creates no normalized record, export, lock, or report file. The reader validates the managed address, schema, run identity, initial/completion/raw-manifest digests, and the complete raw inventory, including unreferenced files, against the retained manifest. Every file is checked for containment, sealed mode, size, executable state, and streamed SHA-256. It parses the authoritative initial and completion records, rechecks their identity, revision, digest and lifecycle links, and compares normalized identities, revisions, outcome, retention and total duration with those sources. It also resolves retained verifier `.log` and `.txt` files from the raw manifest. Missing or changed retained evidence rejects the report. Restrictions, detected credential patterns in either the original normalized JSON bytes or decoded metadata, or an observed active result-operation lock block inspection. Source metadata, the complete raw inventory, and file stability are rechecked before returning; the report describes evidence inspected at that time, not a reservation against subsequent owner deletion. Reporting never regrades the run.

The English plain-text report shows run and complete stack/harness/task identities, independent revisions, outcome and termination, gates, all score facets and check evidence, scope violations, composite, timings, usage, and absolute local evidence paths. It uses no color, ANSI hyperlinks, or TTY-specific layout. Control characters in text and paths, including Unicode bidirectional controls, are escaped visibly. Argument-parser errors use a static usage diagnostic without echoing the supplied argument. Native JSONL and ATIF remain distinct; `codex.txt` is labelled as irreversibly merged stdout/stderr. A missing artifact is shown as unavailable rather than as an invented path.

Scores use three decimal places on the `[0,1]` scale. A valid failed gate can yield `0.000`; an invalid grade displays unavailable scores and gates. `unknown` and `not applicable` retain their reasons. Observed zero tokens, seconds, and upstream price estimates remain zero. Subscription money is separately not applicable; the USD estimate is explicitly labelled `API-price estimate, not subscription spend` with its upstream provenance. See the [interpretation examples](methodology.md#reading-a-single-run-report).

Exit `0` means that inspection and rendering succeeded, including for a retained task failure, infrastructure failure, or cancellation. Exit `2` means usage, input, restriction, or integrity failure; stderr contains safe diagnostics without raw error causes and stdout contains no partial report. The report includes local paths and potentially private scope details, so it is for local inspection; publication still uses the separate reviewed export procedure. The command starts no Harbor, Docker, or provider process.

## Canonical task calibration

The ordinary aggregate check covers source materialization, artifact validation and replay, task contracts, and all formatted negative-control mutators without Docker or provider calls:

```sh
vp run check
```

Run the complete issue 6 calibration locally on the supported Apple Silicon Docker environment:

```sh
vp run task:canonical:check
```

The command builds the pinned agent, collector, and verifier images first. Image builds may install the locked packages; every subsequent Harbor evaluation runs from those images without downloading task dependencies or browsers. Playwright package `1.62.1` and the Chromium/WebKit revisions come from the same official image, pinned by OCI digest. Before Harbor starts, a provider-free container with networking disabled requires the canonical agent image to expose `curl`, `bash`, `node`, `npm`, and `rg`, the complete system-command prerequisite set used by Harbor 0.22.0's Codex adapter. The canonical image pins Ubuntu Noble `ripgrep=14.1.0-1`; without it, the Playwright image's existing NodeSource Node installation can send Harbor through an incompatible distro `nodejs`/`npm` installation path.

The command then runs pristine with Harbor `nop`, two valid solutions and every negative control with deterministic `oracle`, and an identical reference replay. Effective concurrency is one, attempts are one, automatic retries are zero, provider calls are zero, and `HARBOR_TELEMETRY` is `off`. The verifier runs in a fresh separate container with `network_mode: none`, no credentials, its own immutable base, and only the two validated declared artifacts. Harbor's implicit `/logs/artifacts` transfer must remain empty. A verifier or integrity failure produces an invalid score and no numeric reward; an ordinary task failure remains a valid graded result.

The command writes its complete local jobs and generated `TaskDocument` to the printed `/tmp/harness-bench-issue-14-*` directory. These are disposable local calibration records, not committed benchmark results. The checked-in [evidence card](tasks/order-receipt.md) records the accepted command shape and latest calibration identities for owner review.

The image digest in that evidence card belongs to that build. Fresh builds may differ because of build metadata. Use the newly generated TaskDocument and checked image as one consistent set, then freeze them for execution. Rebuilding to obtain a historical image ID is not required. A changed image inside an already frozen plan still fails validation. Preserve historical gate records and create a new preflight record when replacing a blocked preparation; do not rewrite the old card or reuse its provider authorization for changed controls.

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

## Experiment matrices

Issue 10 adds a controller over the existing one-assignment runner. Start from [the example definition](../benchmark/experiments/example-definition.json), replacing its illustrative `inputs/` paths with prepared v1 documents, immutable harness bundles, source trees, and task packages. Paths are relative to the definition file. Include every task from the referenced suite and a separate stack/harness binding for each arm. Budgets must match all stacks; token/turn caps remain unsupported. A third arm can represent a disabled skill alongside v1 and v2.

```sh
pnpm benchctl experiment plan /absolute/definition.json --runs-dir /absolute/runs --dry-run
pnpm benchctl experiment plan /absolute/definition.json --runs-dir /absolute/runs
pnpm benchctl experiment report /absolute/runs/.experiments/plans/PLAN_DIGEST/plan.json
pnpm benchctl experiment compare /absolute/runs/.experiments/plans/PLAN_DIGEST/plan.json
```

Dry-run resolves the complete matrix and validates physical inputs without reading credentials, creating storage, or invoking Harbor, Docker, or Codex. It prints every task/replicate/arm assignment and run ID, the seed, invocation count, resource limits, and the sum of agent wall-clock limits. This sum excludes setup and verification and is neither an experiment-duration estimate nor a quota guarantee. It never estimates subscription money. Saving the plan seals a content-addressed record before execution. A used experiment revision cannot be published again in the same run root; changed definitions or inputs require a new revision.

A provider-backed matrix requires explicit owner authorization for its displayed invocation budget and the existing dedicated `CODEX_AUTH_JSON_PATH` setup. These examples do not authorize a provider call:

```sh
pnpm benchctl experiment run /absolute/runs/.experiments/plans/PLAN_DIGEST/plan.json
pnpm benchctl experiment resume /absolute/runs/.experiments/plans/PLAN_DIGEST/plan.json
```

`run` accepts a plan without execution history; `resume` inspects previous attempts and continues untouched assignments. Both enforce subscription concurrency one. Each native execution, including standalone `benchctl run`, takes the same per-user host lease at `/tmp/harness-bench-subscription-UID.lock`, independently of the run root. This coordinates this user's local benchctl processes, not other machines or unrelated native clients. A separate experiment-family lease serializes controller mutations and CLI report inspection in a run root. An existing lease fails closed; after a crash, inspect its owner PID and Harbor/Docker processes before trusted manual recovery. Never remove a lease to make an active invocation overlap. A caught lease-initialization failure removes its partial directory when ownership permits safe cleanup; failed cleanup retains the original diagnostics and requires trusted recovery.

A valid task failure is a quality outcome and does not stop the matrix. A technical failure or cancellation stops subsequent invocations and retains its classification and evidence. There are no automatic retries. Resume does not treat a directory or completion filename as proof: it validates sealed raw and normalized evidence and the original assignment. A completion missing its normalization/progress append is recovered without another agent invocation. An interrupted ID is never reused. After confirming that no executor remains active, an explicit resume excludes its incomplete block and can continue other untouched blocks. A pause between verified arms can resume the same block only within its unchanged 24-hour window.

`report` prints operational state only: all assignments, verified classifications, window timestamps, exclusion reasons, retained normalized-record paths, remaining scheduled invocations, and parent/replacement provenance. Child reports also list excluded predecessor blocks and their original attempts, including classifications and retained result paths, once each across repeated replacements. These historical attempts do not count as scheduled work; a superseded parent's remaining scheduled invocation count is zero. Inspection exits `0` when successful even for an incomplete experiment. It refuses inspection while the experiment-family lease is held, so an active invocation is not incorrectly reported as interrupted. Retry inspection after the controller stops; stale leases follow the trusted recovery procedure above.

`compare` is the separate read-only paired analysis. It accepts exactly one plan path, takes the same experiment-family lease, rereads every referenced sealed normalized result and its verified initial/completion provenance, performs analysis revision `1`, renders plain English text without ANSI, and releases the lease. It compares every unordered arm pair in lexical order with effects defined as `right - left`. A complete or honest partial matrix exits `0`; omissions stay visible and technical failures never become quality zero. Integrity, compatibility, unsupported-revision, active-lease, and superseded-plan errors exit `2` with no partial report on standard output. The command creates no records, invokes no provider, performs no regrade or doctor check, and leaves immutable raw and normalized records as the source of truth.

Run a verifier-only scoring migration, then select it explicitly for comparison:

```sh
pnpm benchctl experiment regrade /absolute/plan.json --definition /absolute/scoring-migration.json
pnpm benchctl experiment compare /absolute/plan.json --migration /absolute/runs/.experiments/migrations/MIGRATION_DIGEST/record.json
```

The definition paths are relative to the definition file and its task inventory must exactly match the frozen experiment. Regrade accepts only completed local single-step Harbor `0.22.0` trials and Docker separate verifiers with no network. Preflight validates all source evidence and every target package before the first Docker invocation. It holds the experiment-family lease and every source-run result lease in deterministic order, runs valid grades sequentially with concurrency one, retains technical classifications without inventing scores, and never transports Codex auth or provider environment. Successful JSON output identifies the sealed migration and reports regraded/retained counts plus `regrade_provider_calls: 0`; failures use exit `2` and safe diagnostics.

Repeating the exact command resumes by validating and reusing sealed per-run records whose definition and source digests match. It does not retry Harbor automatically. A conflicting, ambiguous, changed, or partially sealed result fails closed; abandoned staging is retained as a sealed `.failed-*` diagnostic and no final migration record is written. A failed staging leaf contains restricted `failure.json` evidence with the raw local error name, message, stack, and, when Harbor started, its exact cancellation/timeout/signal/exit outcome and verifier-stage classification. The CLI still emits only its safe code and message. Regrade evidence lives under each run's `.results/<run-id>/regrades/<digest>/` leaf, and the final manifest lives under `.experiments/migrations/<digest>/record.json`. The original run is hash-inventoried before and after every verifier execution and is never rewritten. A migrated report states the migration identity/digest, each evaluator transition, separate regrade-verifier timing, and zero provider calls. Omitting `--migration` always reads the original results.

Execution exits `0` for a completed all-success matrix, `1` for completed valid task failures, and `2` for incomplete/invalidated matrices or command errors. A completion awaiting normalization is unverified until `resume` performs recovery; neither reporting command writes a derived result.

Record an externally known change, or prepare a whole-block replacement:

```sh
pnpm benchctl experiment invalidate /absolute/plan.json --block BLOCK_ID --cause provider_changed --reason "Owner observed a provider change"
pnpm benchctl experiment rerun-block /absolute/plan.json --block BLOCK_ID --revision 2
```

Accepted causes are `incomplete`, `deadline_exceeded`, `model_changed`, `cli_changed`, `provider_changed`, `runner_changed`, `harbor_config_changed`, and `harness_changed`. Keep reasons free of secrets. A replacement requires an invalidated block and unchanged pinned inputs; if inputs changed, author a new definition revision and run `plan` again. It assigns new IDs to every arm of that block, freezes a child plan, and supersedes the parent without invoking an agent. If child publication succeeds but recording the parent handoff fails, repeat the same `rerun-block` command after resolving the storage failure and any stale lease. It reuses only the exact sealed child and completes the missing handoff; conflicting content under the requested revision remains an error. Inspect the child report, then explicitly run it. Other assignments retain their original creating-plan identity, including still-pending assignments; completed results remain linked to the old immutable records. The child lists the full logical order and remaining calls. Repeating one losing arm or rerunning a healthy completed block is not supported.

Plans, immutable v1 assignment snapshots, and hash-linked progress records live under `<runs-dir>/.experiments/`; directories use `0700` and sealed files `0400`. Plan identity hashes canonical sorted-key JSON with its self-referencing `experiment.plan_digest` replaced by the documented all-zero digest. Progress uses full-record canonical hashes and a previous-record digest. The frozen parent-progress boundary and explicit supersession record bind child provenance. Storage uses exclusive atomic publication and never rewrites a raw run. It contains local bindings and identity metadata, not copied source trees or credentials, and is not a public export format. These hashes and leases protect detected corruption and local concurrency; they do not defend against a malicious trusted owner.

The local provider-free integration command extends the existing Harbor controls with a two-arm matrix and a deterministic controller interruption between assignments:

```sh
HARNESS_BENCH_EXPERIMENT_INTEGRATION=1 pnpm run:integration:check
```

It uses the pinned Harbor lifecycle, fake native agent, independent collector, separate offline verifier, real normalization, and a provider-call canary. Ordinary CI uses deterministic unit/fixture tests only. This proves local orchestration and recovery, not hidden provider identity changes, auth refresh, private-task online secrecy, or a live subscription comparison.

Enable the issue-13 verifier-only extension with:

```sh
HARNESS_BENCH_REGRADE_INTEGRATION=1 pnpm run:integration:check
```

This also runs the two-arm experiment fixture, then invokes real Harbor `trial regrade` with scoring v2, verifies composite `1 -> 0.875`, checks revision/config/lock/source-trial provenance, repeats the command as resume, compares original and migrated overlays independently, hashes every original run before and after, and requires the provider canary to remain exactly zero.

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

Preserve failed attempts and stage-specific termination reasons. Resume execution from the frozen plan, skipping only completed immutable IDs. Resume regrade by repeating the exact `experiment regrade` command after confirming no Harbor verifier remains active and recovering any stale leases through the trusted lease procedure. Inspect sealed `.failed-*` diagnostics; never rename them into successful content addresses or hand-edit a manifest. Regrade uses retained declared artifacts and a new separate offline verifier; it never reruns the agent or overwrites source results. Verify hashes and source lineage first. Missing inputs require a new explicitly authorized run, not invented reconstruction. Deleting a private source run also deletes its regrade evidence and referencing migration manifests and records their digests in the redacted tombstone.

A cooperative cancellation leaves Harbor responsible for its ordinary trial cleanup and the provider-free integration requires no matching container or volume to remain. A forced `SIGKILL`, process crash, kernel crash, or power loss cannot run either Harbor or `benchctl` cleanup code, so automatic container, volume, or temporary credential-file cleanup is not claimed. The local owner must first prove that no benchmark, Harbor, or verifier process is active. Then inspect Docker resources associated with the failed trial and mode-`0700` `/tmp/harness-bench-auth-transport-*` directories, remove only confirmed stale resources, inspect the sealed failure evidence and source hashes, and only then recover stale leases or repeat the command. Never remove a lease merely to overlap a still-running verifier.

## Required owner reviews

An owner review is a go/no-go decision over a short redacted evidence card prepared by the implementing agent; it is not a request for the owner to run Harbor, inspect raw credentials, or invent a test procedure. The owner confirms that the stated risk, task realism, or result is acceptable, or says what must change.

The [roadmap](roadmap.md#owner-gates-and-dependencies) owns current owner decisions. Issue 2 feasibility, issue 6 task fairness, and the post-13 technical smoke reviews are accepted history. The technical `GO` does not authorize private-data use; each private source still needs owner permission. Issue 16's early exploratory comparison and issue 17's final pilot each need their own concrete invocation budget. Review the final task suite and pilot budget together. Inspect final evidence before accepting conclusions or starting M4. Reuse existing approval within its stated scope; routine check reruns and metadata changes do not add owner reviews.

The accepted post-13 canary used one redacted card after a green assignment-level dry-run. It bound the current benchmark commit, task and image identities, auth mode, network, time and resource limits, one invocation, concurrency one, and zero retries. Its second distinct schema-control arm received no execution authorization. Post-run review covered native JSONL, ATIF, merged output, independent collection, offline verification, normalization, credential checks, and cleanup. The trustworthy `task_failure` with `valid_grade: true` satisfied the technical gate; an execution or integrity failure would have required `NO-GO`. A future canary is required only if a later gate or changed assumption calls for one, with a fresh card and separate invocation authorization.

Reuse the successful provider-free checks when the corresponding source/toolchain/task identities still match. Documentation changes alone do not invalidate task calibration; record the current benchmark commit and link the earlier technical evidence. Rerun affected checks after relevant changes or if retained evidence cannot be verified. Checking the actual pinned images and immutable inputs before execution remains required.

M4 may add provider-free CI integrity checks, static reports, and separately opted-in metered schedules. No scheduled job is enabled by this planning run or v1.
