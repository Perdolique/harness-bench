# Harbor and Codex subscription feasibility spike

## Current status: public-1

The owner confirmed **no-go for the retired restricted-network protocol**, then
explicitly selected unrestricted agent internet on 2026-09-05 to represent normal
development conditions. The failed raw record remains immutable. This is a changed
experimental requirement, not a successful regrade of that record and not a
general no-go for Harbor.

Revision `public-1` removes discovery, hostname allowlisting, packet observation,
and agent egress proxying. Agent setup and inference use Harbor `public` on a normal
Docker bridge. Collector and verifier use Docker `network_mode: none`; the verifier
also retains Harbor's separate `no-network` policy. Harbor's pinned GOST sidecar may
still start for that verifier, but neither agent nor verifier shares its namespace.

The revised card originally scheduled **two identical sequential native invocations**.
The owner authorized both, then requested `low` effort while `public-01` was already
running at `medium`. The first run was not restarted; `public-02` used the explicitly
requested `low` override. These are two successful feasibility samples, not an
identical repeated pair. Concurrency remained one, retries zero, no fallback model.
Both used `gpt-5.6-luna`, Harbor `0.22.0`, Codex `0.153.2`, ChatGPT file login,
one canary skill, empty MCP registry, telemetry off. Built-in web search remains
disabled; shell-command internet access is unrestricted. Limits remain
600/120/900 seconds for agent/verifier/build, two CPUs and 2 GiB RAM.

Both revised native invocations completed successfully; all three authorized
subscription invocations, including the historical failure, are now consumed.
On 2026-09-05 (Europe/Tallinn), the owner explicitly accepted **go with the
mixed-effort and Git-workspace qualifications** after reviewing these results.
This accepts the temporary feasibility spike and carries the limitations to issue
3 review; it does not retroactively satisfy the original identical-repeat criterion.
No fallback issue or ADR is created to repair a requirement the owner retired.
Issue 3 and issues 4–13 remain unstarted. The next task is issue 3 after this issue's
PR is merged; no production implementation is authorized by this gate alone.

## Public-network native results

| Run | Effort | Start (UTC) | Completion (UTC) | Wall time | Terminal / valid grade | Reward facets |
| --- | --- | --- | --- | --- | --- | --- |
| `public-01` | `medium` | 2026-09-04 21:40:57.624 | 2026-09-04 21:42:24.750 | 87.126 s | `completed` / true | All four 1 |
| `public-02` | `low` | 2026-09-04 21:43:37.293 | 2026-09-04 21:44:49.872 | 72.579 s | `completed` / true | All four 1 |

The commands actually executed were:

```sh
CODEX_AUTH_JSON_PATH=<dedicated-external-auth.json> \
  BENCH_RUN_ROOT=/Users/ky6uk/.agent-stack-bench/runs/harness-bench/issue-2-public-1-final \
  pnpm spike:issue-2 -- --phase public --run-id public-01
CODEX_AUTH_JSON_PATH=<dedicated-external-auth.json> \
  BENCH_RUN_ROOT=/Users/ky6uk/.agent-stack-bench/runs/harness-bench/issue-2-public-1-final \
  pnpm spike:issue-2 -- --phase public --run-id public-02 --effort low
```

Only the local per-run effort argument and its evidence matching were added between
the runs. Images, fixture, verifier, base harness file, skill, resource limits,
network policy, and model were unchanged. The second intent records `low` and
`harnessRevision=public-1-low`; the first intent remains unchanged with `medium`.
The final provider-free checks passed 50 tests across nine files, four planning
tests, formatting, lint, types, planning validation, and toolchain verification.
The focused spike tests passed 29 cases across seven files.

For both runs:

- Native JSONL confirms `gpt-5.6-luna`, the recorded effort, `danger-full-access`,
  and approval policy `never`. Harbor's CLI invocation and effective configuration
  match. The first run demonstrates the base harness's `low` overridden to `medium`;
  the second explicitly selects `low`.
- The native agent read and executed the canary skill. All ten collector canary
  booleans passed. Writes outside `/app` succeeded despite the base read-only
  sandbox setting, inside external Docker isolation.
- The running main containers were observed on normal Compose bridge networks:
  `normalize-room-label__ztet2hp__env_default` and
  `normalize-room-label__mlqbhsu__env_default`, not an egress-sidecar namespace.
