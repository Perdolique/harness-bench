# Agent Stack Benchmark — bootstrap and implementation plan

**Plan date:** 2026-09-03  
**Primary use case:** evaluate complete coding-agent stacks on real repository-native tasks: Codex/other native agents + model/effort + the user's harness (AGENTS.md, skills, MCP, configuration, policies, tools) + repository context.

---

## 1. Decision

Do **not** ask one agent to design and implement the whole system in one run.

Use two levels:

1. **Planning/bootstrap run:** an agent in an empty GitHub repository creates the project specification, architecture decisions, threat model, issue graph, milestones, labels, and implementation issues. It must not implement the benchmark engine.
2. **Issue-by-issue implementation:** give the agent one GitHub issue per session/PR. The first meaningful implementation is a feasibility spike that proves the riskiest path end to end before abstractions, dashboards, and schemas are built.

The execution kernel for v1 is **Harbor**. The custom code is a thin TypeScript control plane named `benchctl`. Harbor owns container lifecycle, agent adapters, artifact collection, network policy, trajectory logs, and separate verifier execution. `benchctl` owns project-specific configuration, harness snapshots, experiment matrices, result normalization, statistics, and reports.

**Pier is a documented fallback**, not a second dependency in v1. Use it only if the feasibility spike demonstrates that Harbor cannot satisfy native Codex/subscription authentication, required trajectory fidelity, or controlled network behavior.

---

## 2. What the benchmark measures

The unit under test is an immutable **agent stack configuration**, not a bare model:

```text
agent product and exact version
+ model/provider identity
+ reasoning effort
+ authentication/billing mode
+ complete harness bundle
+ MCP/tool configuration
+ permissions and network policy
+ repository snapshot
+ task prompt
+ execution budget
+ runner/environment versions
```

Examples of valid comparisons:

```text
Codex + GPT-5.6 high + harness v12
vs
Codex + GPT-5.6 high + harness v13
```

```text
Codex + GPT-5.6 medium + harness v13
vs
Codex + GPT-5.6 high + harness v13
```

```text
Codex + GPT-5.6 high + harness v13
vs
Claude Code + Opus 5 + ported harness v13
```

The first comparison isolates a harness change. The latter two compare complete usable stacks. Never label a result as a score of a model alone.

---

## 3. V1 scope

### Included

- Local execution in Windows/WSL2 with Docker.
- Harbor pinned to an exact version.
- Native Codex CLI pinned to an exact version.
- ChatGPT subscription authentication, because this matches the primary daily workflow.
- Dedicated, external Codex credential directory; credentials are never committed or copied into benchmark artifacts.
- TypeScript CLI/control plane.
- Harbor-compatible tasks.
- A fresh, separate verifier container with network disabled.
- Deterministic verification.
- Immutable harness bundles and complete run manifests.
- A synthetic vertical-slice task followed by 3–5 real tasks.
- A/B harness comparisons, repeated runs, interleaved scheduling, and paired reports.
- Raw trajectory/artifact retention and a terminal report.

### Explicitly excluded from v1

- Bare/neutral model evaluation.
- Web dashboard.
- Cloud/distributed execution.
- Multiple providers or agents.
- Generic plugin architecture.
- LLM-as-judge grading.
- Full mutation-testing framework.
- Public benchmark registry.
- Automated purchasing or use of API credits.
- Multi-step conversational tasks.
- Code-review benchmark tasks; add them after patch-task methodology is stable.
- Building a custom container/sandbox runner.

---

## 4. Critical feasibility gate

Before building the product, prove this exact path:

```text
pinned Harbor
  -> native pinned Codex CLI
  -> ChatGPT subscription authentication
  -> ephemeral CODEX_HOME containing explicit tested harness
  -> isolated agent workspace
  -> controlled network access
  -> agent edits a fixed repository snapshot
  -> tamper-resistant collection of the resulting patch/artifact
  -> fresh separate verifier container
  -> verifier has no network and no credentials
  -> deterministic hidden checks
  -> raw trajectory, usage, logs, patch, manifest, and score are retained
```

The spike must answer with evidence:

1. Can a dedicated ChatGPT/Codex login be mounted or materialized safely into the agent container?
2. Which exact credential files are required?
3. Which hosts must be allowed for subscription-backed Codex execution?
4. Can all non-auth Codex state be replaced with an ephemeral `CODEX_HOME` so local history/configuration cannot contaminate runs?
5. Can Harbor collect the final repository change independently of the agent voluntarily exporting or committing it?
6. Can a separate verifier receive only the declared patch/artifacts?
7. Does the verifier run with no network and no credentials?
8. Are Codex tool calls, file changes, token usage, timing, termination reason, and stderr preserved sufficiently?
9. Can identical runs be repeated without modifying the source task or harness bundle?
10. What remains nondeterministic or provider-controlled?

