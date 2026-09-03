# ADR 0002: A thin TypeScript control plane over Harbor

- Date: 2026-09-03
- Status: Proposed — pending feasibility

## Context

The owner works in TypeScript, while Harbor's execution ecosystem is Python.
Configuration, harness comparison, statistics, and reports are project-specific;
container lifecycle and native-agent execution already belong to the kernel.

## Decision

Use `benchctl` as a TypeScript CLI over the pinned Harbor executable. Keep schemas,
core resolution, result normalization, statistics, and reporting separate as
described in [architecture](../architecture.md). Python is restricted to Harbor
and necessary tooling, pinned and locked through uv.

## Evidence

The [research snapshot](../research-snapshot.md) confirms Harbor's CLI entry point,
Python requirement, native adapter interface, and retained result surface. Whether
all project needs can be met without adaptation is still a spike question.

## Alternatives

An all-Python control plane reduces language boundaries but departs from the owner's
preferred development stack. Reimplementing Harbor in TypeScript duplicates the
hardest platform work. A generic provider/plugin framework is premature for one
unproven native-agent path.

## Consequences

The CLI boundary must preserve exact arguments, statuses, version provenance, and
raw files. Deterministic fake-agent integration tests avoid provider calls in CI.
Package abstractions wait until feasibility is accepted; no runtime code is added
by this ADR.

## Validation gate

[Issue 2](../../.planning/issues/02-feasibility-spike.md) demonstrates the concrete
invocation/evidence path. [Issue 3](../../.planning/issues/03-evidence-based-decisions.md)
confirms the boundary before issue 4 schemas and issue 7 orchestration.
