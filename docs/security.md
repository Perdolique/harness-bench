# Security and threat model

## Status and assets

This threat model is proposed pending issue 2 evidence and issue 3 review. Assets
include subscription credentials, private source code, local host data, hidden
tests/reference solutions, immutable experiment inputs, and trustworthy results.
Task text, repository files, agent commands, patches, and emitted logs are
untrusted. The local owner, pinned runner/collector, and verifier image are trusted
components whose exact revisions must be recorded.

## Threats and required controls

| Threat / boundary | Required control | Evidence owner |
| --- | --- | --- |
| Credentials copied with a home directory or harness | Explicit input allowlist; external credential store; fresh non-auth home; reject auth/history/cache paths and escaping links | Issues 2, 5, 12 |
| Credential reading or exfiltration by repository-driven commands | Minimal native-client auth material, measured egress, no extra secrets; document residual native-client credential visibility | Issues 2, 3 |
| Hidden tests, solution, or future history visible to agent | Separate image/build contexts; frozen base only; inspect filesystem and image layers accessible to the agent | Issues 2, 6, 12, 14 |
| Agent modifies collector, `.git`, or artifacts during collection | Trusted baseline and collector outside agent control; verified quiescence; fail on collection/stop error; hash captured bytes | Issues 2, 7, 8 |
| Artifact replay overwrites checker or escapes workspace | Declared disjoint paths; reject traversal, unsafe symlinks, special files, and path overlap; apply patch inside disposable workspace with trusted tooling | Issues 2, 6, 12 |
| Malicious patch deletes tests, rewrites dependencies, or changes infrastructure | Immutable external verifier; direct/regression checks; evidence-backed allowed/conditional/forbidden scope zones | Issues 6, 12, 15 |
| Provider/verifier accesses undeclared network | Enforce agent allowlist from environment startup where possible; explicit verifier no-network baseline and runtime denial probes | Issues 2, 12 |
| Container accesses host or trusted sidecars | No host home or Docker socket mounts; bounded workspace mounts; no agent control of collector/egress services | Issues 2, 3 |
| Logs and trajectories expose private code/secrets | Restricted local evidence root, secret scanning before durable retention/publication, derived sanitized exports only | Issues 2, 8, 18 |
| Scoring drift or raw-record rewriting hides failures | Independently versioned inputs, immutable raw records, hash checks, separate regrade outputs | Issues 8, 11, 13 |

## Credential lifecycle

Use a dedicated directory outside the repository, such as
`~/.agent-stack-bench/credentials/codex/`. Discover and document the actual local
login procedure and minimum files in issue 2 using current official behavior.
Never inspect or copy the owner's ambient Codex credential store during planning.

Official Codex supports file or keyring storage and token refresh. The researched
Harbor adapter can upload a specified `auth.json`, links it into a temporary home,
then attempts cleanup. This is not proof that read-only mounting works or that
refresh survives across runs. Test refresh and cleanup with the dedicated login;
never silently fall back to ambient credentials or API auth.
[Codex authentication](https://learn.chatgpt.com/docs/auth) and
[Harbor adapter](https://github.com/harbor-framework/harbor/blob/4407eb5227a2ff4f0d3f16b2eb48849382fdf276/src/harbor/agents/installed/codex.py).

Credentials must never be committed, bundled, logged, persisted in run artifacts,
or exposed to the verifier. Use read-only access where proven compatible; if refresh
needs write access, isolate it to temporary auth state and document a controlled
update of the dedicated store, outside artifacts. No blanket mount of a user home.

## Network and host exposure

Harbor's Codex adapter bypasses the CLI's internal sandbox. Treat Docker and Harbor
policy as the operative boundary and record this difference from the daily stack.
An unchanged `CODEX_HOME` alone does not isolate project/system config, ambient
environment variables, or `$HOME/.agents/skills`; inspect effective configuration.

Required provider hosts are **unknown until measured**. Separate dependency/image
build traffic from agent runtime traffic. Prebuild pinned dependencies so the
offline verifier does not install packages. Validate DNS, IPv4/IPv6, direct egress,
host reachability, and Docker/WSL nftables support against the chosen policy.
No network relaxation is allowed just to get a green result.

The default policy is `HARBOR_TELEMETRY=off` for every local benchmark command.
An owner-approved experiment opt-in is explicit metadata, not inherited ambient
state. Source code sent to the model is an intentional disclosure to the provider;
local containers do not make provider processing local.

## Capture, retention, and publication

Collect only declared patch/artifact paths and necessary execution evidence.
Credential directories are never collection roots. At the capture boundary,
secret checks must prevent a suspected credential from entering the durable run
record; a failed check aborts finalization and produces safe diagnostic metadata.
The spike must prove this boundary, including logs generated before normalization.
Do not promise that a scan is a complete secret detector.

Finalized raw source/trajectory records stay immutable in a restricted local root.
Private source is allowed only in owner-authorized local task/run storage, never in
this public planning repository. Sanitization produces a separate export with
source digests and a redaction report. Passing automation does not authorize public
publication of private code. No automatic upload is part of v1.

If a secret is discovered after retention, stop use/publication, restrict access,
notify the owner for credential rotation, and record the incident. Do not silently
rewrite the original as if it had always been clean. Any exceptional removal of
compromised evidence requires owner action and a provenance tombstone.

## Feasibility security gate

Require base-fails/reference-passes controls, two retained agent runs, offline
verifier probes, credential and hidden-file visibility checks, evidence of
independent complete collection, and explicit residual risks. A stop or artifact
collection warning is not acceptable integrity evidence. If a required property
cannot be shown, stop the main path and use the documented fallback order.