Do not proceed to the main abstractions until this gate is green.

Fallback order if the exact path fails:

1. Keep Harbor, but run native Codex through a small custom Harbor agent adapter using supported `codex exec --json` behavior.
2. Keep separate Harbor verification, but run Codex on the host against an ephemeral Docker workspace.
3. Evaluate Pier as the execution kernel and record an ADR.
4. Build only the missing adapter. Do not build a custom sandbox/verifier platform.

---

## 5. Security and isolation model

### Credentials

Use a dedicated local directory outside the repository, for example:

```text
~/.agent-stack-bench/credentials/codex/
```

The login command and exact directory layout must be discovered and documented by the spike using current official Codex documentation.

Rules:

- Never commit credentials.
- Never include credentials in a harness bundle.
- Never persist them into a run directory.
- Never expose them to the verifier.
- Never print them in logs.
- Mount them read-only where possible.
- Create a fresh non-auth `CODEX_HOME` for every run.
- Copy or mount only the minimum required authentication material.
- Add automated secret scanning/redaction checks around retained artifacts.
- Treat trajectories and diffs as potentially sensitive source-code artifacts.
- Set `HARBOR_TELEMETRY=off` by default for local benchmark runs unless the owner explicitly enables telemetry.

### Agent environment

- Fixed repository base commit.
- Future git history unavailable.
- Pinned OCI image digests.
- No floating `latest` tags.
- Agent network is `allowlist`, not unrestricted, once the feasibility spike identifies required hosts.
- No hidden tests or reference solution in the agent filesystem.
- Explicit CPU/memory/time budgets.
- One run per fresh environment.

### Verifier environment

- Separate image/environment.
- Network disabled.
- No provider credentials.
- Receives only declared artifacts such as a binary patch and metadata.
- Starts from the same immutable repository snapshot.
- Applies the patch and runs deterministic checks.
- Hidden tests and rubric live only in the verifier image/context.
- Verification results are structured and retained.
- A verifier or scoring change can be regraded without rerunning the agent.

---

## 6. Scoring model

Retain a vector. Do not reduce everything to one leaderboard number.

```yaml
direct_behavior:
  score: 0.0..1.0
  hard_gate: true

repository_contracts:
  score: 0.0..1.0
  facets:
    analytics: 0.0..1.0
    tests: 0.0..1.0
    logging: 0.0..1.0
    accessibility: 0.0..1.0
    localization: 0.0..1.0

regression:
  score: 0.0..1.0
  hard_gate: true

scope_integrity:
  score: 0.0..1.0

maintainability:
  score: 0.0..1.0
  optional_in_v1: true
```

A composite score may be displayed for convenience, but raw facets are authoritative.

Suggested first composite:

```text
gate = direct_behavior_pass × regression_pass × verifier_integrity_pass

composite =
  gate × (
    0.45 × direct_behavior
    + 0.35 × repository_contracts
    + 0.20 × scope_integrity
  )
```

### Latent repository contracts

An implicit obligation may be graded only when the task records concrete evidence in the pristine repository snapshot:

```yaml
contracts:
  - id: analytics
    expectation: Emit the established checkout cancellation event.
    evidence:
      - apps/web/components/PrimaryCheckoutButton.vue
      - packages/analytics/events/checkout.ts
    verifier: tests/contracts/analytics.test.ts

  - id: localization
    expectation: User-facing text uses the existing localization mechanism.
    evidence:
      - apps/web/locales/en/checkout.json
      - apps/web/locales/et/checkout.json
    verifier: tests/contracts/localization.test.ts
```

Do not reward speculative “extra work.” Penalize unrelated edits, dependency churn, disabled checks, test deletion, and infrastructure changes outside the allowed envelope.

---

## 7. Reproducibility manifest

Every run must include at least:

```yaml
run_id:
created_at:
benchmark_repo_commit:
suite_id:
suite_revision:
task_id:
task_revision:
task_base_commit:
task_source_digest:
task_environment_image_digest:
verifier_revision:
verifier_image_digest:
scoring_revision:
runner:
  name: harbor
  version:
  config_digest:
agent:
  product: codex
  cli_version:
  model:
  effort:
  auth_mode: chatgpt_subscription
harness:
  id:
  digest:
network_policy_digest:
budget:
  wall_clock_seconds:
  token_or_turn_limits:
experiment:
  id:
  arm:
  block:
  replicate:
host:
  os:
  architecture:
  docker_version:
result:
  status:
  termination_reason:
  raw_artifact_path:
```

Record unknown/provider-hidden values as `unknown`; do not invent them.

---

## 8. Repository layout target

The planning agent may refine names, but should preserve these boundaries:

