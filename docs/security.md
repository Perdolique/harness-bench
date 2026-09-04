# Security and threat model

## Status and assets

This threat model was accepted on 2026-09-05 from the issue 2 evidence and issue 3
review. Assets include subscription credentials, private source code, local host
data, hidden tests/reference solutions, immutable experiment inputs, and
trustworthy results. Task text, repository files, agent commands, patches, and
emitted logs are untrusted. The local owner, pinned runner/collector, and verifier
image are trusted components whose exact revisions must be recorded. Acceptance
includes the residual risks below; it is not a claim of egress containment.

## Threats and required controls

| Threat / boundary | Accepted evidence | Residual limit or required control | Follow-up |
| --- | --- | --- | --- |
| Credentials copied with a home or harness | Explicit external `auth.json`, fresh temporary state, unchanged auth hash, empty cleanup volumes, and zero scan findings in three native runs | Allowlist harness inputs; reject auth/history/cache and escaping paths; refresh remains unproved | Issues 5 and 12 |
| Credential reading or exfiltration by repository commands | Native auth worked through the minimal file path and Docker mounts excluded the host home | Agent commands can read temporary auth and have unrestricted egress; owner accepts this risk for explicitly authorized runs | Issue 13 gate before private import |
| Hidden tests, solution, or future Git history visible to agent | Hidden-file and image-layer controls passed; verifier material stayed in a separate image | Materialize a one-commit repository without copying the source object database, refs, remotes, hooks, credentials, or later history; retain no unreachable objects | Issues 6, 12, and 14 |
| Agent modifies collector, `.git`, or artifacts | Adversarial capture controls and three native records proved trusted-baseline collection after successful stop | Fail on stop, stability, collection, manifest, or hash error; never trust agent Git metadata | Issues 7, 8, and 12 |
| Artifact replay overwrites verifier inputs or escapes workspace | Traversal, unsafe-link, special-file, path-collision, and missing/conflicting artifact controls failed closed | Keep paths declared and disjoint; apply only validated inputs in a disposable verifier workspace | Issues 6 and 12 |
| Malicious patch changes tests, dependencies, or infrastructure | Out-of-scope control failed grading while the valid patch and regressions passed | Use external direct/regression checks and evidence-backed allowed, conditional, and forbidden zones | Issues 6, 12, and 15 |
| Verifier accesses external network | Complete Harbor lifecycle passed with Docker `network_mode: none`; networked-verifier negative control was rejected | Recheck the effective network on every environment or runner revision | Issue 12 |
| Container accesses host or trusted services | Agent had bounded volumes and no host-home or Docker-socket mount; collector and verifier were separate services | Public Docker networking may reach host services; do not claim host-network isolation | Issues 7 and 12 |
| Logs and trajectories expose source or secrets | Restricted staging, pre-finalization scanning, quarantine controls, and read-only hashed records passed | Scanning is incomplete and cannot prevent live exfiltration; finalize no suspected record and publish only derived sanitized exports | Issues 8 and 18 |
| Scoring drift or raw rewriting hides failures | Initial/completion linkage, immutable manifests, retained historical failure, and separate verifier evidence were demonstrated | Version all inputs and emit new normalization/regrade records; never edit the source result | Issues 8, 11, and 13 |

## Credential lifecycle

Use a dedicated directory outside the repository, such as
`~/.agent-stack-bench/credentials/codex/`. The accepted flow uses file storage
and passes the absolute `auth.json` path explicitly. Never inspect or copy the
owner's ambient Codex credential store.

Official Codex supports file or keyring storage and token refresh. The pinned
Harbor path used a specified `auth.json` in temporary state and cleanup succeeded
in all three public runs. No token expired, so the evidence does not prove refresh,
read-only refresh compatibility, or persistence across runs. On authentication or
refresh failure, retain safe diagnostics, stop, and require owner login; never
silently fall back to ambient credentials or API auth.
[Codex authentication](https://learn.chatgpt.com/docs/auth) and
[Harbor adapter](https://github.com/harbor-framework/harbor/blob/4407eb5227a2ff4f0d3f16b2eb48849382fdf276/src/harbor/agents/installed/codex.py).

Credentials must never be committed, bundled, logged, persisted in run artifacts,
or exposed to the verifier. Read-only access may be introduced only after compatible
refresh behavior is proved. Any future controlled update of the dedicated store
stays outside artifacts. No blanket mount of a user home is allowed.

## Network and host exposure

Harbor's Codex adapter bypasses the CLI's internal sandbox. Treat Docker and Harbor
policy as the operative boundary and record this difference from the daily stack.
An unchanged `CODEX_HOME` alone does not isolate project/system config, ambient
environment variables, or `$HOME/.agents/skills`; inspect effective configuration.

The owner selected unrestricted agent internet on 2026-09-05 to match normal
development conditions. Agent setup and execution use Harbor `public` networking,
without a hostname allowlist, direct-IP/gateway blocks, packet observer, or TLS
proxy. Docker filesystem isolation does not prevent network access to host services
or exfiltration of files the agent can read, including its temporary native-client
credentials. This is an explicit residual risk; do not claim egress containment or
import private tasks before the later owner gate.

The trusted collector and fresh verifier use Docker `network_mode: none`. Prebuild
the verifier's dependencies; hidden tests and credentials never enter the agent's
workspace together. Validate public HTTPS from the agent and loopback-only verifier
networking through the actual Harbor lifecycle on Docker Desktop's LinuxKit VM.
This is a revised product requirement, not a retroactive green result for the
failed restricted-network protocol. Evidence applies only to the tested macOS
Apple Silicon/Linux-arm64 target, not Intel Mac, WSL2, or arbitrary Docker hosts.

The default policy is `HARBOR_TELEMETRY=off` for every local benchmark command.
An owner-approved experiment opt-in is explicit metadata, not inherited ambient
state. Source code sent to the model is an intentional disclosure to the provider;
local containers do not make provider processing local.

## Capture, retention, and publication

Collect only declared patch/artifact paths and necessary execution evidence.
Credential directories are never collection roots. Raw output first enters a
mode-0700 restricted staging root. Secret checks run over that complete staged
record before hashing and read-only finalization. A suspected credential leaves the
record quarantined and blocks durable finalization or publication while preserving
safe diagnostic metadata. The issue 2 positive and negative controls demonstrated
this boundary, including logs generated before normalization.

A passing scan is not proof that every secret is absent. It cannot prevent an
agent from transmitting readable data during execution and does not authorize
public release.

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

Issue 2 satisfied the gate with base-fails/reference-passes controls, three retained
public agent runs, offline verifier probes, credential and hidden-file visibility
checks, independent complete collection, and the explicit residual risks above.
Its restricted-network failure remains a separate invalid grade.

Later revisions must reproduce their applicable controls. A stop or artifact
collection warning is not acceptable integrity evidence. Loss of trustworthy
collection, separate offline verification, or required native behavior stops the
main path and requires a focused fallback issue and ADR.
