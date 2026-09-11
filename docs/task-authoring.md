# Task authoring

## Author one engineering task

Begin with a short realistic request and an explicit repository base commit. Freeze source bytes and image digests before each execution plan. During authoring, correct the task and rerun affected calibration checks as needed; freeze the full suite only before final comparison. The agent receives the prompt, allowed repository snapshot, explicit harness, tools, and budgets. Hidden checks, the reference patch, future history, and credentials remain outside its filesystem. No runtime clone from a moving branch is permitted.

The agent has unrestricted internet, so filesystem absence is only one control. Before treating checks, a solution, or later history as hidden, establish that the exact material and identifiable source history are not reachable from public repositories, mirrors, packages, caches, container registries, or other online sources. Otherwise classify the task as a plumbing/smoke fixture and exclude it from secrecy-dependent quality comparisons.

Materialize those frozen bytes as a new local repository with exactly one base commit. Do not copy the source object database, refs, remotes, hooks, credentials, alternates, or later commits; retain only objects reachable from the new commit. Record source provenance separately. The trusted collector compares against its own immutable baseline and ignores the agent-visible `.git` directory.

The first task is a small synthetic TypeScript/Vue repository: a secondary UI action with established analytics, localization, accessibility, and test precedents. The prompt requests behavior without listing those obligations. Issue 6 authors this task after the accepted feasibility review and proves that ordinary Git commands work without exposing future history locally. Because this repository and its checked-in fixtures are public, that fixture cannot by itself prove online secrecy or support a hidden-material quality claim.

The canonical implementation is split across three boundaries:

- `fixtures/order-receipt/` contains only the pristine standalone application and its public regressions.
- `benchmark/tasks/order-receipt/` contains the Harbor package templates, trusted collector, separate verifier, calibration solutions, and negative controls. Solution and verifier material are copied only into their dedicated image or oracle contexts.
- `packages/core/src/task.ts` and `packages/core/src/task-artifacts.ts` provide source inspection, one-commit materialization, trusted capture, and fail-closed replay. The caller supplies a frozen source and expected digest; materialization returns the workspace path, verified digest, and deterministic base commit.

The task package builds its `TaskDocument` v1 from the actual source, prompt, and local image digests. Task, environment, collector, verifier, scoring, and rubric revisions remain independent. Its six equally weighted repository contracts and their pristine evidence are recorded in the [calibration evidence card](tasks/order-receipt.md). The fixture has `online_reachability.status: ineligible`; use it to calibrate mechanics and grading, not for a comparison that depends on hidden checks or future solutions.

## Harbor package and visibility

Harbor task packages contain `instruction.md`, `task.toml`, an `environment/`, `tests/`, and optionally `solution/`. Declare `[agent].user` as the pinned agent image's non-root Docker `USER`; production and doctor preflight require an exact `Config.User` match and an effective UID other than `0`. Harbor uses this identity when it installs private mode-`0600` agent configuration and authentication files. Select an explicit separate verifier image whose build context contains the hidden checks. In separate mode the image itself must supply `/tests/test.sh`; do not expect runtime test upload. Both images start from the declared base, but only the verifier image has hidden checks. Public regression tests already present in the base remain visible to the agent. [Pinned task format](https://github.com/harbor-framework/harbor/blob/4407eb5227a2ff4f0d3f16b2eb48849382fdf276/docs/content/docs/tasks/index.mdx).

A separate verifier image is not automatically secret: a publicly pullable image or public build context can be inspected through the agent's network. Secrecy-sensitive checks and reference material live only in owner-controlled external storage and a non-public verifier build/pull path. Checked-in sanitized verifier fixtures are public stand-ins for deterministic CI, not hidden production grading material.

Declare a narrow patch/metadata interface with no overlap with `/tests`, verifier logs, auth, or trusted tools. Account for Harbor's implicit `/logs/artifacts` transfer. Inspect artifact manifests and hashes; absent, failed, or skipped inputs invalidate grading. Collect the actual workspace change independently of voluntary agent export. Task authors do not implement another sandbox runner.

## Evidence-backed rubric

Each obligation records its ID, expectation, evidence paths anchored to the pristine base/digest, justification, deterministic check, applicability, and weight. The evidence must exist before the agent's patch; do not use the reference solution as the precedent. Requirements contradicted by existing supported behavior are invalid.

`obligation_id` starts with a lowercase letter, contains at most 64 lowercase letters, numbers, or dashes, and is also the exact key in `verifier-result.json.checks`. A valid-grade check has only `facet`, `passed`, `credit`, and `detail`. `passed` records whether the observable obligation succeeded and controls required direct-behavior and regression gates. `credit` is the numeric contribution from `0` to `1`, so a passing check may deliberately receive partial credit. The evidence digest covers the whole check, including `credit`. Within a declared facet, core computes `sum(weight * credit) / sum(weight)` and rejects any other score. Weights are in `(0, 1]`; their relative values within one facet determine each obligation's contribution.