```text
/
├── AGENTS.md                         # instructions for developing this benchmark project
├── README.md
├── package.json
├── pnpm-workspace.yaml
├── pyproject.toml                    # only for pinned Harbor/Python tooling
├── uv.lock
├── apps/
│   └── benchctl/                     # TypeScript CLI
├── packages/
│   ├── schemas/                      # Valibot schemas and serialized JSON schemas
│   ├── core/                         # configuration resolution and orchestration
│   ├── results/                      # Harbor output normalization
│   ├── statistics/                   # paired comparisons/bootstrap
│   └── reporting/                    # terminal/static reports
├── benchmark/
│   ├── tasks/                        # Harbor-compatible tasks
│   ├── suites/
│   ├── stacks/
│   ├── experiments/
│   └── harnesses/                    # immutable harness bundles; never credentials
├── fixtures/
│   └── repositories/                 # synthetic repository fixtures only
├── docs/
│   ├── product-spec.md
│   ├── architecture.md
│   ├── methodology.md
│   ├── security.md
│   ├── task-authoring.md
│   ├── operations.md
│   ├── roadmap.md
│   └── adr/
├── scripts/
├── .planning/
│   └── issues/                       # issue drafts/fallback when GitHub CLI is unavailable
└── .github/
    ├── ISSUE_TEMPLATE/
    └── pull_request_template.md
```

Raw run outputs must live outside tracked source files by default, for example:

```text
.agent-stack-bench/runs/<run-id>/
```

The location must be configurable and ignored by git.

---

## 9. Milestones and implementation issues

Each issue is intended to fit one focused agent session and one PR. The planning agent must create these as real GitHub issues when `gh` is authenticated, and otherwise create complete issue drafts under `.planning/issues/`.

### Milestone M0 — Feasibility

#### Issue 1 — `chore: initialize repository, pinned toolchains, and project governance`

**Goal:** establish a deterministic development skeleton without implementing benchmark behavior.

**Acceptance criteria:**

- TypeScript monorepo with strict type checking.
- Package manager and runtime versions pinned; no floating versions.
- Python environment exists only for Harbor/tooling and is locked with `uv`.
- Formatting, linting, type checking, unit-test commands, and a single `check` command exist.
- CI performs static checks and unit tests only; it does not consume subscription quota.
- Root `AGENTS.md`, contribution rules, PR template, issue template, and ADR format exist.
- Generated files and run artifacts are ignored.
- `README.md` clearly states scope and non-goals.
- Harbor telemetry behavior is documented and local benchmark commands default to `HARBOR_TELEMETRY=off`.

**Non-goal:** no Harbor run, no benchmark schemas beyond placeholders.

---

#### Issue 2 — `spike: prove Harbor + native Codex subscription + separate verifier end to end`

**Depends on:** Issue 1.

**Goal:** prove the critical feasibility path with the smallest disposable fixture.

**Acceptance criteria:**

- Exact Harbor and Codex CLI versions are pinned and printed in the run record.
- Harbor telemetry is disabled for the spike and the effective setting is recorded.
- A documented one-time local login flow uses a dedicated credential directory outside the repository.
- A fresh ephemeral Codex home/config is assembled per run.
- A minimal task runs through Harbor using native Codex and ChatGPT subscription auth.
- Agent network access is measured and reduced to a documented allowlist, or the unresolved blocker is proven with logs.
- The agent modifies a fixed synthetic repository.
- The resulting change is collected without trusting the agent to report success.
- A fresh separate verifier applies the change.
- Verifier has no network, no credentials, no hidden-test exposure to the agent.
- The base snapshot fails the task-specific verifier.
- A known-good patch passes.
- At least two repeated agent runs are retained.
- Trajectory, stdout/stderr, patch/artifacts, timings, termination reason, and available usage data are saved.
- `docs/spikes/harbor-codex-subscription.md` records exact commands, observed required hosts, security caveats, failures, and a go/no-go conclusion.
- Experimental code is either promoted deliberately or isolated under `spikes/`; no premature framework abstraction.

**Stop condition:** if this issue is not green, do not start Issues 4–13. Create a narrowly scoped fallback issue and ADR instead.

---

#### Issue 3 — `docs: finalize architecture ADRs and threat model from feasibility evidence`

**Depends on:** Issue 2.

**Acceptance criteria:**

- ADR: Harbor as execution kernel.
- ADR: TypeScript control plane.
- ADR: separate verifier and artifact boundary.
- ADR: local ChatGPT subscription authentication.
- ADR: raw artifacts as immutable source of truth.
- Security document covers credentials, source-code leakage, network, hidden tests, malicious patches, logs, and local host exposure.
- Each decision references evidence from the spike rather than assumptions.
- Pier/custom adapter fallback criteria are explicit.

