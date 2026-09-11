# experiment: compare skill disabled vs v1 vs v2 on the pilot suite

<!-- agent-stack-benchmark:planning-issue:17 -->

Planning item: 17 | Milestone: M3 Pilot benchmark

## Context

The final pilot compares one skill disabled, v1 and v2 on the frozen five-task distribution. Issue 16's earlier one-task comparison provides development feedback and does not count as pilot evidence.

Source: BOOTSTRAP_PLAN.md, section 9, planning item 17. The 2026-09-11 development revision in docs/roadmap.md separates exploratory feedback from this final comparison; the accepted ADRs retain the trust boundary.

## Goal

Run and inspect the first controlled three-arm skill experiment.

## In scope

- Capture three immutable harness bundles differing only in the declared skill treatment.
- Use the same native stack, task revisions, verifier, environments and budgets.
- Run at least three repeats per arm per task in a frozen blocked/interleaved schedule, then inspect reports and raw evidence.

## Out of scope

- Changing tasks after arm outcomes, universal conclusions, adding another agent, and unapproved quota expansion.

## Technical constraints

- Five tasks times three arms times three repeats is 45 planned initial invocations, separately authorized from development runs. There are zero automatic retries; any replacement block needs explicit authorization under the existing experiment policy.
- Review the frozen suite and the concrete 45-call plan together. Existing authorization applies within its approved inputs and budget.
- Exclude exploratory runs from pilot statistics. Disclose earlier task/harness tuning, and do not include a task tuned from observed arm outcomes in final comparative claims.
- Show invocation count and budgets before owner-authorized local execution; never run this experiment in ordinary CI.
- Provider failure/quota and unknown usage are reported honestly.
- Follow AGENTS.md and the accepted architecture; no custom sandbox/runner.
- Keep verifier execution separate, network-disabled and credential-free; never expose hidden tests, reference solutions or future history to the agent.
- Preserve immutable raw records and independent revisions; retain score facets and distinct task/agent/provider/runner/verifier/infrastructure/cancellation outcomes.
- No provider calls in ordinary CI; no credential/private-code commits; Harbor telemetry defaults off.

## Acceptance criteria

- [ ] Three immutable harness bundles.
- [ ] Same pinned Codex/effort/auth mode, task revisions, environments, verifier, and budget.
- [ ] At least three repeats per arm initially.
- [ ] Blocked/interleaved schedule.
- [ ] Report includes paired facet deltas, reliability, duration, available usage, and scope violations.
- [ ] Findings document where each skill helps, does nothing, or harms.
- [ ] No universal conclusion beyond the tested stack/task distribution.
- [ ] Raw run set is archived.
- [ ] Development attempts are excluded and all retained pilot tasks meet the declared tuning and online-reachability rules.
- [ ] Stop for owner inspection of per-task trajectories and patches before accepting the pilot conclusion or activating justified M4 work.

## Test/evidence plan

- Validate the dry-run plan, frozen identities and paired coverage before invoking the provider.
- Archive raw run IDs, hashes and derived reports; inspect per-task trajectories and patches.
- Describe where each skill helps, is neutral, or harms, with uncertainty and scope violations.

## Documentation changes

- docs/experiments/first-skill-pilot.md findings, limitations and sanitized evidence index; keep raw/private records external.

## Dependencies and owner gates

<!-- dependencies:start -->
- Prerequisites are enforced by GitHub's native issue dependencies; `.planning/backlog.json` is the local declaration.
- Required gate: owner-approved frozen suite after [planning issue 16](https://github.com/Perdolique/harness-bench/issues/16) and concrete pilot invocation budget; these decisions can be made together.
<!-- dependencies:end -->

## Risks/open questions

- Subscription quota may not support all planned attempts in one window; preserve contemporaneous blocks and report gaps.

## Definition of Done

- [ ] Every acceptance criterion has concrete evidence; exact commands and actual results are recorded in the PR.
- [ ] The global Definition of Done in CONTRIBUTING.md is satisfied, including meaningful negative controls, exact pins and updated operational docs.
- [ ] Work stays within the authorized outcome, including small required fixes; unrelated work is deferred.
- [ ] Material assumptions and relevant owner decisions are recorded under the current development policy in CONTRIBUTING.md and docs/roadmap.md.
- [ ] Credentials, private source, offline verification, and immutable raw evidence retain their existing protections.
