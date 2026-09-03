# Agent Stack Benchmark

Evaluate complete coding-agent stacks on repository-native engineering tasks. A
stack includes the native agent and version, model and effort, authentication
mode, harness, tools, permissions, repository snapshot, prompt, budget, and runner.
A result is evidence about that stack on those tasks, never a bare-model score.

**Status: planning only.** No benchmark CLI, schemas, fixtures, integrations, or
experiments exist yet. Start with [planning issue 1](.planning/issues/01-repository-skeleton.md)
in a new implementation session. This bootstrap does not complete that issue.

The first useful question is whether a changed harness improves the owner's
subscription-backed native Codex workflow without increasing regressions or
unrelated edits. Quality facets, reliability, duration, and available usage remain
visible separately; subscription runs have no invented monetary per-task cost.

## Planned v1

- Local Windows/WSL2 with Docker Linux containers.
- Pinned Harbor execution kernel; a thin TypeScript control plane, `benchctl`.
- Pinned native Codex using a dedicated, external ChatGPT login.
- Immutable harnesses and task snapshots, controlled agent egress, and fresh,
  credential-free, network-disabled deterministic verifiers.
- One synthetic frontend task, then five real tasks, repeated interleaved
  comparisons, raw evidence retention, and terminal reports.

Harbor 0.22.0 and Codex 0.153.0 are the researched candidates, not an already
validated pair. [Issue 2](.planning/issues/02-feasibility-spike.md) and owner review
must establish feasibility before production abstractions begin.

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

Run `python3 .planning/validate.py` to check planning documents locally. This does
not install toolchains, start Harbor, authenticate Codex, or consume provider
quota. Future benchmark commands must set `HARBOR_TELEMETRY=off` unless the owner
explicitly opts an experiment in.