---

### Milestone M1 — Vertical-slice MVP

#### Issue 4 — `feat: define versioned stack, harness, suite, experiment, task, run, and score schemas`

**Depends on:** Issue 3.

**Acceptance criteria:**

- Runtime-validated Valibot schemas.
- Serialized schema artifacts for inspection.
- Schema versions are explicit.
- Unknown provider fields are representable without invented values.
- Invalid combinations fail with actionable errors.
- Unit tests cover valid/invalid examples and migrations are deferred explicitly.
- Example configurations exist but contain no credentials.

---

#### Issue 5 — `feat: capture, validate, hash, and materialize immutable harness bundles`

**Depends on:** Issues 3 and 4.

**Goal:** snapshot the exact user-controlled harness without capturing authentication, history, caches, or unrelated local state.

**Acceptance criteria:**

- Explicit allowlist of supported harness inputs: AGENTS.md, skills, Codex configuration, MCP/tool declarations, and policies.
- Capture command creates a content-addressed immutable bundle and manifest.
- Bundle digest is stable across equivalent captures.
- Secret-like files and known Codex auth/history/cache paths are rejected.
- Materialization creates an ephemeral agent home/workspace for one run.
- Tests prove credentials are excluded and changed skill/config content changes the digest.
- A human-readable diff command compares two harness bundles.

---

#### Issue 6 — `feat: add canonical frontend blast-radius task with separate deterministic verifier`

**Depends on:** Issue 3.

**Goal:** create one representative task around a small TypeScript/Vue fixture.

**Task shape:**

- User prompt requests a small UI behavior, such as adding a secondary action.
- Existing repository precedents imply analytics, localization, tests, and accessibility.
- Prompt does not enumerate those obligations.
- Hidden verifier checks direct behavior and repository contracts.
- Scope checks reject unrelated dependency/configuration churn.

**Acceptance criteria:**

- Pristine base fails task-specific checks for the intended reason.
- Reference implementation passes.
- At least one structurally different valid implementation can pass.
- Existing regression tests pass.
- Hidden tests are absent from the agent environment.
- Verifier works with network disabled.
- Contract expectations include concrete repository evidence.
- No source/diff similarity grading.

---

#### Issue 7 — `feat: implement benchctl run over pinned Harbor`

**Depends on:** Issues 4, 5, and 6.

**Acceptance criteria:**

- `benchctl run` resolves one stack, harness, suite/task, and budget.
- It invokes the pinned Harbor executable without duplicating Harbor lifecycle logic.
- It creates a unique run directory and immutable initial manifest.
- It handles success, agent failure, verifier failure, timeout, cancellation, and infrastructure failure distinctly.
- It never logs credentials.
- Default concurrency for subscription runs is one.
- Dry-run prints the resolved plan without starting an agent.
- Integration test uses a deterministic fake agent or reference solution and does not consume provider quota.

---

#### Issue 8 — `feat: normalize Harbor outputs while preserving immutable raw records`

**Depends on:** Issue 7.

**Acceptance criteria:**

- Raw Harbor job directory is copied or referenced immutably and never rewritten.
- Normalized run result contains score facets, status, timings, available usage, artifact paths, and trajectory references.
- Parser tolerates explicitly supported Harbor output versions and fails loudly on unknown incompatible versions.
- Hashes detect accidental mutation.
- Secret/redaction scan runs before a result is marked publishable.
- Unit tests use checked-in sanitized fixtures.

---

#### Issue 9 — `feat: render a terminal report for one run`

**Depends on:** Issue 8.

**Acceptance criteria:**

- Shows stack/harness/task identities and revisions.
- Shows direct behavior, repository contracts, regression, scope integrity, and composite.
- Distinguishes zero score from infrastructure failure.
- Shows time and available usage without inventing subscription monetary cost.
- Links/prints local paths to patch, trajectory, verifier logs, and manifest.
- Snapshot tests cover success, task failure, and infrastructure failure.

---

### Milestone M2 — Controlled experiments

#### Issue 10 — `feat: execute versioned experiment matrices with A/B arms, repeats, and blocked interleaving`

**Depends on:** Issue 9.

**Acceptance criteria:**

- Experiment definition contains tasks, arms, repeats, ordering seed, budgets, and stack/harness references.
- Old and new harness arms are run contemporaneously.
- Scheduling is blocked/interleaved by task and replicate, not all A then all B.
- Default subscription concurrency is one.
- Resume skips only completed immutable run IDs.
- A plan file records complete execution order before the first run.
- Partial experiments remain reportable.
- Dry-run displays the full matrix and estimated number of agent invocations.

---

#### Issue 11 — `feat: produce paired experiment comparisons and uncertainty estimates`

**Depends on:** Issue 10.

