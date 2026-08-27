# Session 061: Unity adoption incident, singleton regression, and return reason

Date: 2026-08-27

## Objective and invariants

Inventory and prioritize the live issue set, complete the highest-impact safely
related work, and leave both the central lock and Unity Helpers green without
weakening fail-closed cleanup, mutating licensed-runner state unnecessarily, or
masking infrastructure failures as product failures. The work also targeted at
least five actionable Unity Helpers issues while keeping the licensed Unity
matrix to one final hosted run.

## Baseline and priority

The session refreshed the complete central inventory from session 060 and the
open Unity Helpers issue set. The highest-impact cluster was:

1. Unity Helpers #582: entering Play Mode destroyed scene-authored singleton
   objects.
2. Central #214: ordinary nonzero Unity return commands collapsed into the
   generic `return-missing-positive-evidence` reason.
3. Unity Helpers #498/#584 and central #212: adoption of the newest central
   action was blocked by licensed-runner cleanup instability.
4. Unity Helpers correctness/performance items #504 and #577, plus the already
   completed local-gate runtime issues #505 and #543 in the same upstream
   sweep.

The remaining central inventory retains the prior dispositions: #188 requires
an organization secret and client-ID value; #113, #49, and #99 require
consumer-repository changes; #60 remains blocked by #83; #53 is architectural;
#153 requires platform implementations and paid canaries; #44 and #51 require
organization authority; #27, #29, and #30 require live operational windows;
and #94 remains blocked on actionlint support for yaml/v4. No safe shortcut was
identified for any of them.

## Two independent root causes

### Unity Helpers Play Mode regression

`RuntimeSingletonRegistry` used a `BeforeSceneLoad` callback to call the public,
destructive `ClearInstance` path for every registered singleton type. In the
Editor, scene-authored objects already exist when that callback runs. The clear
path swept those live components and destroyed their GameObjects, after which
`Instance` could fabricate a default object. The defect was independent of the
organization build lock.

Unity Helpers PR #581 separates startup cache invalidation from explicit test
or teardown destruction. The startup hook now resets only the static cache and
diagnostics, while `ClearAllRegisteredInstances` retains its explicit
destructive contract. A Play Mode regression test proves that an authored
`NeverCreate` singleton retains both object identity and serialized state
across the startup reset.

### Licensed-runner cleanup incident

The downloaded 2021.3.45f1 standalone job evidence showed an expired cooldown
reservation followed by removal of the runner's lock ownership and a
health-quarantined global capacity. Later licensed legs inherited that poisoned
capacity. The affected leg also stopped before producing NUnit XML after a
Test Framework unexpected-log rejection. This is an infrastructure cascade,
not evidence of a Unity Helpers test or source regression.

A concurrent maintainer commit therefore restored every Unity Helpers
build-lock pin and digest producer to the v1.12.1 last-known-good state. The
initial stale push was safely rejected; the session preserved the concurrent
rollback and integrated only the singleton fix on top. Unity Helpers #498 was
reopened because latest-action adoption is not in the resulting tree, #584
tracks the cleanup incident, and central #212 remains open as the adoption
tracker. No lock pin was advanced and no cleanup failure was reclassified as
success.

## Central cleanup reason contract

Central PR #215 adds the bounded public reason `return-command-failed` when a
return command completed with a nonzero exit code but supplied neither exact
positive proof nor a more specific known signature. The classifier retains
the existing precedence for account blocks, incomplete capture, code 400006,
termination, timeout, code 20113, ULF skips, and exact positive proof.

The build-lock schema, terminal cleanup gate, tests, and operator runbook all
recognize the new reason. Its outcome remains `unknown`, the capacity is
quarantined, and the terminal gate remains red: the change preserves a useful
sanitized cause without weakening safety.

## Unity Helpers issue disposition

- #504: closed by pooled JSON-array allocation work in PR #581.
- #577: closed by the enum-comparer documentation correction in PR #581.
- #582: fixed by the singleton startup-reset change and set to close with PR
  #581.
- #505 and #543: closed after the local/pre-push gate improvements and
  measurements included in the same upstream workstream.
- #498 and #584: intentionally open; latest lock adoption and the quarantined
  runner incident are not resolved by this source change.
- #356, #399, #578, and #580: left open because their broader acceptance
  criteria were not proved by this session.

This provides five completed issue outcomes without claiming the rolled-back
adoption or broader performance investigations as complete.

## Validation and review

Central red/green TDD first produced exactly three expected failures for the
classifier, cleanup gate, and schema. Focused tests then passed 535 cases (533
passes and two Windows skips). The complete
`.devcontainer/scripts/verify.sh` gate passed twice after the final runbook
correction, including 824 Node tests (821 passes and three platform skips), Go
tests and race tests, module checks, static analyzers, ShellCheck, actionlint,
and the workflow credential audit. Hosted PR CI passed both Linux and Windows
jobs, with no review threads.

Unity Helpers passed C# type checking for all supported configurations, the
63/63 local validation suite with terminal color injection removed, preflight,
pre-push, documentation, formatting, generator, and repository-lint gates.
The full suite was repeated after integrating the maintainer's LKG rollback.
All review threads were resolved. Hosted Unity validation is the authoritative
licensed test because no Unity license is available locally.

The main-thread adversarial loop found and corrected stale singleton lifecycle
comments and an imprecise runbook label. A second pass found no remaining
issue. Main-thread review was used because no delegated reviewer was available
under the session's execution constraints.

## Dependency currency and durable learning

The root module remains current. An isolated-cache check confirmed actionlint
v1.7.12 as latest; yaml/v4 rc.6 remains intentionally unavailable to that
module because of #94, and the other reported entries are unused transitive
modules. No safe dependency update was omitted.

No new `.llm` instruction was promoted. Existing guidance already requires
bounded stable public values, fail-closed cleanup, exact evidence precedence,
and rollback-safe git integration. The durable contract belongs in the code,
tests, runbook, issue comments, and this record rather than a duplicate agent
rule.

## Delivery

- Central: [PR #215](https://github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/pull/215)
- Unity Helpers: [PR #581](https://github.com/Ambiguous-Interactive/unity-helpers/pull/581)

Final hosted Unity matrix, merge, issue-state, and post-merge `main` results are
recorded in the pull requests and workflow history; both repositories must be
green before this session is considered complete.