- Harbor reported main stop before trusted collection. Declared artifact statuses
  matched, the independent patch applied, the reconstructed tree matched the
  collector manifest, and separate verifier networking was loopback-only.
- `task_contract`, `regressions`, `scope`, and `integrity` were each 1. Both agents
  changed only the implementation and its regression test. Both implementations
  added `.replace(/\s+/g, "-")`; regression additions differed.
- Temporary Codex home and secret directories were empty after cleanup. The
  external auth file's before/after hash was unchanged. No auth refresh event was
  demonstrated; unchanged credentials do not prove refresh compatibility.
- The secret scanner reported zero findings. Each raw record is mode 0500 with
  28 manifest entries; independently recomputing every listed SHA-256 found zero
  mismatches. Each completion's intent hash matches its immutable intent.
- No spike containers remained running after completion. Unrelated local services
  were left untouched. No retry, fallback model, credit redemption, or extra run occurred.

| Evidence / usage | `public-01` | `public-02` |
| --- | --- | --- |
| Native JSONL records | 78 | 71 |
| Merged JSON events | 28 | 20 |
| ATIF steps | 13 | 13 |
| Input tokens (includes cached) | 100,955 | 96,206 |
| Cached input tokens | 81,152 | 86,016 |
| Output tokens | 2,157 | 1,543 |
| Reasoning output tokens | 729 | 391 |
| Commands with nonzero exit | 1 | 2 |

Low happened to finish 14.547 seconds sooner in these two samples. This is not a
controlled estimate of low versus medium performance: there is only one sample
per effort, different actions, cache use, and variable provider latency.
Harbor reported API-price estimates of USD 0.00817204 and 0.00560992. These are
upstream estimates, **not subscription charges**; actual subscription monetary
cost remains not applicable/unknown.

The observed command errors were Git operations in the intentionally Git-free
agent workspace: two-file `git diff` acted as a no-index comparison, and `git status`
reported `not a git repository`. The errors and edits are retained in native
evidence; the trusted collector was unaffected. This is a concrete daily-workflow
fidelity limitation for issue 3, not a reason to retrofit the completed samples.
Merged `codex.txt` cannot recover separate native stdout/stderr. Native JSONL and
ATIF are both retained rather than treating different event counts as equivalent
representations.

The raw record directories are `runs/public-01` and `runs/public-02` under the final
external root. Their `sha256-manifest.json` hashes are respectively:

- `62b9c15290b12185c3f45a767e475ebb6d4a54c81a27729a086f0627741b81eb`.
- `88b7d0c00e500fed64627330e6ee19235fbb1612f68c80a62d98e32bfd2ceb50`.

Owner decision: **go with explicit qualifications**, accepted on 2026-09-05 after
the evidence report and a separate request for the decision. The public-network
Harbor/native-subscription/collector/offline-verifier path is demonstrated for this
synthetic task. The owner accepts the mixed-effort pair as sufficient for this
temporary feasibility gate, not as proof of identical-repeat comparability.
Git-free workspace behavior, auth refresh, merged native output, and external-network
exposure remain inputs to issue 3 review. No further runtime changes or provider
runs follow this gate; finish the focused issue 2 commit and PR only.

## Public-1 provider-free evidence

The first complete revised control command passed on 2026-09-05:

```sh
BENCH_RUN_ROOT=/Users/ky6uk/.agent-stack-bench/runs/harness-bench/issue-2-public-1 \
  pnpm spike:issue-2:check
```

It passed 26 spike unit tests and eight Docker controls, including a real Harbor
Oracle-agent lifecycle with zero provider calls. The synthetic local script
received HTTP 200 from `https://example.com`, changed the fixture, then stopped.
The main container's observed network mode was a normal Compose bridge
(`normalize-room-label__vnoi8eg__env_default`), not a sidecar namespace. Harbor's
trial log recorded main stop before successful trusted collection. The separate
verifier had loopback-only interfaces and produced
`integrity=1, regressions=1, scope=1, task_contract=1`.

This is **not native subscription evidence**. The Oracle script creates synthetic
canary markers; it proves lifecycle wiring and verification, not Codex skill
loading, authentication, effective permissions, usage, or model behavior.
The fake record was scanned and finalized read-only with its SHA-256 manifest.

