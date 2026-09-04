# Agent Stack Benchmark

Evaluate complete coding-agent stacks on repository-native engineering tasks. A
stack includes the native agent and version, model and effort, authentication
mode, harness, tools, permissions, repository snapshot, prompt, budget, and runner.
A result is evidence about that stack on those tasks, never a bare-model score.

**Status: the M0 feasibility decisions are accepted.** The repository has pinned
development toolchains, provider-free CI, an isolated disposable spike, and five
accepted ADRs. The retired restricted-network protocol remains a preserved no-go.
Three public-network native runs passed: one medium and two matching-input low
runs. Issue 3 accepts Harbor with explicit Git-workspace, auth-refresh,
merged-stream, public-network, and platform limitations. No production benchmark
CLI or runtime schemas exist.

The first useful question is whether a changed harness improves the owner's
subscription-backed native Codex workflow without increasing regressions or
unrelated edits. Quality facets, reliability, duration, and available usage remain
visible separately; subscription runs have no invented monetary per-task cost.

## Planned v1

- Local macOS on Apple Silicon with Docker Desktop Linux/arm64 containers.
- Pinned Harbor execution kernel; a thin TypeScript control plane, `benchctl`.
- Pinned native Codex using a dedicated, external ChatGPT login.
- Immutable harnesses and one-base-commit task snapshots, unrestricted agent
  internet, and fresh, credential-free, network-disabled deterministic verifiers.
- One synthetic frontend task, then five real tasks, repeated interleaved
  comparisons, raw evidence retention, and terminal reports.

Harbor 0.22.0, Codex 0.153.2, and `gpt-5.6-luna` passed the synthetic spike at
`medium` and owner-requested `low` effort.
[Issue 2](.planning/issues/02-feasibility-spike.md) records the qualified owner go;
[issue 3](.planning/issues/03-evidence-based-decisions.md) and the
[accepted ADRs](docs/adr/README.md) record what that evidence does and does not
support.

## Non-goals

V1 excludes neutral model evaluation, dashboards, distributed execution, a second
agent/provider, generic plugins, LLM grading, public registries, full mutation
testing, multi-step tasks, and code-review tasks. Ordinary CI never calls a
provider. There is no custom sandbox platform, Pier dependency, or Coder Eval
dependency. Expansion work stays outside the v1 critical path.

## Project guide

- [Development rules](AGENTS.md) and [contribution workflow](CONTRIBUTING.md).
- [Product specification](docs/product-spec.md) and [architecture](docs/architecture.md).
- [Methodology](docs/methodology.md), [security](docs/security.md), and
  [task authoring](docs/task-authoring.md).
- [Operations](docs/operations.md), [roadmap](docs/roadmap.md), and
  [architecture decisions](docs/adr/README.md).
- [Official-source research](docs/research-snapshot.md) and
  [backlog publication and validation](.planning/README.md).
- [Original bootstrap plan](BOOTSTRAP_PLAN.md).

Install the exact prerequisites and run the locked checks documented in
[Operations](docs/operations.md). `pnpm check` formats nothing, starts no Harbor
job, does not authenticate Codex, and consumes no provider quota. Future benchmark
commands must set `HARBOR_TELEMETRY=off` unless the owner explicitly opts an
experiment in.

Issue 2 adds two isolated commands. `pnpm spike:issue-2:check` runs provider-free
controls. `pnpm spike:issue-2 -- --phase public --run-id <id>` runs
exactly one owner-authorized subscription invocation from an explicit external auth
file and run root. See [Operations](docs/operations.md) before using either command.
