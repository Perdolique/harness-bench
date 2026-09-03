# ADR 0001: Harbor as the v1 execution kernel

- Date: 2026-09-03
- Status: Proposed — pending feasibility

## Context

The project needs native Codex, controlled environments, independent artifact
collection, separate verification, and reusable evidence. Building a sandbox
platform would delay the engineering comparison the owner actually needs.

## Decision

Plan v1 around Harbor 0.22.0. Harbor owns lifecycle, adaptation, network enforcement,
artifacts, trajectories, and supported regrade. Use Harbor-compatible single-step
tasks. No Pier or Coder Eval dependency is introduced by this decision.

## Evidence

The [research snapshot](../research-snapshot.md) records the release SHA and
inspected task, Codex, network, collection, and regrade sources. Separate mode and
network policies exist, but defaults and best-effort error handling do not by
themselves satisfy this project's guarantees.

## Alternatives

A small Harbor Codex adapter is the first fallback, host-managed Codex with Docker
workspace and Harbor verification the second, and Pier evaluation the third.
A custom sandbox platform is out of scope. No fallback is selected without evidence.

## Consequences

The project inherits upstream output/version constraints. Exact pins and fail-closed
integrity checks are necessary; a kernel upgrade changes experiment identity.

## Validation gate

[Issue 2](../../.planning/issues/02-feasibility-spike.md) must prove the complete
subscription/native-agent/collector/offline-verifier path and receive owner review.
[Issue 3](../../.planning/issues/03-evidence-based-decisions.md) records acceptance
or a focused fallback ADR before production abstractions begin.
