# Session 049: hyphenated action inputs were read under their underscored spelling

Date: 2026-08-09

## Objective

`Ambiguous-Interactive/DoxReloaded` reported (its issue #428) that
`classify-unity-changes` is handed `event-name: pull_request` and answers
`Unity validation required: event is not a pull request`, so no pull request
diff has ever been classified. Diagnose it in this repository, where the
action lives, and eliminate the class rather than the instance.

## Root cause

The runner exposes an action input as `INPUT_<NAME>` with the name uppercased
and **spaces** replaced by `_`. Hyphens survive. `classify-unity-changes.js`
read `process.env.INPUT_EVENT_NAME`, `INPUT_BASE_SHA` and `INPUT_HEAD_SHA` —
three names the runner never sets — so `eventName` was always empty, which the
runtime classifies as "not a pull request" and requires Unity for.

`check-unity-runners.js` and `require-current-pr-head.js` already spell the
lookup correctly, so the convention was established and this runtime was the
lone deviant.

The defect survived a full unit-test file because every existing test calls
`run({eventName, ...})` with its arguments supplied directly. The one test that
did spawn the committed runtime set `INPUT_EVENT_NAME: "push"` and asserted
`unity-required=true` — an assertion that holds identically when the variable
is not read at all, so it entrenched the bug rather than catching it.

## Change

- `classify-unity-changes.js` reads its three inputs through the same
  `INPUT_${name.replace(/ /g, "_").toUpperCase()}` lookup the other runtimes
  use, and `main()` takes the environment as a parameter.
- `validate-unity-license.js` drops the dead `env.INPUT_ACTIVATION_MODE`
  fallback beside its correct `INPUT_ACTIVATION-MODE` read. Found by the guard
  below, not by inspection; no caller in either repository sets it.
- `test/action-manifests.test.js` gains a contract test: for every hyphenated
  input declared by any `action.yml`, no committed runtime under
  `.github/dist/` may reference the underscored spelling. It is red against the
  pre-fix runtime with the exact diagnostic, and it is what found the second
  instance.
- `test/unity-change-classifier.test.js` spawns the committed runtime through
  the env names the runner actually sets, over a real two-commit fixture
  repository, and asserts both directions: an all-independent diff classifies
  `unity-required=false`, a diff touching `Assets/` classifies `true`. The
  pre-existing non-pull-request test now uses `INPUT_EVENT-NAME` so it asserts
  the branch it names.

## Verification

`node --test test/*.test.js` — 691 tests, 672 passed, 2 skipped, 11 failed.
The same 11 fail on a clean checkout of `main` in this container
(`spawnSync go ENOENT`; Go is not installed here), where the baseline is
688/669/11. Default-branch CI is green, so the failures are environmental. The three new classifier tests and the new manifest contract
test pass; the manifest contract test is red against the pre-fix runtime.

## Consumer impact

`unity-required=false` has never been emitted by this action in production, so
the skip path it enables is exercised for the first time by this change. The
downstream contract already handles it: `require-unity-validation.js` accepts
`unityRequired === "false"` only when the licensed job, the fallback cleanup
job and its cleanup result are all skipped/empty ("audited non-Unity skip"),
and `DoxReloaded`'s `unity-lock-cleanup` job skips on
`needs.unity-tests.result != 'skipped'`. The allowlist is unchanged and remains
conservative: anything not explicitly independent still requires Unity.

## Enrollment analyzer follow-up

Adversarial review of the Qora consumer exposed a second central contradiction. Typed aggregate
recognition was introduced before credential preflight moved here. Its execution-environment guard
allowed central actions either no environment or only the two writer App bindings, so the later
`validate-unity-license` action's intentional four `UNITY_*` bindings made both Qora and IshoBoy appear
to lack their licensed and fallback aggregates.

The analyzer now recognizes only the exact central validator shape: the action name must be
`validate-unity-license`, and its step environment must contain exactly `UNITY_SERIAL`, `UNITY_EMAIL`,
`UNITY_PASSWORD`, and `UNITY_LICENSING_SERVER`, each bound to its same-named secret. Missing, extra,
aliased, or cross-bound values remain fail-closed, as does putting the credential environment on any
other central action or an enclosing composite caller.

Red-green evidence: adding the exact central validator to the accepted typed-aggregate fixture produced
`missing-unity-aggregate` and `missing-fallback-aggregate` before the analyzer change. The focused test
now passes along with five hostile environment mutations. The revised analyzer also reports zero findings
against Qora's exact current main commit `167c4322c7ffb39480edf625468eb893c49f6bec`, without a Qora
consumer workaround.

Continuous-improvement disposition: revise this existing dated session record. The durable mechanism is
the executable analyzer contract, not new agent guidance; the current task-development and workflow-policy
skills already require exact environment bindings and red-green proof.
