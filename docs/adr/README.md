# Architecture decision records

ADRs preserve a decision, its evidence, alternatives, and consequences. Initial
records are **Proposed — pending feasibility**. Official source capability is not
proof of compatibility or safety on the owner's stack. Issue 3 may mark decisions
Accepted only after the issue 2 evidence and owner gate support them.

## Records

| ID | Decision | Status |
| --- | --- | --- |
| [0001](0001-harbor-execution-kernel.md) | Harbor as the v1 execution kernel | Proposed — pending feasibility |
| [0002](0002-typescript-control-plane.md) | Thin TypeScript control plane | Proposed — pending feasibility |
| [0003](0003-separate-verifier-boundary.md) | Separate verifier and artifact trust boundary | Proposed — pending feasibility |
| [0004](0004-subscription-authentication.md) | Dedicated local ChatGPT subscription authentication | Proposed — pending feasibility |
| [0005](0005-immutable-raw-artifacts.md) | Immutable raw records as source of truth | Proposed — pending feasibility |

## Required format

Use an incrementing four-digit ID and descriptive English filename. Include Title,
Date, Status, Context, Decision, Evidence, Alternatives, Consequences, and Validation
gate. Cite exact source revisions and concrete spike artifacts. Explicitly label
assumptions and unknowns. Record owner acceptance in the linked issue/PR.

Allowed states: Proposed, Accepted, Rejected, Superseded. Preserve accepted decision
history; a replacement links to the old record and marks it Superseded. Do not
retcon failed feasibility evidence or add Pier alongside Harbor without a decision.