The final preflight passed 27 spike tests and nine Docker controls, including a
negative control that intentionally gives the verifier a bridge network and
requires exit 2 with `integrity=0`:

```sh
BENCH_RUN_ROOT=/Users/ky6uk/.agent-stack-bench/runs/harness-bench/issue-2-public-1-final \
  pnpm spike:issue-2:check
pnpm check
python3 .planning/sync-github.py --check
```

`pnpm check` passed 48 tests across nine files, four planning tests, formatting,
lint, type checking, planning validation, and exact toolchain checks. The GitHub
check verified all 27 issues; the preceding apply updated only issue 2 and created
no issues, labels, or milestones. The final fake Harbor record is
`fake-harbor-9d23e2a0-e554-4dda-ab4c-cfdfc08a1c16` under the final root. Its
observed main network was `normalize-room-label__ttxc6nq__env_default`.

The first final-preflight attempt rejected overall doctor exit 1. Inspection
proved that `config.load` was `ok`; the failing checks were `auth.credentials` and
`network.provider_reachability`, as expected with no credentials or network.
A second attempt exposed a false-positive historical negative test: in CLI
0.153.2, `codex --strict-config doctor --json` still reports `config.load=ok` for
an unknown top-level key. Its nonzero exit alone does not prove strict rejection.
`codex --strict-config features list` explicitly rejects the flag as unsupported.

The final control retains both doctor exit codes as 1 and both config-load statuses
as `ok`, then invokes the supported strict parser with an unknown-field copy:

```sh
codex exec --strict-config --skip-git-repo-check --json \
  'Provider-free config rejection control'
```

