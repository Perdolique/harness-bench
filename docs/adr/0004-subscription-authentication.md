# ADR 0004: Dedicated local ChatGPT subscription authentication

- Date: 2026-09-03
- Status: Proposed — pending feasibility

## Context

The target daily workflow is native Codex with ChatGPT subscription access.
Substituting API authentication would change the stack and billing conditions.
Reusing an entire ambient Codex home would mix credentials, history, and harness.

## Decision

Use a dedicated external local login store and minimum auth material, separately
from immutable harness bundles. Materialize a fresh non-auth home for every run.
Prefer read-only credential access where compatible with refresh. Never place auth
in source control, logs, run artifacts, or verifier inputs. Subscription money is
not inferred from token counts.

## Evidence

[Official authentication guidance](https://learn.chatgpt.com/docs/auth) documents
subscription login, file/keyring caching, and refresh. The pinned Harbor adapter
accepts an explicit `CODEX_AUTH_JSON_PATH` and creates a temporary home; see
[research](../research-snapshot.md). Minimum files, host allowlist, token refresh,
and effective harness/permission fidelity have not been demonstrated locally.

## Alternatives

API auth is a later explicit mode, not an automatic fallback. Ambient home mounting
violates reproducibility and least exposure. Enterprise-only credentials are not
assumed available to this owner.

## Consequences

Provider identity and quota may remain opaque. Native commands may access the
client's auth material; isolation and egress controls reduce but do not eliminate
this risk. Record limits and failures honestly and default concurrency to one.

## Validation gate

[Issue 2](../../.planning/issues/02-feasibility-spike.md) establishes exact commands,
files, hosts, refresh/cleanup behavior, and two repeated runs. Owner review decides
whether the native workflow and credential exposure are acceptable before issue 3.