**Acceptance criteria:**

- Per-task paired deltas.
- Win/tie/loss counts.
- Pass rate and facet deltas.
- Paired bootstrap confidence intervals with recorded seed.
- Reliability metric such as all-pass-across-repeats.
- Duration and usage distributions.
- Infrastructure failures reported separately, never converted into task-quality zeroes by default.
- Report refuses invalid comparisons when task/scoring/environment revisions are incompatible.
- Unit tests use known synthetic datasets.

---

#### Issue 12 — `feat: add benchctl doctor for task, verifier, environment, and harness integrity`

**Depends on:** Issues 6–8.

**Acceptance criteria:**

- Checks required Harbor task structure and pinned images/dependencies.
- Confirms pristine base fails the task-specific direct checks.
- Confirms reference solution passes.
- Confirms verifier runs with no network.
- Confirms credentials are absent.
- Confirms hidden tests/reference solution are absent from agent-visible filesystem.
- Confirms deterministic verifier result across repeated runs.
- Detects deletion/disablement of tests and forbidden-file edits.
- Reports actionable failures and non-actionable warnings separately.

---

#### Issue 13 — `feat: support verifier-only regrade and scoring revision migration`

**Depends on:** Issues 8, 11, and 12.

**Acceptance criteria:**

- Regrade uses retained agent artifacts without another provider call.
- Original and new verifier/scoring revisions remain distinguishable.
- Raw original results are never overwritten.
- Comparison report prevents accidental mixing.
- Migration/regrade provenance is complete.
- Demonstration changes one scoring rule and regenerates a report without rerunning Codex.

**MVP gate:** after Issue 13, the platform is technically usable and methodologically defensible.

---

### Milestone M3 — Pilot benchmark on real work

#### Issue 14 — `feat: import and freeze a task from a real repository commit or merged PR`

**Depends on:** Issue 13.

**Acceptance criteria:**

- Accepts a local repository and explicit base commit.
- Removes future history from the agent-visible snapshot.
- Builds an immutable local task/environment artifact; no runtime clone from a moving branch.
- Detects obvious secrets before snapshotting.
- Records provenance without embedding private remote credentials.
- Provides a manual authoring workflow rather than pretending hidden tests can be generated perfectly.
- Supports keeping private task data outside the benchmark source repository.

---

#### Issue 15 — `feat: define blast-radius rubric and repository-contract evidence format`

**Depends on:** Issue 14.

**Acceptance criteria:**

- Contract expectations require evidence paths from the pristine snapshot.
- Supports direct behavior, analytics, logging, tests, accessibility, localization, regression, and scope.
- Each facet can be absent/not-applicable.
- Deterministic checks are preferred; static presence checks alone are discouraged.
- Authoring guide includes good/bad examples.
- Scope envelope supports allowed, conditional, and forbidden zones.
- Rubric validation catches contradictory or unsupported expectations.

---

#### Issue 16 — `content: author and calibrate the first five real benchmark tasks`

**Depends on:** Issues 14 and 15.

**Acceptance criteria:**

- Five tasks represent at least three task categories.
- Each has a short realistic prompt.
- Each has direct checks, regression checks, scope checks, and only evidence-backed implicit contracts.
- Pristine base fails; reference patch passes.
- At least one alternate implementation is tested for each task where practical.
- Tasks pass `benchctl doctor`.
- Task difficulty and known ambiguities are documented.
- No task is tuned using the sealed final experiment result.

---

#### Issue 17 — `experiment: compare skill disabled vs v1 vs v2 on the pilot suite`

**Depends on:** Issue 16.

**Acceptance criteria:**

- Three immutable harness bundles.
- Same pinned Codex/effort/auth mode, task revisions, environments, verifier, and budget.
- At least three repeats per arm initially.
- Blocked/interleaved schedule.
- Report includes paired facet deltas, reliability, duration, available usage, and scope violations.
- Findings document where each skill helps, does nothing, or harms.
- No universal conclusion beyond the tested stack/task distribution.
- Raw run set is archived.

**Pilot gate:** this is the first point at which the project answers the user's real question.

---

### Milestone M4 — Hardening and expansion

Create these issues but keep them out of the v1 critical path:

18. `feat: CI validation, redaction, and optional metered scheduled runs`
19. `feat: static HTML/web dashboard over normalized experiment data`
20. `feat: add a second native agent/provider as a complete stack`
21. `feat: add API-auth and billing-aware experiment mode`
22. `feat: add code-review benchmark task type and finding matcher`
23. `feat: add holdout/sealed-suite workflow`
24. `feat: add selective mutation probes for agent-authored tests`
25. `feat: evaluate remote sandbox/executor backends`
26. `research: evaluate Pier trajectory fidelity against current Harbor`

