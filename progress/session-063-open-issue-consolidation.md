# Session 063: open-issue consolidation and reaper-delivery RCA

Date: 2026-08-27

## Objective and safety invariants

Review the live issue surface, root-cause active failures, close or consolidate
at least five issues whose outcomes were completed, duplicated, superseded, or
no longer planned, and leave only concrete TODOs without provisioning another
App or weakening licensed-resource safety.

The session preserved FIFO admission, literal non-cancelling licensed
concurrency, exact cleanup evidence, quarantine on ambiguous cleanup, immutable
action references, credential confidentiality, and operator-visible evidence.

## Baseline and hypothesis

- Central `main` was clean at `363fa6567`, equal to `origin/main`.
- The central repository had 13 open issues and no open pull request.
- Unity Helpers had 22 open issues and no open pull request.
- Central protected-main Build lock CI run `33101113271` passed at exact merge
  commit `363fa65675516a089ab6fe13ab196b6eac7b9a39`.
- Central issue #126 was open with `scheduled-run-overdue` evidence.

The falsifiable hypothesis was that the open surface mixed canonical TODOs
with historical umbrellas, duplicate consumer trackers, and already-completed
research. The competing hypothesis for #126 was that its reopen was a monitor
threshold or reaper-runtime bug rather than missing scheduled delivery.

## Issue #126 root cause

The monitor transition is correct. At `2026-08-27T18:12:16Z`, the newest
scheduled reaper run (`33096409342`) was 69 minutes and 2 seconds old against
the committed 30-minute delivery SLO. The reaper job itself completed
successfully in seconds; audit run `33102280004` also passed after synchronizing
the open alert.

The latest 100 scheduled reaper runs contained 19 delivery gaps above 30
minutes, with a maximum gap of 229 minutes. Both workflows remained enabled.
The repository can therefore demonstrate the immediate cause—scheduled
delivery did not meet the SLO—but cannot distinguish delayed from dropped
GitHub cron events. Raising the threshold or manually closing the alert would
hide real operational evidence, so #126 remains open for automatic recovery on
a fresh scheduled delivery.

The investigation found one documentation bug: the runbook implied a manual
reaper dispatch or rerun could close the delivery alert, while the monitor
deliberately queries only `event=schedule`. A red documentation-policy test now
pins the correct distinction: manual operation may reap stale state but cannot
prove scheduled delivery recovered.

## Issue dispositions

Nine open issues were closed only after an evidence comment recorded the
canonical owner or completed measurements:

1. Central #49, not planned: downstream removal of the matrix eligibility cap
   reduced the measured fast-to-standalone transition from 10.1 minutes to one
   second; further job grouping measured only about 3.6% whole-run benefit and
   would weaken failure isolation and artifact topology.
2. Central #99, duplicate: #57 and #129 delivered the bounded central
   activation-handoff, cooldown, deadline, and polling work. Any remaining
   Unity CLI retry defect must be filed at its concrete consumer call site.
3. Central #212, duplicate: Unity Helpers #411 owns Windows central-action
   migration and central #153 owns container/Darwin trusted cleanup.
4. Unity Helpers #585, duplicate of #442's zero-touch editor/documentation
   capture outcome.
5. Unity Helpers #478, duplicate of #441's repository-wide concise,
   user-focused documentation and real-example sweep.
6. Unity Helpers #498, not planned: its local digest-only approach cannot
   satisfy the central run-scoped evidence path or off-Windows identity-bound
   deletion; #411 and central #153 preserve the actionable outcomes.
7. Unity Helpers #529, completed: six merged relational-performance PRs covered
   the measured hierarchy/query/allocation paths, and closed #564 owned the
   remaining unsatisfied diagnostic hotspot.
8. Central #188, duplicate of #51 after transferring the existing reader-App
   client-ID migration. No new App or token is required.
9. Central #30, duplicate after transferring its owner/security checklist to
   #51. Its remaining operational, ruleset, starvation, enrollment, entitlement,
   and platform work already has canonical issues.

## Remaining central TODO surface

The live central surface is eight issues, each with distinct acceptance work:

- #29: deliberate lifecycle canaries and seven-day operational evidence.
- #44: truthful required Unity aggregate enforcement in consumer rulesets.
- #51: App/secret scope, owner security controls, and existing-reader-App
  client-ID migration.
- #53: pre-FIFO shared-runner admission/starvation architecture and load proof.
- #83: independently returnable entitlement identities and portal-reconciled
  evidence before changing the fail-closed 400006 classification.
- #113: 209 current organization enrollment findings.
- #126: active scheduled reaper delivery SLO breach.
- #153: container-owned and Darwin trusted cleanup implementations and paid
  canaries.

## Dependency currency

- The root module reports no available dependency update.
- `github.com/rhysd/actionlint` v1.7.12 remains the latest release.
- The isolated actionlint module reports `go.yaml.in/yaml/v4` rc.6 as newer
  than rc.3, but an isolated build of actionlint v1.7.12 against rc.6 fails on
  upstream parser API changes. The unused `goldmark` and `x/net` retraction
  lookups are not in the module graph. No safe dependency update is available.
- The repository has no npm manifest; committed action runtimes are
  dependency-free by contract.

## Validation and review

Red/green evidence:

- `node --test test/documentation-policy.test.js` failed on the missing manual
  versus scheduled-delivery distinction before the runbook edit.
- The same focused suite passed all 10 tests after the edit.
- `go test ./cmd/reaper-delivery-audit ./internal/githubissue` passed.
- `git diff --check` passed.
- `.devcontainer/scripts/verify.sh` passed the complete local CI equivalent:
  LLM harness and policy checks, 824 Node tests (821 passed and three expected
  platform skips), every Go package and race test, both module verification and
  tidy-diff gates, golangci-lint, Go vet, ShellCheck/actionlint, and the workflow
  credential-literal audit.

Independent adversarial review, pull-request delivery, and protected-main
post-merge evidence are recorded below once complete.

The independent adversarial reviewer inspected the latest diff, live issue
states, transferred acceptance criteria, #126 code/workflow semantics, public
evidence boundaries, and complete-verifier record. The fresh final round found
zero actionable issues. The main thread implemented the change; no remediation
round was required.

## Continuous improvement

This substantial investigation triggered the continuous-improvement gate. The
reusable scheduler limitation was already recorded in the issue-77 task
resource, so no competing `.llm` guidance was added. The newly demonstrated
operator distinction belongs in the authoritative steady-state runbook and its
mechanical documentation-policy test, which were revised together. The issue
dispositions remain live, issue-specific evidence rather than agent guidance.

## Delivery

Pending.