Every declared obligation, including an optional one, needs a check and contributes to its facet. Optional means it does not control the direct-behavior or regression hard gate; it does not mean the verifier may omit it. If a task has no obligation for a facet, write `not_applicable` with empty evidence in the score. Do not add a dummy obligation. A declared facet must be numeric in a valid grade; `unknown` is reserved for invalid or incomplete grading evidence. When scope obligations exist, recorded scope violations require failed scope checks with reduced credit, and failed scope checks require violation evidence. A task with no scope obligations keeps the facet not applicable but may still record a forbidden-path violation.

| Good expectation | Why it is supported | Bad alternative |
| --- | --- | --- |
| New checkout action uses the event contract already shared by adjacent checkout actions | Existing component behavior plus analytics declaration | Reward any analytics call without an established event |
| New visible copy uses the locale mechanism used on the same screen | Locale resources and rendered neighboring text | Demand an extra language absent from the repository |
| Secondary action is keyboard reachable with an accessible name | Existing control semantics plus an observable user interaction | Require the exact reference component or markup |
| New error case preserves diagnostic error detail while showing appropriate copy | Existing logger and error handling precedent | Require a new logging framework |
| Candidate tests fail on pristine behavior and pass on the candidate | Existing test location plus a verifier-controlled pristine transition | Award credit because a test file or title exists |

Behavioral checks should remove or break the obligation and fail. For analytics, trigger the user action and inspect the exact public event and safe properties. For logging, force the failure and inspect the established logger call while retaining raw diagnostic detail. For tests, run candidate tests against both pristine and candidate behavior. For accessibility, activate the semantic control by keyboard and assert its accessible name. For localization, mutate or select the locale source and observe rendered copy. Static string presence alone cannot prove any of these behaviors. Preserve raw facets, including `not_applicable`, using [the scoring rules](methodology.md).

The checked-in sanitized `notification-retry` rubric is a test-only authoring example, not a pilot task. It declares retry behavior, established logging, candidate tests, an existing-delivery regression, and scope. It omits analytics, accessibility, localization, and maintainability because the pristine repository provides no relevant obligation. Its reference edits the sender directly; its alternate extracts a retry helper into the declared conditional zone. Both must pass the same complete check inventory.

## Scope envelope

Allowed zones are directly relevant files or behaviors and need no exception. Conditional zones require evidence that the edit serves the requested behavior, such as a shared component or extracted helper; the alternate calibration must prove at least one justified shape when that zone is part of the authoring contract. Forbidden zones include unrelated dependency churn, disabled or deleted tests, baseline rewrites, hidden-check changes, and unrelated infrastructure. A forbidden edit must produce a recorded scope violation. Judge harmful scope rather than patch length; an alternate valid implementation must not fail merely because it edits a different justified file. Scope remains task-specific; do not infer a general glob evaluator from these declarations.

## Calibration and integrity checks

1. Confirm pristine regression tests pass and new direct checks fail for the intended behavioral reason, not a broken environment.
2. Confirm the reference patch passes direct, contract, regression, and scope checks.
3. Confirm at least one structurally different valid solution passes the canonical task; do the same for every real task where practical and record exceptions.
4. Exercise negative controls: remove required behavior, omit an evidenced contract, delete/disable tests, and edit a forbidden path. Expected checks must fail.
5. Repeat verification with no network or credentials and identical artifacts; verify deterministic outcomes and absence of hidden material from agent access.
6. Record the online-reachability assessment. Fail the secrecy gate if the exact checks, solution, later history, or identifiable source are publicly reachable.
7. Obtain the issue 6 owner review using the evidence from steps 1–6 before downstream orchestration uses the canonical task.

For the canonical fixture, run ordinary repository checks first and the complete Docker calibration separately:

```sh
vp run check
vp run task:canonical:check
```

The second command builds all pinned images before evaluation, prepares one base package with separate oracle solutions, runs Harbor with `nop` for pristine and deterministic `oracle` controls, and requires an explicit oracle completion marker. It uses one concurrent run, zero automatic retries, no model calls, and Harbor telemetry off. It validates the generated score documents, the expected failed check for every negative control, and equal results for a repeated reference artifact. Canonical numeric calibration additionally requires direct/contracts/regression/scope facets and rewards of `0/0/1/1` with composite `0` for pristine and `1/1/1/1` with composite `1` for reference, alternate, and the repeated reference. Internally consistent but incorrect numeric scoring still fails this command.

Use `benchctl doctor DEFINITION --output-dir ABSOLUTE_NEW_DIR [--purpose smoke|quality]` for subsequent calibration and retain the sealed report and raw evidence. Canonical preparation invokes this implementation directly. Doctor does not retroactively change the accepted initial issue 6 owner review.

