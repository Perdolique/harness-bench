# ADR 0004: Dedicated local ChatGPT subscription authentication

- Date: 2026-09-03
- Accepted: 2026-09-05
- Status: Accepted

## Context

The target daily workflow is native Codex with ChatGPT subscription access.
Substituting API authentication would change the stack and billing conditions.
Reusing an entire ambient Codex home would mix credentials, history, and harness.

## Decision

Use a dedicated external file-based ChatGPT login store and pass its explicit
`auth.json` path to Harbor. Materialize fresh non-auth Codex home and secrets
volumes for each run. Never include credentials in source control, harness bundles,
logs, raw run records, or verifier inputs. Do not infer subscription money from
token counts or Harbor's API-price estimate.

`auth.json` contains plaintext access tokens and is password-equivalent. Keep it
out of tickets, chat, shared folders, and uncontrolled sync/backup or copying paths;
only the owner and the explicit local run receive access.

Token refresh, persistence of refreshed credentials across runs, and compatibility
with read-only access are not demonstrated. An authentication or refresh failure
stops the run with its own classification and requires the owner to log in again;
there is no automatic API-auth fallback or retry.

## Evidence

Version-specific Harbor and Codex authentication sources are pinned in the
[research source register](../research-snapshot.md#primary-source-register).
The current official authentication page additionally documents plaintext
password-equivalent file storage and the required handling restrictions.
The [native run card and commands](../spikes/harbor-codex-subscription.md#revised-native-run-card-authorized-then-amended)
record `CODEX_AUTH_JSON_PATH=<dedicated-external-auth.json>` for public-01,
public-02, and public-03. All completed with `chatgpt-file` authentication, and the
external auth file hash was unchanged before and after each run. Temporary Codex
home and secrets directories were empty after cleanup, and secret scans had zero
findings.

The three immutable manifest SHA-256 values are
`62b9c15290b12185c3f45a767e475ebb6d4a54c81a27729a086f0627741b81eb`,
`88b7d0c00e500fed64627330e6ee19235fbb1612f68c80a62d98e32bfd2ceb50`,
and `6f5cf36cc589ed908db0d0173220b94bf83466aef598de1e0dc17bd69c9242f6`.
The pinned config-control artifact has SHA-256
`92d2787c3e73f083d0ad8f2c6564bcdb6fa10888d33beac65e4779e275603f9f`.

## Alternatives

API authentication is a later explicit experiment mode, not an automatic fallback.
Ambient home mounting violates reproducibility and exposes unrelated credentials,
history, configuration, and skills. Enterprise-only credentials are not assumed
available to this owner.

## Consequences

The native client and agent-executed commands can read temporary credentials while
the agent has unrestricted internet. Docker isolation and secret scanning do not
prevent exfiltration. This residual risk is accepted for the synthetic and later
explicitly authorized local runs; private tasks remain behind the issue 13 owner
gate. Provider identity and quota may remain `unknown`.

## Validation gate

Issue 2 proved explicit file login, effective ChatGPT auth, per-run temporary state,
cleanup, and repeated execution. It did not exercise token expiry or refresh.
Refresh remains a documented operational limitation rather than an assumed
capability or a blocker for accepting this ADR.