Each expansion issue must preserve the same separate-verifier and immutable-result invariants.

---

## 10. Global Definition of Done

Every implementation issue/PR must satisfy:

- Scope limited to the selected issue.
- No unrelated refactoring.
- No floating tool/image/model aliases where a stable identifier is available.
- Tests added or updated for behavior.
- Documentation updated where operational behavior changes.
- Commands and actual results included in the PR description.
- No subscription-backed test in ordinary CI.
- No credentials or private code committed.
- No verifier network access.
- Raw run artifacts are never rewritten.
- Failure classes remain distinct: task failure, agent failure, verifier failure, provider failure, runner failure, cancellation.
- Any new assumption is documented or converted into a follow-up issue.
- Do not start the next issue in the same PR/session.

---

## 11. Prompt for the planning/bootstrap agent

Copy the following prompt into a capable coding agent opened in the empty repository.

```text
You are the planning and architecture agent for a new project named
"Agent Stack Benchmark".

This run is PLANNING-ONLY. Do not implement the benchmark runner, CLI,
schemas, task fixture, Harbor integration, dashboard, or experiments.
Your job is to turn the context below into durable repository documentation
and a high-quality, dependency-ordered GitHub issue backlog that later coding
agents can implement one issue at a time.

Repository artifacts, code identifiers, documentation, ADRs, issue titles,
and issue bodies must be in English.

## Product context

The owner is a senior frontend/software engineer whose primary daily workflow
uses native Codex CLI with a ChatGPT subscription. They want to evaluate their
complete modern coding-agent stack on their own repository-native tasks.

The benchmark does NOT evaluate bare models. The unit under test is a full
stack configuration:

- native agent product and exact CLI version;
- model/provider identity and effort;
- authentication/billing mode;
- AGENTS.md;
- skills;
- MCP/tool configuration;
- permissions and network policy;
- repository snapshot;
- realistic task prompt;
- execution budget;
- runner/environment versions.

The benchmark must measure both directly requested behavior and justified
latent repository contracts. Example: a short request to add a button may
implicitly require established analytics, tests, localization, accessibility,
logging, or other conventions when the pristine repository contains clear
precedents. Such expectations must be backed by explicit evidence paths and
verified behaviorally where practical. The system must also detect harmful or
unrelated blast radius.

The main practical questions are:

1. Did harness v2 improve this exact daily Codex stack over harness v1?
2. Which model/effort or complete native-agent stack works best with the
   owner's harness on their tasks?
3. What quality, reliability, duration, token/usage, quota, and scope tradeoffs
   result?
4. Can old and new results be compared without silently mixing task, verifier,
   runner, environment, or scoring revisions?

## Architecture decision to plan around

Use Harbor as the v1 execution kernel and its Harbor-compatible task format.

Harbor owns:

- container/environment lifecycle;
- native Codex agent execution/adaptation;
- network policy;
- artifact collection;
- trajectory/log collection;
- fresh separate verifier execution;
- verifier-only regrade where supported.

Build a thin TypeScript control plane named `benchctl`.

benchctl owns:

- versioned stack/harness/suite/experiment configuration;
- immutable harness capture and materialization;
- orchestration over the pinned Harbor CLI;
- complete run manifests;
- raw-result preservation;
- result normalization;
- A/B/repeated/interleaved experiment scheduling;
- paired statistical comparison;
- terminal/static reporting;
- task integrity checks.

Python may be used only as the pinned Harbor/tooling ecosystem requires it.
Use `uv` and lock it. Do not reimplement Harbor in TypeScript.

Pier is a fallback only. Do not add both Harbor and Pier to v1. Do not add
Coder Eval to v1. Do not design a generic provider/plugin framework before
one native Codex path works.

## Critical feasibility risk

The first meaningful implementation must be a disposable vertical feasibility
spike proving:

pinned Harbor
-> pinned native Codex CLI
-> ChatGPT subscription authentication
-> dedicated credentials outside the repository
-> a fresh ephemeral CODEX_HOME with an explicit harness
-> isolated repository snapshot
-> controlled network access
-> tamper-resistant output/patch collection
-> fresh separate verifier
-> no verifier network or credentials
-> deterministic hidden checks
-> retained trajectory, logs, patch, timing, usage, manifest, and score.

The spike must discover and document the minimum authentication files and
required network hosts from current official behavior. Do not guess them.
If this path fails, stop the main implementation and open a focused fallback
issue/ADR. Preferred fallbacks are a small Harbor Codex adapter, then
host-managed Codex against an ephemeral Docker workspace, then evaluating Pier.
Never jump directly to a custom sandbox platform.

## V1 constraints

Include:
- local Windows/WSL2 + Docker;
- exact pinned Harbor and Codex versions;
- ChatGPT subscription authentication;
- TypeScript CLI/control plane;
- Harbor-compatible tasks;
- separate no-network deterministic verifier;
- immutable harness bundles and run manifests;
- one synthetic frontend vertical-slice task;
- 3-5 later real tasks;
- A/B harness comparisons, repeats, blocked interleaving;
- raw artifacts and terminal reports.

Exclude:
- bare/neutral model tests;
- web dashboard;
- cloud/distributed runner;
- second provider/agent;
- generic plugin architecture;
- LLM-as-judge grading;
- public benchmark registry;
- full mutation framework;
- multi-step tasks;
- code-review task type;
- ordinary CI runs that consume subscription quota.

## Required source verification

Before writing final architecture claims, inspect the CURRENT official
documentation/repositories for:

- harbor-framework/harbor:
  task format, separate verifier, artifacts, network policies, built-in/native
  Codex configuration, trajectory format, regrade, reward/report outputs,
  telemetry/opt-out, and current install/version pinning.
- openai/codex and official Codex documentation:
  ChatGPT login, CODEX_HOME/state layout, non-interactive `codex exec`, JSON
  event output, sandbox/config behavior, and version pinning.

Use only current primary/official sources for these claims. Record exact
versions or commit SHAs consulted in `docs/research-snapshot.md`. Do not use
floating `latest` references in the planned implementation.

## Required repository deliverables

Create and commit:

- README.md
- AGENTS.md
- docs/product-spec.md
- docs/architecture.md
- docs/methodology.md
- docs/security.md
- docs/task-authoring.md
- docs/operations.md
- docs/roadmap.md
- docs/research-snapshot.md
- docs/adr/README.md
- initial ADRs for:
  - Harbor as the v1 runner;
  - TypeScript control plane over Harbor;
  - separate verifier/artifact trust boundary;
  - local ChatGPT subscription authentication;
  - immutable raw artifacts as source of truth;
- .github/ISSUE_TEMPLATE/implementation.md
- .github/pull_request_template.md
- .planning/issues/*.md as a complete local copy of every issue body.

Do not add domain implementation. Minimal documentation tooling/configuration
is acceptable only when needed to validate links/Markdown.

## Required milestones

Create these GitHub milestones:

- M0 Feasibility
- M1 Vertical-slice MVP
- M2 Controlled experiments
- M3 Pilot benchmark
- M4 Hardening and expansion

## Required labels

At minimum:

- type:spike
- type:feature
- type:docs
- type:content
- type:research
- area:runner
- area:codex
- area:harness
- area:tasks
- area:verifier
- area:results
- area:statistics
- area:reporting
- area:security
- area:ci
- priority:critical
- blocked
- decision-required
- no-provider-call-in-ci

Use a small coherent color system and descriptions.

## Required issue graph

Create the dependency-ordered issues described in
"Agent Stack Benchmark — bootstrap and implementation plan", preserving their
goals, acceptance criteria, non-goals, dependencies, milestone placement, and
go/no-go gates:

1. repository/toolchain/governance skeleton;
2. Harbor + native Codex subscription + separate-verifier spike;
3. evidence-based ADRs and threat model;
4. versioned schemas;
5. immutable harness bundles;
6. canonical frontend blast-radius task;
7. benchctl run orchestration;
8. raw-result preservation and normalization;
9. one-run terminal report;
10. A/B matrix, repeats, blocked interleaving, resume;
11. paired comparison and uncertainty report;
12. benchctl doctor;
13. verifier-only regrade/scoring revision;
14. real-repository task import/freeze;
15. blast-radius rubric and evidence format;
16. first five real tasks;
17. first skill disabled/v1/v2 experiment;
18-26. hardening/expansion backlog.

Every issue body must contain:

- Context
- Goal
- In scope
- Out of scope
- Technical constraints
- Acceptance criteria as checkboxes
- Test/evidence plan
- Documentation changes
- Dependencies/blockers with links
- Risks/open questions
- Definition of Done

Keep issues sized for one focused coding-agent session and one PR. Split an
issue when it has multiple independently reviewable outcomes. Do not merge the
feasibility spike into production abstractions.

## GitHub operations

1. Inspect repository and GitHub remote state.
2. Create local planning documents and issue drafts first.
3. If `gh auth status` succeeds and an origin GitHub repository exists:
   - create labels and milestones;
   - create issues from the local drafts;
   - capture issue numbers/URLs;
   - make a second pass updating dependency references to actual issue links.
4. If GitHub CLI or remote access is unavailable:
   - do not treat that as project failure;
   - keep complete issue drafts under `.planning/issues/`;
   - create an idempotent script or documented command sequence that creates
     labels, milestones, and issues later;
   - clearly report what remains unapplied remotely.
5. Never delete or modify unrelated existing GitHub objects.

## Quality requirements

- Architecture documents and issues must agree.
- All task/verifier/security invariants must be explicit.
- Distinguish task-quality failure from agent/provider/runner/verifier failure.
- Preserve raw score facets, not only a composite.
- Never assign subscription runs a fabricated monetary per-task cost.
- Comparisons must be contemporaneous and paired when claiming a harness
  effect.
- Any task, verifier, scoring, environment, runner, or harness change must have
  its own revision/digest.
- No hidden tests, reference solution, credentials, or future git history may
  be visible to the agent.
- No verifier network access.
- Harbor telemetry is disabled by default unless an experiment explicitly opts in.
- No `latest` image/tool tags.
- No implementation issue may require ordinary CI to call Codex.
- Record unresolved uncertainty directly; do not paper over it.

## Final actions and stop condition

Run local documentation validation that does not require provider access.
Commit the planning artifacts with a clear conventional commit.

Then stop.

In the final response, provide:

- files created;
- milestones/labels/issues created remotely, with counts;
- issue dependency order;
- unresolved risks;
- exact recommended next issue;
- commands/checks run and their results.

Do not implement Issue 1 or any later issue in this planning run.
```

