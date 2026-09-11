# Order receipt canonical task evidence

## Owner decision requested

The owner accepted the realism and fairness review in [PR #34](https://github.com/Perdolique/harness-bench/pull/34): the short prompt is realistic, each latent requirement is fairly inferable from the pristine repository, both implementation shapes are legitimate, and the scope rules do not reward resemblance to either solution. This records the issue 6 gate required by issue 7.

## Frozen task

Prompt:

> Add a “View receipt” action next to “View details” in the order history cards. It should open the existing receipt page for the selected order.

Latest complete local calibration on 2026-09-11 (Europe/Tallinn), with `order-receipt-doctor-v2` on doctor report schema/revision v1:

| Identity | Value |
| --- | --- |
| Source digest | `sha256:177fde56566127fe7f1bf4551b7a6fec3821da53eaf254777954154cecd9ac86` |
| Prompt digest | `sha256:c033e4b5443b824263b30be28ddb82a46a7c162de61997a299d73e56922419c9` |
| Deterministic base commit | `5b560875fc44347d19762c1205ce908384ab39b0` |
| Agent image | `sha256:aba01c7363ac0643f5e3652aceb801cd6da6110520efa2767dee97b2e7717ca4` |
| Collector image | `sha256:513cbccf96af18f3adcdfd2e0d9c98cf22c69b4fd58aa85c0d21e143a442685b` |
| Verifier image | `sha256:3c96991781c51898434f936d3f21262b3803c9264738f90a2168c871c6bed8b4` |
| Playwright base image | `sha256:941cc91e5022880ac1d14ae90b476b624deb6399dbbc28d612d5d5bd7928fcbd` |

The generated document uses `TaskDocument` v1 with independent `order-receipt-task-v3`, `order-receipt-environment-v2`, `order-receipt-collector-v3`, `order-receipt-verifier-v4`, `order-receipt-scoring-v2`, and `order-receipt-rubric-v3` revisions. Verifier v4 emits strict rubric checks with explicit credit, scoring v2 binds weighted credit, and rubric v3 uses the same `direct-receipt` obligation ID from declaration through evidence. Environment v2 pins Ubuntu Noble `ripgrep=14.1.0-1`, preserving the Playwright image's existing Node/npm installation while satisfying Harbor 0.22.0's complete Codex system-command prerequisite check. Canonical preparation proves `curl`, `bash`, `node`, `npm`, and `rg` are all present from a network-disabled container before Harbor starts. Codex remains installed by Harbor so agent CLI and task-environment identities stay independent. The public synthetic fixture is explicitly `online_reachability.status: ineligible`; it cannot support a claim that checks or future solutions were hidden from an internet-enabled agent.

## Evidence-backed requirements

The six repository contracts each have weight `1/6`. Maintainability is `not_applicable`.

| Contract | Pristine evidence | Observable check |
| --- | --- | --- |
| Availability | `OrderCard.vue` and its unit test gate the existing action on available status plus access key | Only the two eligible cards expose View receipt |
| Selected context | `orders.ts` and its test clear old data and reject a slower stale response | Rapid slow-then-fast activation ends on the fast order with no old order shown |
| Analytics privacy | The history page, analytics service, and details E2E establish one event with a public path | Activation emits exactly one `view_receipt` event with `/receipt` and no access key |
| Localization | `i18n.ts` declares English fallback for the German active locale, and the adjacent View details action already exercises it | The new English key renders through fallback, then follows a runtime mutation of that locale value |
| Keyboard access | The existing card action is a semantic control | The new button or link receives focus and activates with Enter |
| Candidate tests | Existing adjacent unit and browser tests establish both layers | New unit and browser tests pass on the implementation and fail against the pristine production code |

Direct behavior separately checks the existing `/receipt` route for the activated order. Trusted pristine regressions are copied from the immutable base and must remain byte-identical. UI components, the history page, justified composables, the English locale, and new tests are accepted; dependency, build, and existing-regression changes are reported as scope violations.

## Calibration results

| Case | Direct behavior | Repository contracts | Regression | Scope integrity |
| --- | ---: | ---: | ---: | ---: |
| Pristine `nop` | 0 | 0 | 1 | 1 |
| Reference: card events and page handler | 1 | 1 | 1 | 1 |
| Alternate: native link action, navigation composable, and reversed query-property order | 1 | 1 | 1 | 1 |
| Identical reference replay | 1 | 1 | 1 | 1 |

All thirteen controls completed their oracle script and failed the intended check:

| Negative control | Required failed check |
| --- | --- |
| Wrong order | Selected context |
| Missing navigation key | Direct behavior |
| Action on an ineligible order | Availability |
| Stale selection wins | Selected context |
| Missing analytics event | Analytics |
| Duplicate analytics event | Analytics |
| Access key in analytics path | Analytics |
| Hardcoded copy | Localization |
| Keyboard-inaccessible action | Keyboard |
| Candidate tests deleted | Candidate tests |
| Trivial candidate unit test | Candidate tests |
| Pristine regression disabled | Scope integrity and regression |
| Dependency churn | Scope integrity |

Doctor completed all 17 controls with exit `0` and `allowed_use: smoke`. The repeated reference produced identical patch/metadata hashes and semantic checks, facets, gates, scope violations, four numeric rewards, and composite. Canonical score assertions independently required the exact numeric matrix above, with composite `0` for pristine and `1` for all three positive runs. The nop-only probe confirmed the pristine source, one-commit Git, installed dependency pins, and declared hidden-material/credential absences; every agent image layer passed the declared forbidden-path inspection. Input/tooling stability and complete evidence inventory passed. Cleanup inspected containers, volumes, and networks for all 34 exact main/verifier Compose projects and found no remaining resources. Every untrusted test stage used a fresh candidate or trusted workspace and home, and the verifier cleanup control proved that a detached candidate child process could not survive into a later stage. Hidden tests and localization probes were root-owned and read-only before candidate code ran. Every verifier container exposed only loopback interfaces, received no credentials, and rejected unexpected conventional Harbor artifacts. The complete run used one concurrent job, one attempt, zero retries, zero model/provider calls, and Harbor telemetry off.

The issue 15 calibration is retained locally at `/tmp/harness-bench-issue-14-WHRCoN/doctor/`. Its evidence-manifest digest is `sha256:da7f69c45f0d6deb0e417bedd624384858b2e7f40f527a534a8b2d88a16f693c`; the core tooling digest is `sha256:478932a3c0494ecc56c9a0eed2b2869cab8d5e2305cc4a9498cde4b002cc9d90`; and the adjacent `canonical-score-checks.json` digest is `sha256:55d4c6ec37fb2e5fd472f2fc971d1d8bd42f8db3dc5c6a5a42cc8d303b8325c2`.

## Commands

```sh
UV_CACHE_DIR=/tmp/harness-bench-issue-12-uv-cache vp run check
vp run task:canonical:check
vp run doctor:integration:check
git diff --check
```

`vp run task:canonical:check` is a separate local Docker calibration. Ordinary CI runs `vp run check` only and remains provider-free.

## Issue 12 retained evidence

The complete doctor record is `/tmp/harness-bench-issue-6-pEb0KL/doctor/` on the tested host. Its `report.json`, `initial.json`, and `evidence-manifest.json` bind the raw input/tooling snapshots, host and image evidence, all Harbor jobs, control outcomes, and the exact Compose resource inventory in `raw/cleanup.json`. The evidence manifest digest is `sha256:d75635c93d757682374cd225a3ddbf8a5398b96e6c3b1d26e62a2d0475c517d1`. The core tooling digest is `sha256:f4b8f851c3bc853cfe5489a0ca3c2b42560681f7de9953d62552c389efe44b05`. All retained core, CLI, and reporting source bytes match the final checkout. The adjacent `canonical-score-checks.json` has digest `sha256:67d95e79b991336220aa7d048db080638cb49fa49de4b0710c4941831f9c1d69` and binds all four exact numeric assertions to retained score paths and digests. Preparation contains one shared base package and fifteen solution-only directories. No raw evidence is copied into this public repository.

The independent Docker integration summary is `/tmp/harness-bench-doctor-integration-rRgPgk/summary.json`. All seven scenarios met their assertions: healthy passed seven controls; network, sentinel credential, hidden file, collector exit 42, and missing artifact each blocked the result; a forbidden file deleted by a later image layer was rejected before any Harbor call. Each executed scenario confirmed cleanup. The provider canary observed zero requests, and the executable/config audit permitted only provider-free execution.

Verifier v4 supplies strict obligation-keyed facet, outcome, credit, and detail evidence and allows up to one second for SIGKILL delivery before rejecting surviving untrusted processes. Earlier v3, failed, or interrupted attempts remain separate. One intentionally interrupted attempt reported leftover Harbor verifier resources; targeted cleanup used its retained Compose configuration and did not rewrite the failed record. Passing normal cleanup does not establish infallible cleanup after cancellation.
