# Order receipt canonical task evidence

## Owner decision requested

The owner accepted the realism and fairness review in [PR #34](https://github.com/Perdolique/harness-bench/pull/34): the short prompt is realistic, each latent requirement is fairly inferable from the pristine repository, both implementation shapes are legitimate, and the scope rules do not reward resemblance to either solution. This records the issue 6 gate required by issue 7.

## Frozen task

Prompt:

> Add a “View receipt” action next to “View details” in the order history cards. It should open the existing receipt page for the selected order.

Current complete local calibration on 2026-09-12 (Europe/Tallinn), with `order-receipt-doctor-v2` on doctor report schema/revision v1:

| Identity | Value |
| --- | --- |
| Source digest | `sha256:7775d9f70c8b457ac31bdcb03be7cc1388bbe59074de10bc366075f7078f8924` |
| Prompt digest | `sha256:c033e4b5443b824263b30be28ddb82a46a7c162de61997a299d73e56922419c9` |
| Deterministic base commit | `c3b32d153c2059a6105d236074e7848db05f0e4b` |
| Task document | `sha256:37f894b98cbef59acdb86da37c8e515966e8259b832f363fea89fbe3c29bfc25` |
| Task package | `sha256:1ae17ca11ea263a31b5e7df1d2e834ca91282634b357cb2429fc037fdf7012d8` |
| Agent image | `sha256:3ff4bcf5d05333dc378026d56e7734c744b31a2a901f9b188db5e4d7156aac01` |
| Collector image | `sha256:69cd7b545395b8e44a31dc3e7d236bc65b838bfbcd377883a9175a01f2aa49e3` |
| Verifier image | `sha256:432e0a0415bbafa1cbce5090d150e8b20b6fd9c655168b299b4e6633ab4cca07` |
| Playwright base image | `sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27` |

The current generated document uses `TaskDocument` v1 with independent `order-receipt-task-v4`, `order-receipt-environment-v3`, `order-receipt-collector-v4`, `order-receipt-verifier-v5`, `order-receipt-scoring-v2`, and `order-receipt-rubric-v3` revisions. Environment v3 uses the Playwright 1.63.0 Noble image and pnpm 12.4.1. The fixture uses TypeScript 6.0.3 because the current `vue-tsc` 3.3.11 loader is incompatible with TypeScript 7; the benchmark control plane uses TypeScript 7.0.2 independently. Harbor 0.23.0 passed the complete provider-free calibration.

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

The current stack calibration is retained locally at `/tmp/harness-bench-issue-14-olv0Zm/doctor/`. Its evidence-manifest digest is `sha256:2389fb66d827ebf2ae1f8d1335a1c75241b906cc3b79e1ca8d857449ce2fe0bc`; the core tooling digest is `sha256:ecda9437be0cf5b3553754dcaeb583983015091ddf8badf4593836ae9a719e70`; and the adjacent `canonical-score-checks.json` digest is `sha256:280968de30a8271a12c5bd59ac3f6015ddb590f699f2caccd2e8d3baa54b1687`.

## Commands

```sh
UV_CACHE_DIR=/tmp/harness-bench-issue-12-uv-cache vp run check
vp run task:canonical:check
vp run doctor:integration:check
git diff --check
```

`vp run task:canonical:check` is a separate local Docker calibration. Ordinary CI runs `vp run check` only and remains provider-free.
