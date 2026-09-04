# Task authoring

## Author one engineering task

Begin with a short realistic request and an explicit repository base commit.
Freeze source bytes and image digests before grading. The agent receives the
prompt, allowed repository snapshot, explicit harness, tools, and budgets. Hidden
checks, the reference patch, future history, and credentials remain outside its
filesystem. No runtime clone from a moving branch is permitted.

Materialize those frozen bytes as a new local repository with exactly one base
commit. Do not copy the source object database, refs, remotes, hooks, credentials,
alternates, or later commits; retain only objects reachable from the new commit.
Record source provenance separately. The trusted collector compares against its
own immutable baseline and ignores the agent-visible `.git` directory.

The first task is a small synthetic TypeScript/Vue repository: a secondary UI
action with established analytics, localization, accessibility, and test precedents.
The prompt requests behavior without listing those obligations. Issue 6 authors
this task after the accepted feasibility review and proves that ordinary Git
commands work without exposing future history.

## Harbor package and visibility

Harbor task packages contain `instruction.md`, `task.toml`, an `environment/`,
`tests/`, and optionally `solution/`. Select an explicit separate verifier image
whose build context contains the hidden checks. In separate mode the image itself
must supply `/tests/test.sh`; do not expect runtime test upload. Both images start
from the declared base, but only the verifier image has hidden checks. Public
regression tests already present in the base remain visible to the agent.
[Pinned task format](https://github.com/harbor-framework/harbor/blob/4407eb5227a2ff4f0d3f16b2eb48849382fdf276/docs/content/docs/tasks/index.mdx).

Declare a narrow patch/metadata interface with no overlap with `/tests`, verifier
logs, auth, or trusted tools. Account for Harbor's implicit `/logs/artifacts`
transfer. Inspect artifact manifests and hashes; absent, failed, or skipped inputs
invalidate grading. Collect the actual workspace change independently of voluntary
agent export. Task authors do not implement another sandbox runner.

## Evidence-backed rubric

Each obligation records its ID, expectation, evidence paths anchored to the pristine
base/digest, justification, deterministic check, applicability, and weight. The
evidence must exist before the agent's patch; do not use the reference solution as
the precedent. Requirements contradicted by existing supported behavior are invalid.

| Good expectation | Why it is supported | Bad alternative |
| --- | --- | --- |
| New checkout action uses the event contract already shared by adjacent checkout actions | Existing component behavior plus analytics declaration | Reward any analytics call without an established event |
| New visible copy uses the locale mechanism used on the same screen | Locale resources and rendered neighboring text | Demand an extra language absent from the repository |
| Secondary action is keyboard reachable with an accessible name | Existing control semantics plus an observable user interaction | Require the exact reference component or markup |
| New error case preserves diagnostic error detail while showing appropriate copy | Existing logger and error handling precedent | Require a new logging framework |

Behavioral checks should remove or break the obligation and fail. Static string
presence alone cannot prove that an event fires at the right time or a button
works. Preserve raw facets, including `not_applicable`, using
[the scoring rules](methodology.md).

## Scope envelope

Allowed zones are directly relevant files/behaviors. Conditional zones require
documented justification, such as a shared component touched by the requested
behavior. Forbidden zones include unrelated dependency churn, disabled/deleted
tests, baseline rewrites, hidden-check changes, and unrelated infrastructure.
Judge harmful scope rather than patch length; an alternate valid implementation
must not fail merely because it edits a different justified file.

## Calibration and integrity checks

1. Confirm pristine regression tests pass and new direct checks fail for the
   intended behavioral reason, not a broken environment.
2. Confirm the reference patch passes direct, contract, regression, and scope checks.
3. Confirm at least one structurally different valid solution passes the canonical
   task; do the same for every real task where practical and record exceptions.
4. Exercise negative controls: remove required behavior, omit an evidenced contract,
   delete/disable tests, and edit a forbidden path. Expected checks must fail.
5. Repeat verification with no network or credentials and identical artifacts;
   verify deterministic outcomes and absence of hidden material from agent access.
6. Obtain the issue 6 owner review using the evidence from steps 1–5 before
   downstream orchestration uses the canonical task.

After issue 12 implements `benchctl doctor`, run it and retain its evidence for
subsequent task calibration. Doctor is not a prerequisite for the initial issue 6
owner review.

Real import (issue 14) keeps private data in external owner-controlled storage,
records sanitized provenance, and leaves hidden-test authoring manual. Issue 15
formalizes the rubric used by the canonical task. Issue 16 produces five tasks
across at least three categories, documents ambiguity/difficulty, and freezes all
revisions before the final comparison. Never tune a task using the winning arm of
the sealed final experiment.
