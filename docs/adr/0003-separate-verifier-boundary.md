# ADR 0003: Separate verifier and declared artifact trust boundary

- Date: 2026-09-03
- Accepted: 2026-09-05
- Status: Accepted

## Context

An agent can change its workspace, processes, tests, and Git metadata. Verification
in that environment cannot establish trustworthy hidden grading. A voluntary patch
export also fails to prove which repository change was actually produced.

## Decision

Require a fresh verifier reconstructed from the immutable base, without network or
credentials. A trusted collector outside agent control captures the workspace from
its own baseline only after successful agent quiescence. It emits a declared,
validated patch and metadata interface independently of agent cooperation.

Hidden checks and reference solutions never enter the agent environment. Reject
missing, failed, conflicting, mutable, path-overlapping, or hash-invalid evidence;
none of those states can produce a valid grade. Agent-created `.git`, hooks, Git
configuration, symlinks, and processes are untrusted inputs.

## Evidence

Version-specific Harbor sources are pinned in the
[research source register](../research-snapshot.md#primary-source-register).
The [provider-free controls](../spikes/harbor-codex-subscription.md#public-1-provider-free-evidence)
ran the complete Harbor stop, trusted collection, and separate offline verifier
lifecycle with the exact command
`BENCH_RUN_ROOT=<external>/issue-2-public-1-final pnpm spike:issue-2:check`.
The preflight SHA-256 is
`a2ba6b8bc21dc4023d1b25f8c30bafc7a974186d0d3f2eb540dceaf1dea7d9da`.
It includes base-fails/reference-passes, out-of-scope, networked-verifier rejection,
and hidden-test-absence controls.

All three public native records report successful main stop, independent
collection, valid artifact manifests, and separate verification. Their manifest
SHA-256 values are public-01
`62b9c15290b12185c3f45a767e475ebb6d4a54c81a27729a086f0627741b81eb`,
public-02 `88b7d0c00e500fed64627330e6ee19235fbb1612f68c80a62d98e32bfd2ceb50`,
and public-03 `6f5cf36cc589ed908db0d0173220b94bf83466aef598de1e0dc17bd69c9242f6`.

## Alternatives

Shared verification exposes checks and mutable dependencies. Copying a whole agent
home risks credentials and unrelated state. Trusting an agent-generated diff
allows omission or manipulation. None meets the required boundary.

## Consequences

Verifier dependencies must be prebuilt. The collector and verifier stay offline,
and verifier inputs must be disjoint from credentials, hidden checks, verifier
code, and Harbor's implicit `/logs/artifacts` path. Regrade can reuse only captured
bytes whose hashes and provenance still validate.

The spike proves a narrow synthetic implementation, not a reusable production
collector. Issue 6 must exercise the canonical task boundary; issue 12 must turn
the integrity controls into repeatable product diagnostics.

## Validation gate

Issue 2 satisfied the feasibility gate on the selected environment. Every later
task and run must fail closed unless quiescence, independent capture, complete
declared inputs, hashes, hidden-material isolation, and offline verification are
demonstrated for that exact revision.
