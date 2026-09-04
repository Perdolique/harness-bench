# ADR 0001: Harbor as the v1 execution kernel

- Date: 2026-09-03
- Accepted: 2026-09-05
- Status: Accepted

## Context

The project needs native Codex, controlled environments, independent artifact
collection, separate verification, and reusable evidence. Building a sandbox
platform would delay the engineering comparison the owner actually needs.

## Decision

Use Harbor 0.22.0 as the v1 execution kernel. Harbor owns lifecycle, native-agent
adaptation, network policy, artifacts, trajectories, and supported regrade. Use
Harbor-compatible single-step tasks on macOS Apple Silicon with Docker Desktop
Linux/arm64 containers.

The effective Codex invocation, including `danger-full-access` and approval policy
`never`, is part of the recorded stack identity. Docker provides the agent
filesystem and process boundary. Agent setup and execution use unrestricted public
networking; collector and verifier containers remain network-disabled.

## Evidence

Version-specific Harbor and Codex sources are pinned in the
[research source register](../research-snapshot.md#primary-source-register).
The [feasibility report](../spikes/harbor-codex-subscription.md#public-1-provider-free-evidence)
records the exact provider-free command
`BENCH_RUN_ROOT=<external>/issue-2-public-1-final pnpm spike:issue-2:check` and
its nine passing Docker controls. The retained preflight has SHA-256
`a2ba6b8bc21dc4023d1b25f8c30bafc7a974186d0d3f2eb540dceaf1dea7d9da`.

The report also records the exact three public native commands and their immutable
manifest SHA-256 values: public-01
`62b9c15290b12185c3f45a767e475ebb6d4a54c81a27729a086f0627741b81eb`,
public-02 `88b7d0c00e500fed64627330e6ee19235fbb1612f68c80a62d98e32bfd2ceb50`,
and public-03 `6f5cf36cc589ed908db0d0173220b94bf83466aef598de1e0dc17bd69c9242f6`.
All three completed with valid grades and every reward facet equal to one. Native
evidence recorded the effective model, effort, permissions, harness, public agent
network, successful stop and collection, and fresh offline verification.

## Alternatives

A supported `codex exec --json` Harbor adapter is the first fallback. Host-managed
Codex against an ephemeral Docker workspace with Harbor verification is second.
Pier evaluation is third. A custom sandbox platform and Coder Eval remain out of
scope.

A fallback requires a separate issue and ADR when Harbor can no longer provide
trustworthy collection, separate verification, or required native-agent behavior.
The accepted Git, refresh, stream-merging, and public-network limitations do not
trigger a fallback by themselves.

## Consequences

The project inherits Harbor output and lifecycle constraints. Exact pins and
fail-closed integrity checks remain mandatory; a kernel upgrade changes experiment
identity. Public networking can expose any agent-visible data to remote or host
services. The accepted result applies only to the recorded macOS Apple Silicon and
Docker Desktop Linux/arm64 environment.

## Validation gate

[Issue 2](../../.planning/issues/02-feasibility-spike.md) is closed and merged, and
the owner accepted qualified go on 2026-09-05. Issue 3 accepts this decision from
the retained evidence. Later tasks must re-prove their own task, collection, and
verifier contracts rather than treating the synthetic spike as production proof.
