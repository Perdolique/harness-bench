# Order receipt canonical task evidence

## Owner decision requested

Review whether the short prompt is realistic, each latent requirement is fairly inferable from the pristine repository, both accepted implementation shapes are legitimate, and the scope rules do not reward resemblance to either solution. Issue 7 remains blocked until this issue 6 gate is recorded.

## Frozen task

Prompt:

> Add a “View receipt” action next to “View details” in the order history cards. It should open the existing receipt page for the selected order.

Latest complete local calibration on 2026-09-06:

| Identity | Value |
| --- | --- |
| Source digest | `sha256:154f809e842bd8b5980346429a60b370edf3719647a20b18037cc915ad6f458c` |
| Prompt digest | `sha256:c033e4b5443b824263b30be28ddb82a46a7c162de61997a299d73e56922419c9` |
| Deterministic base commit | `cc4cba29d7ca0ebab2beacdfa357b6ce4e6a4cc1` |
| Agent image | `sha256:b6757b544f6ec8f08a08ebd5518f6949f43c733246e56b010a9d23723e8e40bd` |
| Collector image | `sha256:ed21b12cc6cce01a88c836b395c17cfdd40ffd8793522df8a48cb2c67c05c1fe` |
| Verifier image | `sha256:681132765ecb98bd3c6e1353783697b224d72d0fc7918a7d6d7dae8267b5097a` |
| Playwright base image | `sha256:941cc91e5022880ac1d14ae90b476b624deb6399dbbc28d612d5d5bd7928fcbd` |

The generated document uses `TaskDocument` v1 with independent `order-receipt-task-v2`, `order-receipt-environment-v1`, `order-receipt-collector-v2`, `order-receipt-verifier-v2`, `order-receipt-scoring-v1`, and `order-receipt-rubric-v2` revisions. The public synthetic fixture is explicitly `online_reachability.status: ineligible`; it cannot support a claim that checks or future solutions were hidden from an internet-enabled agent.

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

The repeated reference artifact produced identical checks, four numeric rewards, and composite. Every untrusted test stage used a fresh candidate or trusted workspace and home, and the verifier cleanup control proved that a detached candidate child process could not survive into a later stage. Hidden tests and localization probes were root-owned and read-only before candidate code ran. Every verifier container exposed only loopback interfaces, received no credentials, and rejected unexpected conventional Harbor artifacts. The complete run used one concurrent job, one attempt, zero retries, zero model/provider calls, and Harbor telemetry off.

## Commands

```sh
vp run format
vp run check
vp run task:canonical:check
git diff --check
```

`vp run task:canonical:check` is a separate local Docker calibration. Ordinary CI runs `vp run check` only and remains provider-free.
