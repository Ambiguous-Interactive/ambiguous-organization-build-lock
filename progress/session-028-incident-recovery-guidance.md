# Session 028: incident recovery guidance contract

## Scope and hypothesis

On 2026-07-29, review every open issue and pull request, prioritize impact
while minimizing licensed Unity CI churn, and complete issue #133 without
changing organization policy, live lock state, or incident recovery semantics.

Hypothesis: the current source already names the proof-bearing recovery
workflow, but the deployed consumer pin predates that correction and the
denial text has no stable workflow path. Adding the path and a cross-surface
contract test, releasing the result, and re-pinning only the affected
qora-redux workflow will make the operator instruction actionable while
causing one consumer Unity CI run instead of organization-wide churn.

Disconfirming evidence would be a current qora-redux pin containing the fixed
message, a recovery workflow without the required inputs, or evidence that the
denial can safely recover an incident through scheduled reaping.

Safety invariants:

- Account incidents continue to block every new admission fail closed.
- Recovery still requires the exact incident ID and explicit portal cleanup
  proof.
- Scheduled reaping remains separate from proof-bearing recovery.
- Queue, holder, reservation, schema, and compare-and-swap behavior do not
  change.
- Diagnostics remain single-line and contain no credential or evidence-digest
  values.

## Issue and pull-request inventory

The clean checkout started at `be8e79b46`, equal to `origin/main`. The GitHub
connector returned 15 open issues and no open or draft pull requests.
Push-triggered Build lock CI run `30415197077` passed on that exact commit.

| Priority | Issues | Disposition |
| --- | --- | --- |
| P0 | #51, #83, #113 | Critical security, entitlement, and enrollment findings, but completion requires prohibited organization-policy changes, multi-repository remediation, portal evidence, or a clean organization audit. |
| P0 | #133 | Selected production recovery defect. The deployed qora-redux acquire action names a workflow that cannot accept the requested inputs; the correction is bounded, fail-closed, and requires only one licensed consumer rerun. |
| P1 | #132 | Recovery ergonomics and incident investigation are important but require a new proof-bearing operational design; #133 is the safe immediate correction. |
| P1 | #44, #53 | Truthful merge gating and pre-runner FIFO fairness require consumer/ruleset work or a new multi-repository admission protocol. |
| P2 | #49, #99 | Throughput work requires exhaustive consumer timing, retry, and compatibility-policy evidence. |
| Operational | #27, #29, #30, #54 | Coupled monitoring, tracker, portal, and paid-canary work rather than a bounded central correction. |
| Stale/blocked | #60 | v1.9.0 through v1.10.0 are already published. Literal zero remains intentionally blocked by #83; current config stays at one second. |
| Upstream blocked | #94 | actionlint v1.7.12 remains latest and still selects yaml/v4 rc.3; the production module is already on latest rc.6. |

Dependency inspection found no actionable update. The root yaml/v4 rc.6 is
latest. The isolated actionlint module is current except for its intentional
yaml/v4 rc.3 pin; reported goldmark and x/net updates are unused transitives
that `go mod tidy` does not retain, and #94 explicitly rejects adding direct
overrides. No Dependabot pull request is open.

## Baseline and red-green evidence

The source on `main` already emitted `Recover build lock`, while
`.github/workflows/recover-build-lock.yml` declared `operation`,
`recover-incident`, `incident-id`, and `portal-cleanup-confirmed`. The
qora-redux default branch still pinned acquire to v1.9.1 commit `a00614ace`,
which predates the correction in `9f44e4a25`.

The regression first failed with:

```text
AssertionError: incident denial must identify the proof-bearing recovery
workflow and path
```

Both denial branches now emit:

```text
Recover build lock (.github/workflows/recover-build-lock.yml)
```

The behavioral regression extracts that name and path from the actual acquire
error, opens the named workflow, and proves that its name and the three
operator-requested inputs/options match. It covers both immediate denial and
the stricter caller-cleanup-failed path. Focused incident, workflow-policy,
action-manifest, and documentation-policy checks pass.

## Validation, review, and delivery

Focused verification passed for both denial branches and the adjacent workflow,
manifest, and documentation contracts. Fresh complete local verification
passed:

```text
.devcontainer/scripts/verify.sh
LLM harness checks passed.
tests 599; pass 599; fail 0
all Go packages passed
all modules verified
Workflow credential-literal policy passed.
```

Independent reviewer `issue133_review` inspected the complete runtime, tests,
workflows, contracts, and progress record and reported no actionable finding.
The review explicitly confirmed that issue #133 remains incomplete in
production until a release containing the change is adopted by qora-redux.

## Continuous-improvement disposition

Trigger: a public fail-closed operator diagnostic and its recovery workflow
contract changed.

Observed fact: the original denial named a workflow but did not expose a stable
path that a contract test could resolve; the red regression could not bind the
instruction to the workflow declaring its requested inputs. The revised test
extracts the emitted path and verifies the workflow name and recovery inputs.

Decision: **revise** the existing build-lock invariant reference. Recovery
diagnostics that instruct a workflow dispatch must name its exact workflow
path, and a contract test must bind every instructed input to that declaration.
The invariant is reusable across quarantine and incident recovery and is
narrower than duplicating task details in agent guidance.

Implementer: root agent. Initial independent reviewer: `issue133_review`.
Final reviewer: `issue133_final_review`. The final reviewer found one
low-severity audit-record error: the inventory said 14 open issues while the
table and live API contained 15. Remediator: root agent, distinct from both
reviewers. The count was corrected to 15 and the complete verifier passed
again. A fresh final re-review of the revised snapshot reported no actionable
findings.

## Completed delivery evidence

Build-lock PR #136 was reviewed at exact head
`bb284782c54e51c1d2ab6f6b0e62911690d0e494`. Cursor reported no actionable
finding; Copilot returned quota exhaustion without code feedback. Build lock CI
run `30416463217` passed. The PR was squash-merged as
`6b7e4321f81fab1fde9c05f86c97c260c0280273`; push Build lock CI run
`30416530625`, Organization Unity enrollment audit run `30416530628`, and the
subsequent scheduled stale-lock reaper run `30416912134` all passed on that
exact default-branch commit.

Because the consumer accepts immutable commit pins, no mutable tag or release
was required. Qora-redux PR #173 pinned only `acquire-build-lock` to the exact
build-lock merge commit. The consumer review found one P3 record error: the
first draft incorrectly claimed that an acquire-only pin adopted build-lock
#123, whose changes are in separately pinned release and cleanup-gate actions.
The root agent removed that claim from the record and PR description. Cursor's
exact-head re-review of `902b6ce08941816ca10c0eea3cb2aab071efca61`
reported no unresolved findings; Copilot again returned quota exhaustion.

On that same consumer head, LLM Harness run `30417209813` passed and trusted
Unity Tests run `30417209826` passed acquire, EditMode, PlayMode, positive
license return, cleanup classification, lock release, no-residue fallback, and
the aggregate `Unity CI` gate. Qora-redux PR #173 was then squash-merged as
`9fa15b7047a2a66a4c45e37af9a8665081d30841`. Unrelated dependency freshness
findings remain isolated in qora-redux issue #172.

Issue #133 received the exact upstream, consumer, review, and workflow evidence
and was closed completed. The deployed consumer pin now directs incident
operators to the real proof-bearing recovery workflow without weakening
admission, cleanup, or incident-recovery semantics.
