# ADR 0003: Separate verifier and declared artifact trust boundary

- Date: 2026-09-03
- Status: Proposed — pending feasibility

## Context

An agent can change its workspace, processes, tests, and Git metadata. Verification
in that environment cannot establish trustworthy hidden grading. A voluntary patch
export also fails to prove which repository change was actually produced.

## Decision

Require a fresh separate verifier with no credentials or network, rebuilt from the
same immutable base. Trusted collection supplies a narrow, validated patch and
metadata interface independently of agent cooperation. Hidden checks and reference
solutions never enter the agent environment. Hashes and successful collection are
preconditions for grading.

## Evidence

[Research](../research-snapshot.md) shows separate verifier support and original-path
artifact replay. Harbor's implicit convention directory, best-effort collection,
and warning-only stop failures require explicit validation. A trusted sidecar is
one candidate, not a proven implementation.

## Alternatives

Shared verification exposes checks and mutable dependencies. Copying a whole agent
home risks credentials and unrelated state. Trusting an agent-generated diff allows
omission or manipulation. None meets the stated boundary.

## Consequences

Verifier dependencies must be prebuilt. Reject input path collisions, traversal,
unsafe links, and missing artifacts. Keep trusted baseline/tooling outside agent
control. Regrade can reuse valid captured bytes without another agent run.

## Validation gate

[Issue 2](../../.planning/issues/02-feasibility-spike.md) must prove quiescence,
independent collection, base-fails/reference-passes controls, hidden-file isolation,
and offline credential-free verification, including failure paths. No valid quality
score is reported when this boundary is unproven or violated.
