# ADR 0002: A thin TypeScript control plane over Harbor

- Date: 2026-09-03
- Accepted: 2026-09-05
- Status: Accepted

## Context

The owner works in TypeScript, while Harbor's execution ecosystem is Python.
Configuration, harness comparison, statistics, and reports are project-specific;
container lifecycle and native-agent execution already belong to Harbor.

## Decision

Use `benchctl` as a thin TypeScript CLI over the pinned Harbor executable. Keep
schemas, core resolution, result normalization, statistics, and reporting in the
planned TypeScript packages. Restrict Python to pinned Harbor and necessary
tooling locked through uv.

Do not promote the issue 2 spike into a production abstraction. Its TypeScript
scripts remain isolated under `spikes/`; issues 4 through 9 build the production
surface in independently reviewable slices.

## Evidence

Version-specific Harbor and Codex sources are pinned in the
[research source register](../research-snapshot.md#primary-source-register).
The [feasibility report](../spikes/harbor-codex-subscription.md#public-1-provider-free-evidence)
records the TypeScript entry points and exact commands used to resolve Harbor
inputs, invoke the pinned executable, retain its outputs, and classify results.
`BENCH_RUN_ROOT=<external>/issue-2-public-1-final pnpm spike:issue-2:check`
completed with zero provider calls; its preflight SHA-256 is
`a2ba6b8bc21dc4023d1b25f8c30bafc7a974186d0d3f2eb540dceaf1dea7d9da`.

The exact native commands in the report produced complete public-01, public-02,
and public-03 records. Their manifest SHA-256 values are respectively
`62b9c15290b12185c3f45a767e475ebb6d4a54c81a27729a086f0627741b81eb`,
`88b7d0c00e500fed64627330e6ee19235fbb1612f68c80a62d98e32bfd2ceb50`,
and `6f5cf36cc589ed908db0d0173220b94bf83466aef598de1e0dc17bd69c9242f6`.
This proves that a TypeScript caller can drive the required boundary and retain
evidence. It does not prove the design of the future control plane or its schemas.

## Alternatives

An all-Python control plane reduces the language boundary but departs from the
owner's preferred stack. Reimplementing Harbor in TypeScript duplicates lifecycle
and verifier responsibilities. A generic provider or plugin framework is premature
for the accepted single native-agent path.

## Consequences

The CLI boundary must preserve exact arguments, statuses, version provenance, and
raw files. Production packages need deterministic fake-agent tests, so ordinary CI
never invokes a provider. Harbor remains authoritative for runtime lifecycle; a
TypeScript wrapper must not grow into a second runner.

## Validation gate

Issue 2 demonstrated the invocation and evidence path, and issue 3 accepts the
boundary. Issues 4 through 9 still have to define and test each production
interface. No runtime API, schema, or `benchctl` command is created by this ADR.