---

## 12. Prompt for each implementation issue

Use this template in a fresh agent session after selecting exactly one GitHub issue.

```text
Implement GitHub issue #<NUMBER> only.

Read, in this order:

1. the selected issue and every linked dependency;
2. AGENTS.md;
3. docs/product-spec.md;
4. docs/architecture.md;
5. docs/methodology.md;
6. docs/security.md;
7. relevant ADRs and task/operations documentation.

Before editing:

- verify that all blocking issues are closed/merged;
- inspect the current repository rather than assuming the issue text is
  perfectly current;
- post or write a concise implementation plan mapped directly to the issue's
  acceptance criteria;
- identify any acceptance criterion that cannot be proven in this environment.

Implementation rules:

- stay inside this issue's scope;
- do not start the next issue;
- do not perform unrelated refactors;
- preserve Harbor as the execution kernel;
- do not build a custom sandbox/runner;
- never expose credentials, hidden tests, reference solutions, or private
  source artifacts;
- do not make provider calls in ordinary tests/CI;
- do not use floating versions or image tags;
- update documentation/ADRs when behavior or a decision changes;
- classify task, agent, provider, runner, verifier, and infrastructure failures
  separately;
- add deterministic tests for new behavior;
- keep raw benchmark artifacts immutable.

Before finishing:

- run all checks relevant to the changed area;
- map evidence to every acceptance criterion;
- inspect the diff for scope creep and secret/private-data leakage;
- update the issue/PR with exact commands and actual results;
- record follow-up work as separate issues rather than silently adding it;
- commit with a clear conventional commit.

Stop after this issue is complete. Do not implement follow-up issues.
```

