# Order receipt canonical task evidence

## Owner decision requested

The owner accepted the realism and fairness review in [PR #34](https://github.com/Perdolique/harness-bench/pull/34): the short prompt is realistic, each latent requirement is fairly inferable from the pristine repository, both implementation shapes are legitimate, and the scope rules do not reward resemblance to either solution. This records the issue 6 gate required by issue 7.

## Frozen task

Prompt:

> Add a “View receipt” action next to “View details” in the order history cards. It should open the existing receipt page for the selected order.

Latest complete local calibration on 2026-09-08 (Europe/Tallinn), through doctor v1:

| Identity | Value |
| --- | --- |
| Source digest | `sha256:154f809e842bd8b5980346429a60b370edf3719647a20b18037cc915ad6f458c` |
| Prompt digest | `sha256:c033e4b5443b824263b30be28ddb82a46a7c162de61997a299d73e56922419c9` |
| Deterministic base commit | `cc4cba29d7ca0ebab2beacdfa357b6ce4e6a4cc1` |
| Agent image | `sha256:26c413d688f335b4fac105c5353e7aca3e51f5b6f867496d9055df8a3ba8feb1` |
| Collector image | `sha256:bb78ff30e2aa5053479fc77d1038a2d0b74c330b3072efcb1181aa34cb1b7d7d` |
| Verifier image | `sha256:6b8fc8a5ac3d1632f830215f6f8c16545c1b3f7cb2300048feced5afedc0f455` |
| Playwright base image | `sha256:941cc91e5022880ac1d14ae90b476b624deb6399dbbc28d612d5d5bd7928fcbd` |

The generated document uses `TaskDocument` v1 with independent `order-receipt-task-v2`, `order-receipt-environment-v1`, `order-receipt-collector-v3`, `order-receipt-verifier-v3`, `order-receipt-scoring-v1`, and `order-receipt-rubric-v2` revisions. The public synthetic fixture is explicitly `online_reachability.status: ineligible`; it cannot support a claim that checks or future solutions were hidden from an internet-enabled agent.

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

## Commands

```sh
UV_CACHE_DIR=/tmp/harness-bench-issue-12-uv-cache vp run check
vp run task:canonical:check
vp run doctor:integration:check
git diff --check
```

`vp run task:canonical:check` is a separate local Docker calibration. Ordinary CI runs `vp run check` only and remains provider-free.

## Issue 12 retained evidence

The complete doctor record is `/tmp/harness-bench-issue-6-O9d98s/doctor/` on the tested host. Its `report.json`, `initial.json`, and `evidence-manifest.json` bind the raw input/tooling snapshots, host and image evidence, all Harbor jobs, control outcomes, and the exact Compose resource inventory in `raw/cleanup.json`. The evidence manifest digest is `sha256:26a016140c9d5563ad0f09d55d944d41a3ab1c654ffb9a958394b8c8a1e264dd`. The core tooling digest is `sha256:58abc5d0262ca0062de843152c45748c12205d65f09dda48bc495902b6c47c52`. All retained core, CLI, and reporting source bytes match the final checkout. The adjacent `canonical-score-checks.json` binds all four exact numeric assertions to retained score paths and digests. Preparation contains one shared base package and fifteen solution-only directories. No raw evidence is copied into this public repository.

The independent Docker integration summary is `/tmp/harness-bench-doctor-integration-Hna5aw/summary.json`. All seven scenarios met their assertions: healthy passed seven controls; network, sentinel credential, hidden file, collector exit 42, and missing artifact each blocked the result; a forbidden file deleted by a later image layer was rejected before any Harbor call. Each executed scenario confirmed cleanup. The provider canary observed zero requests, and the executable/config audit permitted only provider-free execution.

Verifier v3 supplies the facet bindings required by the existing production evidence validator and allows up to one second for SIGKILL delivery before rejecting surviving untrusted processes. Earlier failed or interrupted attempts remain separate. One intentionally interrupted attempt reported leftover Harbor verifier resources; targeted cleanup used its retained Compose configuration and did not rewrite the failed record. Passing normal cleanup does not establish infallible cleanup after cancellation.
