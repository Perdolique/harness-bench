# Official-source research snapshot

Researched on **2026-09-04**. Only official Harbor and OpenAI documentation and repositories support the external capability claims below. These are source observations, not a completed feasibility spike. No login, provider invocation, container run, or private-repository import occurred in this planning run.

## Exact references consulted

| Component | Release consulted | Resolved release commit | Interpretation |
| --- | --- | --- | --- |
| Harbor | [v0.22.0](https://github.com/harbor-framework/harbor/releases/tag/v0.22.0), published 2026-08-22 | `4407eb5227a2ff4f0d3f16b2eb48849382fdf276` | Candidate pin `harbor==0.22.0` |
| Native Codex | [rust-v0.153.2](https://github.com/openai/codex/releases/tag/rust-v0.153.2), published 2026-09-03 | `657a993cbee87acf52d14b758ce49dbd46d1b8eb` | Candidate pin `@openai/codex@0.153.2` |

The annotated tag object IDs are Harbor `41a50d62d7f35677cc34ba3a0c36f042a4fef68c` and Codex `79016fcca2c514d9c38643d8b7970a021e829b3b`; use the resolved commits above for source permalinks. Release metadata was read with GitHub CLI and tags resolved with `git ls-remote`. Public source archives at those commits were extracted outside the repository and inspected. The installed CLI independently reported `codex-cli 0.153.2`; this does not demonstrate Harbor compatibility. The source blobs referenced as C4-C7 are unchanged from `0.153.0`; the two intervening patch releases changed the model catalog and display text rather than those interfaces.

Current official website pages were also fetched on this date. They are mutable; the source permalinks below anchor version-dependent Harbor/Codex behavior. No floating release, branch, image tag, or unspecified model is a planned runtime pin. Issue 1 pins Node `26.8.1`, pnpm `11.25.0`, Python `3.14.7`, and uv `0.12.9`. Images and model/effort selection remain issue 2 decisions rather than invented versions. Harbor declares Python `>=3.12`.

The official authentication page was rechecked on 2026-09-05. It describes file authentication as plaintext access-token storage that must be treated like a password, kept out of source control and sharing channels, and protected from unauthorized access. That current guidance supplements, but does not replace, the pinned C4 implementation reference.

## Harbor findings

| Topic | Observed at the pinned revision | Planning consequence |
| --- | --- | --- |
| Installation | `pyproject.toml` declares version 0.22.0, Python minimum 3.12, and the `harbor` CLI entry point [H1] | Pin the package and lock Python/tooling with uv; do not follow unversioned install examples |
| Task format | Prompt, task metadata, agent environment, tests, solution; docs show task schema 1.4 [H2] | Use single-step Harbor-compatible tasks; keep solution/tests outside agent image |
| Verifier | Shared is the default; a verifier environment enables separate mode, built from tests context [H2] | Explicit separate image and offline baseline; source support is not a runtime isolation proof |
| Rewards | `reward.json` supports numeric metrics and is preferred over scalar `reward.txt` [H2] | Preserve numeric facets plus separate applicability/evidence/failure metadata |
| Network | Public baseline is default; allowlist and no-network modes exist; phase overrides differ from startup policy [H3] | Explicit public agent baseline and phase; separate offline verifier; preserve the retired restricted-network outcome |
| Docker support | Allowlist enforcement uses an nftables sidecar; Linux containers and compatible kernel features are required [H3, H4] | Verify public agent access and separate Docker-none verifier on the selected macOS Apple Silicon target; the pinned sidecar is verifier-only |
| Native Codex auth | Explicit `CODEX_AUTH_JSON_PATH` selects a file; ambient-home fallback exists; default path otherwise uses API auth [H5] | Require a dedicated explicit file and confirm effective subscription mode; never inherit ambient auth |
| Native home/config | Adapter uses `/tmp/codex-home`, separate temporary secrets, explicit config/MCP merging, and copies skills into `$HOME/.agents/skills` [H5] | Inspect all effective harness inputs and reject ambient state; cleanup is best-effort |
| Native execution | Adapter requests exact CLI versions when provided; omission can install an unpinned release. It uses `codex exec --json`, bypasses approvals/sandbox, and merges stderr into stdout [H5] | Explicit version/effort and external isolation are mandatory; trace fidelity and stream separation need evidence |
| Trajectory/usage | Native sessions are converted to ATIF-v1.7; available token data is parsed; missing cost can use a LiteLLM API-price estimate [H5, H6] | Keep original sessions and output; never represent estimated API money as subscription cost |
| Artifacts | Convention directory and configured paths are collected; destination changes host storage, not verifier replay paths. Failures are best-effort [H7] | Validate complete manifest and hashes; constrain implicit inputs and reject path collisions |
| Collection boundary | Main hooks/artifacts precede a main-stop attempt; sidecars follow; a stop failure logs a warning [H8] | Require proof of quiescence and a trusted collector, including failure paths; do not infer tamper resistance from configuration |
| Regrade | Single-step recorded trials can be verified in a new separate environment without agent execution; required artifacts/manifests must exist [H9] | Preserve complete declared inputs and source lineage; derived directories never overwrite originals |
| Telemetry | Usage stats are enabled by default; `HARBOR_TELEMETRY=off` opts out [H10] | Default every benchmark invocation to off and record effective policy |

## Codex findings

| Topic | Official observation | Planning consequence |
| --- | --- | --- |
| Login/storage | ChatGPT login, file/keyring storage, automatic refresh, and headless login options are documented [C1]; file auth is plaintext password-equivalent access-token storage, and source uses `CODEX_HOME/auth.json` [C4] | Protect the dedicated file from commits, tickets/chat, uncontrolled copy/sync/backup, and other users; this is not proof of minimum files or safe read-only refresh in the target stack |
| Non-interactive events | `codex exec --json` emits JSONL events for turns/items/errors, including commands and changes [C2, C5] | Retain native output plus stderr and raw errors; verify current Harbor conversion coverage |
| Ephemeral execution | `--ephemeral` suppresses session persistence [C2, C5] | A fresh disposable home must still allow collection of required native rollout evidence |
| Home/state | `CODEX_HOME` selects config/auth/log/session/skill state and must exist; state can have separate environment/config overrides [C3, C6] | Create and inspect a fresh explicit home, do not equate it with total process isolation |
| Config/permissions | Config includes package, system/managed, user, project, and runtime layers [C7]; non-interactive permission settings are explicit [C2] | Record the effective stack and CLI flags; account for Harbor's sandbox bypass and config merging |
| Version | Release Cargo metadata declares 0.153.2 [C8] | Pin native binary/package and record observed version; provider-hidden model revision stays `unknown` |

## Primary source register

- H1: [Harbor package metadata](https://github.com/harbor-framework/harbor/blob/4407eb5227a2ff4f0d3f16b2eb48849382fdf276/pyproject.toml).
- H2: [Harbor task, verifier, and reward format](https://github.com/harbor-framework/harbor/blob/4407eb5227a2ff4f0d3f16b2eb48849382fdf276/docs/content/docs/tasks/index.mdx).
- H3: [Harbor network policies and runtime limits](https://github.com/harbor-framework/harbor/blob/4407eb5227a2ff4f0d3f16b2eb48849382fdf276/docs/content/docs/tasks/network-policy.mdx).
- H4: [Docker egress-control service](https://github.com/harbor-framework/harbor/blob/4407eb5227a2ff4f0d3f16b2eb48849382fdf276/src/harbor/environments/docker/docker-compose-egress-control.yaml).
- H5: [Native Codex adapter](https://github.com/harbor-framework/harbor/blob/4407eb5227a2ff4f0d3f16b2eb48849382fdf276/src/harbor/agents/installed/codex.py).
- H6: [ATIF trajectory format](https://github.com/harbor-framework/harbor/blob/4407eb5227a2ff4f0d3f16b2eb48849382fdf276/docs/content/docs/agents/trajectory-format.mdx).
- H7: [Artifact collection and manifests](https://github.com/harbor-framework/harbor/blob/4407eb5227a2ff4f0d3f16b2eb48849382fdf276/docs/content/docs/run-jobs/results-and-artifacts.mdx).
- H8: [Trial collection and stop handling](https://github.com/harbor-framework/harbor/blob/4407eb5227a2ff4f0d3f16b2eb48849382fdf276/src/harbor/trial/trial.py).
- H9: [Regrade requirements and provenance](https://github.com/harbor-framework/harbor/blob/4407eb5227a2ff4f0d3f16b2eb48849382fdf276/docs/content/docs/run-jobs/regrade.mdx).
- H10: [Telemetry and opt-out](https://github.com/harbor-framework/harbor/blob/4407eb5227a2ff4f0d3f16b2eb48849382fdf276/docs/content/docs/usage-stats.mdx).
- C1: [Official Codex authentication](https://learn.chatgpt.com/docs/auth).
- C2: [Official Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode).
- C3: [Official Codex environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables).
- C4: [Codex authentication storage](https://github.com/openai/codex/blob/657a993cbee87acf52d14b758ce49dbd46d1b8eb/codex-rs/login/src/auth/storage.rs).
- C5: [Codex exec CLI options](https://github.com/openai/codex/blob/657a993cbee87acf52d14b758ce49dbd46d1b8eb/codex-rs/exec/src/cli.rs).
- C6: [Codex home resolution](https://github.com/openai/codex/blob/657a993cbee87acf52d14b758ce49dbd46d1b8eb/codex-rs/utils/home-dir/src/lib.rs).
- C7: [Codex configuration layers](https://github.com/openai/codex/blob/657a993cbee87acf52d14b758ce49dbd46d1b8eb/codex-rs/config/src/loader/mod.rs).
- C8: [Codex release version](https://github.com/openai/codex/blob/657a993cbee87acf52d14b758ce49dbd46d1b8eb/codex-rs/Cargo.toml).

## Feasibility risk register

Issue 3 reviewed the original risks against the [retained spike evidence](spikes/harbor-codex-subscription.md). The provider-free preflight SHA-256 is `a2ba6b8bc21dc4023d1b25f8c30bafc7a974186d0d3f2eb540dceaf1dea7d9da`; the public-01, public-02, and public-03 manifest SHA-256 values are `62b9c15290b12185c3f45a767e475ebb6d4a54c81a27729a086f0627741b81eb`, `88b7d0c00e500fed64627330e6ee19235fbb1612f68c80a62d98e32bfd2ceb50`, and `6f5cf36cc589ed908db0d0173220b94bf83466aef598de1e0dc17bd69c9242f6`.

| ID | Accepted evidence | Residual limitation | Follow-up |
| --- | --- | --- | --- |
| R1 | Explicit dedicated file login worked in three public runs; temporary state was cleaned, the external file hash did not change, and scans found no secret | Token expiry, refresh persistence, and read-only refresh compatibility were not exercised; stop and require owner login on failure | Issues 5, 12, and the issue 13 owner gate |
| R2 | Public agent HTTPS and a fresh Docker-none verifier passed through the actual Harbor lifecycle on the recorded Mac/LinuxKit host | Public networking permits remote and host-service access and reacquisition of public source, later history, solutions, or grading material. Local absence is not online secrecy; no Intel, WSL2, or arbitrary-host claim | Issues 6, 7, 12, 14, and 23 |
| R3 | Positive and adversarial controls plus three native runs proved trusted-baseline capture after successful stop | Production runs must fail closed on stop, stability, collection, exact inventory, manifest, or hash error. The spike inventory skipped every nested basename `sha256-manifest.json`, so reserved-name collision rejection remains unproved | Issues 7, 8, and 12 |
| R4 | Native evidence recorded config, one canary skill, empty MCP registry, model/effort, `danger-full-access`, approval policy, JSONL, ATIF, and merged output | Issue 2 was Git-free; future tasks use a one-base-commit repository. stdout/stderr cannot be reconstructed. Other harness or MCP shapes need their own evidence | Issues 5, 6, and 14 |
| R5 | Artifact collision, unsafe-link, special-file, secret, hidden-test, and offline-verifier controls passed | Direct parent (`../`) and absolute-path traversal were not exercised. Scanning is incomplete and cannot stop live exfiltration; every revised boundary needs recurring controls | Issues 6, 12, and 18 |
| R6 | Requested model and effort plus available usage were retained for each run | Provider-hidden identity, quota, nondeterminism, and subscription money remain `unknown`; later pairs use concurrency one, finish within 24 hours, invalidate on known stack/provider change, and never infer charges from API prices | Issues 10, 11, and 13 |

The owner accepted qualified go on 2026-09-05, and the five initial ADRs are Accepted. Source support alone still cannot waive later task, integrity, or owner gates.