---

## 13. Human review gates

Do not automatically continue after these issues:

### After Issue 2

Review:

- subscription auth safety;
- whether native Codex inside Harbor really matches the daily workflow;
- network allowlist;
- quality of traces and usage telemetry;
- whether patch collection is outside agent control;
- whether the verifier trust boundary is real.

Decision: continue with Harbor, write a small adapter, test Pier, or stop.

### After Issue 6

Review the canonical task manually:

- Is the prompt realistic?
- Are implicit obligations genuinely inferable?
- Does evidence support every obligation?
- Can valid alternate implementations pass?
- Does scope grading punish only harmful blast radius?

### After Issue 13

Run a complete local dry run and one paid/subscription-backed canary. Confirm that the system is worth using before importing private real tasks.

### After Issue 16

Freeze task revisions before the first comparative experiment. Do not edit tasks in response to knowing which harness arm won.

### After Issue 17

Inspect per-task trajectories and patches, not only aggregate scores. Decide whether the benchmark is detecting useful engineering behavior or merely rewarding superficial conventions.

---

## 14. Recommended execution order

```text
Planning/bootstrap prompt
  ↓
Issue 1
  ↓
Issue 2  ← first hard human gate
  ↓
Issue 3
  ↓
Issues 4, 5, 6 (4 first; 5 and 6 can proceed independently after 3)
  ↓
Issue 7
  ↓
Issue 8
  ↓
Issue 9
  ↓
Issues 10 and 12
  ↓
Issue 11
  ↓
Issue 13  ← MVP technical gate
  ↓
Issue 14
  ↓
Issue 15
  ↓
Issue 16  ← freeze pilot suite
  ↓
Issue 17  ← first useful benchmark result
  ↓
M4 backlog only as justified by evidence
```

The owner should run one issue per agent session/PR. Parallel work is reasonable only where the dependency graph explicitly permits it, and not before the feasibility spike is accepted.
