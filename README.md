# Agent Stack Benchmark

Evaluate complete coding-agent stacks on repository-native engineering tasks. A stack includes the native agent and version, model and effort, authentication mode, harness, tools, permissions, repository snapshot, prompt, budget, and runner. A result is evidence about that stack on those tasks, never a bare-model score.

**Status: the benchmark control plane is implemented through issue 12's task integrity doctor.** The repository has pinned development toolchains, provider-free CI, seven frozen v1 schemas, immutable harness tooling, the calibrated canonical frontend task, one-run Harbor orchestration, immutable result normalization and disposition, interleaved experiment scheduling and recovery, operational reports, read-only paired analysis with deterministic task-cluster uncertainty, and provider-free task calibration through Harbor. The retired restricted-network protocol remains a preserved no-go. Three public-network native feasibility runs passed: one medium and two matching-input low runs.

Those runs prove only the recorded synthetic path. Token refresh was not exercised and an auth failure requires owner login. Harbor irreversibly merged native stdout and stderr. The agent had unrestricted network access, including possible access to remote content, host services, and its temporary credentials. The result applies only to the recorded macOS Apple Silicon and Docker Desktop Linux/arm64 environment.

The first useful question is whether a changed harness improves the owner's subscription-backed native Codex workflow without increasing regressions or unrelated edits. Quality facets, reliability, duration, and available usage remain visible separately; subscription runs have no invented monetary per-task cost.

## Planned v1

- Local macOS on Apple Silicon with Docker Desktop Linux/arm64 containers.
- Pinned Harbor execution kernel; a thin TypeScript control plane, `benchctl`.
- Pinned native Codex using a dedicated, external ChatGPT login.
- Immutable harnesses and one-base-commit task snapshots, unrestricted agent internet, and fresh, credential-free, network-disabled deterministic verifiers.
- A trusted collector independent of agent-controlled Git, with fail-closed proof of quiescence, complete collection, an exact manifest, and verified hashes before any grade is valid.
- One synthetic frontend task, then five real tasks, repeated interleaved comparisons, raw evidence retention, and terminal reports.

Harbor 0.22.0, Codex 0.153.2, and `gpt-5.6-luna` passed the synthetic spike at `medium` and owner-requested `low` effort. [Issue 2](.planning/issues/02-feasibility-spike.md) records the qualified owner go; [issue 3](.planning/issues/03-evidence-based-decisions.md) and the [accepted ADRs](docs/adr/README.md) record what that evidence does and does not support.

## Non-goals

V1 excludes neutral model evaluation, dashboards, distributed execution, a second agent/provider, generic plugins, LLM grading, public registries, full mutation testing, multi-step tasks, and code-review tasks. Ordinary CI never calls a provider. There is no custom sandbox platform, Pier dependency, or Coder Eval dependency. Expansion work stays outside the v1 critical path.

## Project guide

Inspect a retained normalized run with `vp run benchctl -- results report /absolute/path/to/normalized/<sha256>/record.json`. Inspect experiment state with `vp run benchctl -- experiment report /absolute/path/to/plan.json`, or derive the revision-1 paired analysis with `vp run benchctl -- experiment compare /absolute/path/to/plan.json`. Reports show identities, quality, reliability, timing, usage, coverage, and checked evidence without mutating source records or invoking a provider. See [report usage and exit codes](docs/operations.md#single-run-terminal-report) and [experiment matrices](docs/operations.md#experiment-matrices).

- [Development rules](AGENTS.md) and [contribution workflow](CONTRIBUTING.md).
- [Product specification](docs/product-spec.md) and [architecture](docs/architecture.md).
- [Methodology](docs/methodology.md), [security](docs/security.md), and [task authoring](docs/task-authoring.md).
- [Operations](docs/operations.md), [roadmap](docs/roadmap.md), and [architecture decisions](docs/adr/README.md).
- [Official-source research](docs/research-snapshot.md) and [backlog publication and validation](.planning/README.md).
- [Published backlog source provenance](BOOTSTRAP_PLAN.md).

Install the exact prerequisites and run the locked checks documented in [Operations](docs/operations.md). `vp run check` formats nothing, starts no Harbor job, does not authenticate Codex, and consumes no provider quota. Future benchmark commands must set `HARBOR_TELEMETRY=off` unless the owner explicitly opts an experiment in.

Issue 2 leaves a provider-free control at `vp run spike:issue-2:check` and preserved historical provider commands. **Do not run the provider-backed spike command:** all four authorized issue 2 invocations are consumed, and a fresh run root does not create a new authorization. The retained command exists only to document how the evidence was produced; it is not an instruction to rerun it. See [Operations](docs/operations.md) before using the provider-free check.