The separate version-1 `doctor_definition` document contains `schema_version: 1`, a nonempty `revision`, `task_document`, `task_source`, `task_package`, `harness_bundle`, `forbidden_agent_paths`, and `controls`. Paths resolve relative to the definition; reference solutions are separate from the prepared base package. Each control has a unique safe `id`, `kind`, optional `solution` directory containing `solve.sh`, and `expected_checks` mapping exact rubric obligation IDs to booleans. Require exactly one `pristine`, `reference`, `alternate`, `test_deletion`, `test_disablement`, and `forbidden_edit`; additional `negative` controls are allowed. `reference-repeat` is reserved. Pristine, reference, and alternate controls declare the complete rubric inventory. Negative controls may declare only the specific known obligations expected to fail. Test deletion must fail a repository-contract obligation, and test disablement must fail a required regression obligation. A forbidden edit must produce scope-violation evidence; when the task declares scope obligations, it must also fail one of those checks. Repeat calibration compares complete verifier checks and score evidence, not only booleans or aggregate values. Oracle scripts must finish with the exact `CALIBRATION_ORACLE_OK` marker.

The reference and alternate must pass every declared check. Pristine must fail at least one required direct-behavior obligation while every required regression and evidence-integrity check remains valid. Test disablement must fail a required regression obligation. A forbidden edit must produce scope-violation evidence and, when the task declares scope obligations, fail one of those checks. Doctor repeats reference and compares patch/metadata digests and semantic checks, facets, gates, scope violations, and rewards, excluding run IDs, timing, and diagnostic paths. Check IDs and reward keys are compared in canonical order, so reordering verifier JSON fields does not change the semantic signature. Preserve all thirteen canonical negative cases. A missing runtime proof blocks success even when static inspection passes.

Prepare and pin agent, collector, and verifier image IDs before doctor. Keep hidden tests, reference solutions, credentials, and trusted verifier material out of every agent image layer; declare task-specific forbidden absolute paths in addition to doctor's mandatory absences. Match exact pnpm dependency versions to the lockfile and installed image. The supported package uses a separate networkless verifier and the existing two-file trusted collector interface. See [operations](operations.md#task-integrity-doctor) for output integrity, purpose eligibility, and platform limits.

Build reproducibility and execution identity are separate. Retain and reuse the actual checked image by digest; a fresh build does not have to reproduce an earlier Docker image ID. New artifacts need their own validated bindings and affected calibration evidence before use. Never relabel a changed image with an old digest or replace a frozen plan's input. Source snapshot digest reproducibility and deterministic grading still apply to the same declared bytes.

Issue 14 implements real source import from one exact local SHA-1 commit. Start from a small JSON definition; do not put a clone URL, local path, credential, prompt, hidden check, or source byte in it. Retained identifiers are bounded, `task_revision` is an identifier token rather than prose, and the reachability reason rejects URLs, absolute paths, credential patterns, and control characters:

```json
{
  "document_type": "task_import_definition",
  "schema_version": 1,
  "task_id": "example-task",
  "task_revision": "v1",
  "repository_path": "/absolute/local/repository",
  "base_commit": "0123456789abcdef0123456789abcdef01234567",
  "provenance": {
    "repository_id": "owner-source-1",
    "merged_pull_request": { "status": "not_applicable" }
  },
  "online_reachability": {
    "status": "eligible",
    "reason": "The owner checked that grading material and future solutions are not reachable online."
  },
  "retention": { "classification": "public" }
}
```

For private source, use `{"classification":"private","expires_at":{"status":"default"}}` for exactly 90 days from import, or set a future known timestamp. The importer stores only a safe repository ID and commit identity as provenance. It rejects `unknown` reachability, unsafe Git entries, paths that the source reader would omit, credential patterns, oversized metadata, more than 10,000 files, a file over 64 MiB, or a source over 256 MiB before finalization.

Use the validated manifest to fill the existing `TaskDocument`: `task_id`, `task_revision`, `materialized_base_commit` as `base_commit`, `source_digest`, `online_reachability`, and `retention`. The verified import `source/` is the `task_source` passed to authoring, doctor, and run commands. Build and pin task-specific images through the existing authoring flow. Write the prompt, hidden checks, verifier, reference solution, rubric, and scope rules manually outside the imported agent-visible source; import does not infer them.

Private data remains in external owner-controlled storage. The implemented sanitized fixture path does not authorize owner private-data use: that still requires the pending technical canary review and source permission. Issue 15 derives its rubric format from the canonical task and the first real task's needs.

Issue 16 first finishes one real task and prepares a separately authorized three-arm, one-repeat exploratory comparison. Inspect that result before expanding to five tasks across at least three categories. Use this feedback to simplify authoring, then freeze the final suite. Keep exploratory runs out of final pilot statistics, disclose tuning, and replace any task tuned from observed arm outcomes before final comparative claims. Never tune a task using the winning arm of the sealed final experiment.
