# Product specification

## User and decision

The owner is an experienced frontend/software engineer using native Codex with a
ChatGPT subscription. The product supports decisions about their exact daily
stack: whether harness v2 improves v1, how effort changes affect outcomes, and
eventually how another complete agent stack compares. It is not a model leaderboard.

The experimental unit is the native agent product/version, requested and observed
model/provider identity, effort, auth/billing mode, complete harness, MCP/tools,
permissions/network policy, repository snapshot, prompt, budget, and execution
environment. Two runs differing in any of these are not silently interchangeable.

## Outcomes to measure

Report requested behavior, justified repository contracts, regressions, harmful
scope changes, reliability, duration, and observed usage independently. A short UI
request can imply analytics, localization, tests, accessibility, or logging only
where the pristine repository provides evidence. Extra work earns no automatic
credit. Quality failure must be distinguishable from inability to execute or grade.

The pilot succeeds when the owner can inspect a paired comparison of a skill
disabled, v1, and v2 on five frozen real tasks, with at least three repeats per arm,
and trace every finding back to retained patches, trajectories, and verifier evidence.
Success is a defensible decision, not a guaranteed winning harness.

## V1 product boundary

macOS on Apple Silicon with Docker Desktop Linux/arm64 containers is the v1
execution target. Intel Mac, WSL2, and arbitrary Docker hosts are not compatibility
claims. The control plane is TypeScript; Harbor runs pinned native Codex with
subscription auth and owns environment lifecycle. Python exists only for locked
Harbor/tooling.

V1 includes one synthetic frontend task before three to five real tasks (the pilot
backlog commits to five), immutable harness capture, Harbor-compatible task
packages, separate deterministic verification, complete manifests, raw retention,
terminal reports, interleaved repeated experiments, task integrity checks, and
verifier-only regrade. Default subscription concurrency is one.

V1 excludes bare models, dashboards, cloud/distributed execution, multiple
providers, generic plugins, LLM judges, public registries, full mutation frameworks,
multi-step tasks, code-review tasks, and ordinary metered CI. No automated credit
purchases or resets are part of the product. Pier is a conditional fallback;
Coder Eval is excluded.

## Feasibility before product work

The first implementation establishes toolchains and governance. The first
meaningful execution is a disposable spike: subscription Codex edits a fixed
synthetic snapshot under an explicit harness and unrestricted agent internet;
independent collection transfers a declared patch to a fresh offline verifier;
negative and positive controls and two repeated native-agent runs are retained.

The revised `public-1` spike permits two identical sequential subscription
invocations with unrestricted internet. It has no discovery phase, hostname
allowlist, or packet observer. The earlier restricted-network failure and owner
no-go are preserved as historical evidence, not compared with this revision. It uses Harbor 0.22.0, Codex 0.153.2,
`gpt-5.6-luna`, `medium` effort, concurrency one, and no automatic retry or fallback
model. A separate owner authorization is required before those invocations; the previous protocol's approval is not reset.

Actual issue 2 execution used medium then owner-requested low. Both passed, and the
owner accepted qualified go on 2026-09-05 for this temporary feasibility test.
A separately authorized additional low run then passed with identical recorded
stack settings and task inputs, completing the repeat criterion. See the
[evidence report](spikes/harbor-codex-subscription.md).
Issue 3 must review the remaining fidelity/auth risks.

No implementation of issues 4–13 proceeds without a green spike, owner acceptance,
and the evidence-based ADR review. Unknown authentication files,
credential-refresh behavior, collection trust, or trajectory loss are unresolved
requirements, not assumed capabilities. See [research](research-snapshot.md).

## Product acceptance gates

Issue 6 requires manual task calibration. Issue 13 requires a complete local dry
run and one explicitly authorized subscription canary before private task import.
Issue 16 freezes the pilot tasks before comparison. Issue 17 requires inspecting
per-task evidence before expansion. [The roadmap](roadmap.md) owns dependencies
and gate records; [methodology](methodology.md) owns comparison rules.