That command ran only inside a no-network, no-auth container. It exited 1 with
`unknown configuration field` naming the injected field and no `thread.started`
event. No provider call was possible. This is not a claim that the original
literal overall-zero strict-doctor requirement passed; it is the corrected
config-validation evidence. The [official command reference](https://learn.chatgpt.com/docs/developer-commands#codex-doctor)
describes doctor as a broader installation/configuration/authentication health
report, while the exact pinned-version behavior above comes from local execution.

Final evidence-file SHA-256 values:

- `image-lock.json`: `e043690b6aa23ae0aed75c6c8942da1f1e4b65ced2edd3057beb758b2de11932`.
- `provider-free-preflight.json`: `a2ba6b8bc21dc4023d1b25f8c30bafc7a974186d0d3f2eb540dceaf1dea7d9da`.
- `codex-config-control.json`: `92d2787c3e73f083d0ad8f2c6564bcdb6fa10888d33beac65e4779e275603f9f`.

## Revised native run card: authorized, then amended

- Two invocations, run IDs `public-01` and `public-02`, sequential, no retries.
  The owner later changed the second run to `low`; the first was already at `medium`.
  These are the two remaining invocations after the one historical subscription run.
- Harbor 0.22.0; Codex 0.153.2; `gpt-5.6-luna`; `medium`; existing dedicated
  external ChatGPT file login; fresh temporary Codex home/secrets each time.
- Unrestricted agent internet; collector and verifier offline. No domain discovery,
  allowlist, proxy, packet observer, host-home mount, or Docker socket mount.
- Built-in web search disabled, empty MCP registry, one fixed canary skill,
  telemetry off; unchanged harness except the declared network protocol.
- Agent/verifier/build timeouts 600/120/900 seconds; concurrency 1; CPU 2; RAM 2 GiB.
- Exact image IDs below; final external root
  `/Users/ky6uk/.agent-stack-bench/runs/harness-bench/issue-2-public-1-final`, mode 0700.
- Both invocations completed and are retained above. The separate owner decision
  is qualified go. No automatic third invocation or fallback model.

| Image | Public-1 local ID |
| --- | --- |
| Agent | `sha256:8fa0dad6629ea4896a8cfaec67e201287938d0d7fbd5af84c93f50777a6df9dc` |
| Collector | `sha256:a2aa543dec433e261faa60a0f48d62258790ac84ea14a39219f5c656f79bd91b` |
| Verifier | `sha256:9d9c0e903ed7793c40739d5b3d6ca327c2dea73ba2882cb6133106a0e1bedc88` |
| Harbor verifier-only sidecar | `sha256:14e1359bf8a8800fc4164f638a83ea2b581dd5012e9756533aa430b9b73e8c0a` |

Node and GOST base digests remain those recorded in the historical section.
The collector no longer installs tshark; Alpine kernel probes are removed.
Direct Debian package pins remain `git=1:2.39.5-0+deb12u3` and
`ca-certificates=20250419~deb12u1`; the exact built image ID freezes transitive
package contents. Only the recorded macOS/Apple Silicon/Docker Desktop target
is claimed.

Unrestricted internet deliberately removes egress containment: commands can reach
remote services and potentially host network services, and can transmit any data
visible inside the agent container, including temporary native-client credentials.
No host home or Docker socket is mounted; hidden tests remain verifier-only.
Secret scanning protects publication but is not an exfiltration barrier.
External content may change between otherwise identical runs.

## Historical evidence: retired restricted-network protocol

Everything below describes the earlier `spike-1` experiment and its original
commands/images. These commands are retained for audit and are no longer accepted
by the revised CLI. The owner no-go for this protocol is confirmed.

## Frozen stack and protocol

| Input                            | Value                                                           |
| -------------------------------- | --------------------------------------------------------------- |
| Host target                      | macOS Apple Silicon, Docker Desktop Linux/arm64                 |
| Harbor                           | `0.22.0`                                                        |
| Codex CLI                        | `0.153.2`                                                       |
| Model / effort                   | `gpt-5.6-luna` / `medium`                                       |
| Authentication                   | Dedicated external ChatGPT file login                           |
| Harness                          | Web search disabled, empty MCP registry, one fixed canary skill |
| Concurrency / retries            | `1` / `0`                                                       |
| Agent / verifier / build timeout | `600 s` / `120 s` / `900 s`                                     |
| CPU / RAM                        | `2` / `2 GiB`                                                   |
| Invocation limit                 | One discovery plus two restricted runs                          |

The discovery run uses a temporary broad IPv4/IPv6 CIDR allowance. Its trusted
observer stores DNS, TLS SNI, destination, port, and timestamp metadata only; it
does not retain payloads or pcap. The two restricted runs use the exact SNI
hostname list from TCP streams with an observed TLS ServerHello. New domains and
failures remain separate outcomes and never trigger automatic retries or allowlist
expansion.

## Pinned container inputs

- Agent, collector, and verifier base:
  `node:26.8.1-bookworm-slim@sha256:f105cb6a6b56d32ea0295fcd100e4f06afa29ac51396315497f37eb9dc2b2848`.
- Kernel probe:
  `alpine:3.23.4@sha256:378c4c5418f7493bd500ad21ffb43818d0689daaad43e3261859fb417d1481a0`.
- Harbor egress sidecar base:
  `gogost/gost:3.2.7-nightly.20260602@sha256:b78c2c1c495117cc9d75be775e4b3a5737b64d72c97ed66e99866aaabb1d3cb6`.
- Debian packages: `git=1:2.39.5-0+deb12u3`,
  `ca-certificates=20250419~deb12u1`, and `tshark=4.0.17-0+deb12u3`.

The final source-equivalent preflight recorded these Linux/arm64 local IDs:

| Image                 | Local image ID                                                            |
| --------------------- | ------------------------------------------------------------------------- |
| Agent                 | `sha256:8fa0dad6629ea4896a8cfaec67e201287938d0d7fbd5af84c93f50777a6df9dc` |
| Collector             | `sha256:6e48b65edb0f2940692f43e837ef38ac4cdbc4e3c4919249dde88e57c3004556` |
| Verifier              | `sha256:4b06c613d6bdf28fe602d01ccf3a01b8e6b9ab5cce180d971f0276d9437d7dbe` |
| Harbor egress sidecar | `sha256:14e1359bf8a8800fc4164f638a83ea2b581dd5012e9756533aa430b9b73e8c0a` |

Every subscription invocation re-inspects tag-to-ID mappings and fails before
inference if any value differs from the immutable external `image-lock.json`.

## Provider-free evidence

The final source-equivalent command was:

```sh
BENCH_RUN_ROOT=/Users/ky6uk/.agent-stack-bench/runs/harness-bench/issue-2-final-v5 \
  pnpm run spike:issue-2:check
```

It passed 26 Vitest cases across seven spike test files and all nine integration
controls: pinned Codex config, resolved Harbor input contract, LinuxKit kernel
probe, live nftables egress sidecar, agent-image layer inspection, pristine-base
verifier, known-good verifier, out-of-scope verifier, and hidden-test absence.
`providerCalls` was `0`; the three `codex doctor` config checks ran inside the
pinned agent image with `--network none` and no credentials.

Historical qualification discovered during public-1 validation: the old negative
doctor check asserted only a nonzero exit, which could come from missing auth or
network. It did not prove unknown-field rejection. The corrected supported-command
control is recorded above; the original raw record is not rewritten.

An earlier source revision retained under `issue-2-final-v4` failed closed because
the live `tshark` process did not stop within two seconds on `SIGTERM`. A disposable
signal control proved `SIGINT` stopped it in roughly 50 ms. The final collector
uses `dumpcap` to stream packets through a FIFO to `tshark`, confirms that both
processes were active before collection and stopped afterward, and retains only
field metadata plus diagnostic stderr; it retains no payload or pcap file.

The recorded host was macOS `26.5.2`, MacBook Pro `Mac14,6`, Apple M2 Max,
`arm64`; Docker Desktop `4.86.0 (236216)` with client/Engine `29.7.2`, context
`desktop-linux`, LinuxKit `6.12.76-linuxkit`, cgroup v2, and Linux `aarch64`
containers.

The controls cover the pristine regression-pass/task-fail fixture, known-good
task pass, captured edits/deletions/untracked text and binary files/executable mode/
safe symlink, malicious `.git`, escaping links, special files, limits and a changing
tree, manifest failure/collision cases, dummy secret detection without values,
pinned Codex config validation, actual Harbor task/job parsing, the Docker Desktop
nftables sidecar, hidden-test absence, and separate no-network verification.

## Native run evidence

| Invocation | Phase      | Terminal class  | Required evidence                                      |
| ---------- | ---------- | --------------- | ------------------------------------------------------ |
| 1          | Discovery  | `agent-failure` | Retained as `discovery-01`; no successful TLS hostname |
| 2          | Restricted | Not started     | No discovery-derived allowlist; no invocation consumed |
| 3          | Restricted | Not started     | No discovery-derived allowlist; no invocation consumed |

The authorized native command was:

```sh
CODEX_AUTH_JSON_PATH=<dedicated-external-auth.json> \
  BENCH_RUN_ROOT=/Users/ky6uk/.agent-stack-bench/runs/harness-bench/issue-2-final-v5 \
  pnpm spike:issue-2 -- --phase discovery --run-id discovery-01
```

The intent was written at `2026-09-04T16:06:18.121Z`; completion was written at
`2026-09-04T16:16:44.750Z`, for 626.629 seconds of recorded wall time. Harbor
returned normally, while the trial retained `AgentTimeoutError: Agent execution
timed out after 600.0 seconds`. The merged native event output contained one
`thread.started`, one `turn.started`, one completed item, and 16 error events. The
errors repeatedly reported `tls handshake eof`, then waited for network after an
error sending the request. No token or subscription-usage count was available, so
usage is `unknown` rather than inferred.

The record contains one native session JSONL, one ATIF trajectory, merged
`codex.txt`, the trial log, a complete artifact manifest, collector evidence,
verifier output, `completion.json`, and a matching 32-entry SHA-256 manifest. The
main-stop and collector-completion evidence passed. The observer was active before
collection and both `dumpcap` and `tshark` stopped successfully. Codex home and
secret directories were empty after cleanup, the dedicated auth source did not
change, and the final scan found no suspected secret.

The observer retained 218 DNS metadata records for `chatgpt.com` and
`ab.chatgpt.com`, but no TLS ClientHello or ServerHello record. Harbor redirects
controlled TCP to the local GOST listener on port 12345 after the capture filter,
so the port-443-only observer did not see the redirected TLS stream. This is an
evidence gap, but not the cause of the agent timeout.

A separate provider-free control reproduced the network failure in a user-defined
Docker network using the exact pinned sidecar and agent images. The executed core
sequence was:

```sh
docker network create harness-bench-egress-diagnostic-net
docker run --detach --name harness-bench-egress-broad-diagnostic \
  --network harness-bench-egress-diagnostic-net \
  --cap-add NET_ADMIN --cap-add NET_RAW \
  --entrypoint /opt/egress-sidecar/entrypoint.sh \
  --env EGRESS_CONTROL_INITIAL_NETWORK_MODE=allowlist \
  --env 'EGRESS_CONTROL_INITIAL_ALLOWED_HOSTS=0.0.0.0/0 ::/0' \
  harbor-prebuilt:harbor-docker-egress-control-sidecar
docker run --rm \
  --network container:harness-bench-egress-broad-diagnostic \
  harness-bench-issue-2-agent:0.153.2-arm64 \
  node --input-type=module --eval \
  'for (const url of ["https://example.com/","https://chatgpt.com/"]) { try { const response=await fetch(url,{redirect:"manual",signal:AbortSignal.timeout(10000)}); console.log(new URL(url).hostname,response.status); } catch (error) { console.log(new URL(url).hostname,error.cause?.code??error.name,error.cause?.message??error.message); } }'
docker exec harness-bench-egress-broad-diagnostic \
  network-policy allow example.com chatgpt.com
docker run --rm \
  --network container:harness-bench-egress-broad-diagnostic \
  harness-bench-issue-2-agent:0.153.2-arm64 \
  node --input-type=module --eval \
  'for (const url of ["https://example.com/","https://chatgpt.com/"]) { try { const response=await fetch(url,{redirect:"manual",signal:AbortSignal.timeout(10000)}); console.log(new URL(url).hostname,response.status); } catch (error) { console.log(new URL(url).hostname,error.cause?.code??error.name,error.cause?.message??error.message); } }'
```

With `0.0.0.0/0 ::/0`, both requests failed before TLS with `ECONNRESET`.
Replacing the CIDRs with the exact hostnames made the same requests return HTTP 200
and 403 respectively. An earlier default-bridge diagnostic returned `EAI_AGAIN` and
was discarded because it did not reproduce Harbor's user-defined Compose network.
An initial sidecar launch without Harbor's explicit entrypoint exited 1 with its
base-image `gost` configuration error and was also discarded.

The Compose-like control isolates the first blocker: Harbor's transparent GOST
allowlist does not make the frozen CIDR entries a usable broad discovery allowance
for SNI-sniffed HTTPS. The discovery run therefore could not derive the required
narrow hostname list. It was not retried, no allowlist was silently expanded, and
no fallback model ran.

Each run writes immutable `run-intent.json` before Harbor starts and a separate
`completion.json` linked by the intent SHA-256. Harbor raw results, trial log,
native session JSONL, ATIF, merged output, collector patch/tree manifest, numeric
reward facets, structured verification with applicability and error classes, and a
complete content manifest remain in the external restricted run root. The upstream
Codex adapter irreversibly merges
stderr into stdout; this spike retains the merged output and does not invent stream
separation.

## Security and applicability

The configured agent receives only a writable synthetic workspace, a fresh Codex
home, and the dedicated auth material selected by explicit path. The image and
mount controls expose no trusted Git metadata, hidden checks, reference patch, host
home, or Docker socket. Native canary evidence is unavailable because Codex never
reached the task. Collection still ran after Harbor reported the main service
stopped, ignored agent `.git`, validated entry types and limits, double-hashed the
tree 500 ms apart, and constructed an empty binary patch from its own immutable
baseline.

The verifier started in a fresh separate environment without credentials or a
Docker socket. Its native network check expected loopback-only interfaces, while
Harbor implements `no-network` with an nftables sidecar in a non-loopback namespace;
that check failed. Revision `public-1` instead explicitly selects Docker networking
`none` for the separate verifier and retains the loopback-only check. The final reward was
`integrity=0`, `regressions=1`, `scope=1`, `task_contract=0`, and `validGrade=false`.
The provider-free verifier control with Docker `--network none` remains valid, but
it did not prove Harbor's native verifier network topology.

The final secret scan occurs before a run record becomes read-only. A suspected
secret leaves a restricted quarantine record and blocks commit or publication.
Passing controls do not prove that pattern scanning finds every possible secret.
Any native result applies only to the recorded macOS Apple Silicon, Docker Desktop,
LinuxKit, and Linux/arm64 identities.

## Decision

Owner decision: **no-go for the restricted-network protocol**, confirmed in this
task. The broad-CIDR discovery policy reset HTTPS before TLS while exact hostnames
succeeded; native observer and verifier topology gaps were also retained.

The owner subsequently replaced the agent-network requirement with unrestricted
internet. No fallback is opened for the retired requirement. The revised public
protocol above requires its own native evidence and owner go/no-go; issue 3 and
downstream implementation remain unstarted.
