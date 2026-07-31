# Session 038: Exact holder-job stale evidence

Date: 2026-07-31

Status: implementation and first hosted review green; final evidence pending

## Objective and invariants

Review every open issue, favor the least dependent Unity CI churn, and deliver
the highest-impact safely autonomous objective through review, merge, and a
green default branch. Preserve capacity, FIFO order, exact run-attempt and
runner identity, fail-closed ambiguity, recoverability, and sanitized evidence.

## Open-issue prioritization

The ordering favors immediate licensed-capacity safety, then zero-dependent-
Unity central changes, then bounded consumer rollouts, and finally broad live
canary or organization-control-plane programs. "Zero" means no consumer Unity
workflow is required by the central change itself.

| Priority | Issue | Expected dependent Unity churn | Disposition |
| ---: | --- | --- | --- |
| 1 | #169 wrong matrix job reaped | Zero | Active live-holder safety defect with a central deterministic regression. Selected. |
| 2 | #160 delete consumed return evidence | Bounded consumer rollout | Central implementation is merged; remaining exact-head rollout evidence is operationally related but not safe to combine with the reaper fix. |
| 3 | #166 prohibit CI editor provisioning | Multi-consumer rollout | Draft PR #167 exists and is intentionally blocked until enrolled defaults adopt the required prefix. |
| 4 | #168 suppress checkout safe-directory writes | Multi-consumer rollout | Reliability policy plus every enrolled Windows consumer and a real Windows proof. |
| 5 | #83 shared Unity entitlement seat | Live multi-runner canaries | Capacity-critical, but requires portal and runner evidence; #169 can reproduce its under-count shape and is the safer immediate fix. |
| 6 | #113 enrollment drift | Multi-consumer remediation | Active generated alert; remediation is consumer-by-consumer and can trigger paid matrices. |
| 7 | #153 container/Darwin cleanup | Platform canaries | New trusted cleanup surfaces require real platform evidence. |
| 8 | #27 recurring held locks | Coupled live monitoring | Broad symptom issue whose closure depends on lifecycle evidence. |
| 9 | #29 lifecycle canaries/monitoring | Multiple canaries over time | Operational program with deliberate activation and failure probes. |
| 10 | #60 zero release cooldown | Five consumer suites plus handoff | Requires release, repins, and monitored cross-runner proof. |
| 11 | #99 minimize acquire/release time | Consumer timing study | Optimization follows correctness and needs representative load evidence. |
| 12 | #44 truthful required Unity aggregates | Multiple consumer suites | Requires consumer and repository merge-gate rollout. |
| 13 | #49 bound unity-helpers matrix | Representative plus full matrix | Throughput work must preserve automatic full compatibility coverage. |
| 14 | #53 pre-FIFO runner starvation | Three repositories/two runners | Architectural fairness work requires controlled load tests. |
| 15 | #51 constrain App/secret scope | Control plane plus probe | Organization policy changes are expressly out of scope for this session. |
| 16 | #94 yaml/v4/actionlint update | Zero when upstream permits | Dependency boundary is tracked; verify current module availability before declaring actionability. |
| 17 | #30 secure rollout tracker | Union of child work | Umbrella tracker, not a coherent single low-churn delivery. |

No open dependency-upgrade PR exists. Draft PR #167 is the only open PR and is
preserved rather than merged past its documented rollout gate.

## Baseline and hypothesis

Issue #169 records the authoritative incident: the timestamp window around
`acquiredAt` selected a completed editmode job instead of the live playmode job
because the action clock preceded the Actions jobs API `started_at` value.

Hypothesis: acquire can safely persist the unique active numeric job ID on the
declared runner. Reaping can then require that exact ID and runner, falling back
to active run retention whenever proof is absent or ambiguous. A test containing
the incident's two sequential same-runner jobs falsifies the former inference.

The red baseline was reproduced directly against the committed `HEAD` runtime:
the incident fixture returned `stale=true` with completed job `91204876077`,
proving the timestamp inference would remove the live playmode holder.

## Work and focused evidence

- The runtime now resolves the unique active job at acquire, persists optional
  `jobId` state without a schema transition, and includes it in reaper CAS
  version comparison.
- Job-level stale evaluation no longer examines `started_at` or `completed_at`
  windows. It requires exact job ID plus runner identity from the exact run
  attempt.
- Older state or acquire calls without Actions evidence retain an active run;
  exact run-terminal and lease-governed unavailable-run paths are unchanged.
- Both acquire manifests now describe Actions-read access, and README/runbook
  guidance documents the exact proof and fallback.
- Focused Node run: 15 selected stale/job/state/acquire tests passed, including
  the incident regression, exact completed-job reclaim, legacy omission,
  ambiguous current-job lookup, malformed IDs, and persistence.
- Initial full local CI equivalent: 682 Node tests, with 680 passed and two expected
  Windows-native skips; all Go packages, both module verifiers, actionlint, the
  LLM harness, credential audit, and diff hygiene passed.
- Dependency audit: no open Dependabot PR or security alert; the root module is
  current. The isolated verifier's direct actionlint dependency is current.
  Issue #94 expressly retains its incompatible yaml rc.3 transitive until an
  actionlint release supports rc.6 and forbids unrelated transitive overrides.

## Remaining gates

- Run full local CI-equivalent validation and dependency freshness checks.
- Perform a separate adversarial review/remediation loop and continuous-
  improvement decision.
- Commit and push only the issue #169 files, preserving unrelated installer
  worktree files.
- Open the PR, trigger Cursor Bugbot and GitHub Copilot after every push, resolve
  all feedback, and await every exact-head check.
- Merge and verify the resulting `main` head remains green.

## Review findings and disposition

1. Exact ID-and-runner matches still accepted missing or unrecognized job
   statuses as terminal. Disposition: fixed by allowing only active Actions
   statuses or literal `completed`; ambiguous status now warns and retains both
   holders and queue entries.
2. A retry that resolved a job ID after an earlier ID-less admission could
   return idempotent success without persisting that stronger identity, and a
   same-attempt queue refresh could silently replace conflicting evidence.
   Disposition: fixed with CAS-backed holder and legacy-mirror backfill, queue
   backfill, conflict retry, post-write verification, and fail-closed rejection
   of conflicting nonempty IDs.
3. README stale-recovery guidance incorrectly claimed acquire and reaper shared
   one stale predicate. Disposition: corrected to state that only the scheduled
   reaper evaluates staleness and consumer acquire treats observed state as
   authoritative until reconciliation.
4. Fresh-admission verification checked holder, attempt, runner, and schema but
   could report success after the proven `jobId` was missing or replaced in the
   post-write snapshot. Disposition: fixed by requiring an exact `jobId` match
   whenever acquire resolved one; absent or conflicting evidence now retries
   from fresh state and fails closed rather than reporting acquisition.

## Continuous-improvement decision

Trigger: public fail-closed lifecycle behavior changed across runtime, state,
tests, manifests, and operations documentation after a production incident.
Observed facts are the reproduced cross-clock misidentification, the malformed-
status unsafe path, and the holder/queue/post-write CAS persistence gaps found
by independent review. No inference about GitHub clock ordering is required:
the incident proves those clocks cannot establish identity.

Decision: revise the canonical build-lock invariant reference. It now requires
recorded numeric job identity bound to run attempt and runner, recognized status,
and CAS persistence, and prohibits timestamp/name inference. The task record and
behavior tests provide reproducible evidence. No separate research note or new
skill is warranted because the rule is stable, normative, and lifecycle-specific.

## Latest validation and review round

After all four findings were remediated, the complete local CI equivalent
passed 691 Node tests (689 passed and two expected Windows-native skips), every
Go package, both module verifiers and tidiness checks, actionlint, the LLM
harness, credential audit, and diff hygiene.

Implementation was performed on the main thread from inherited prior-session
work. Independent reviewer `issue169_adversarial_review` found the malformed-
status, persistence, and documentation gaps. Distinct remediator
`issue169_remediate_fast` fixed them. Independent reviewer
`issue169_final_review` then found the fresh-admission CAS verification gap;
the same distinct remediator fixed it, after which that reviewer reported
`ZERO ACTIONABLE FINDINGS`. Residual uncertainty is limited to live GitHub API
timing and mixed-client behavior; both retain state fail closed when exact proof
is absent.

## Hosted exact-head review

Commit `16297f249e2b8c340f923c7bb9eaca13840b239c` was pushed and opened as
PR #170. Build lock CI run `30667260533` passed both `Validate lock action
files` and the hosted-Windows `Validate Windows evidence deletion` job. Cursor
Bugbot reviewed that exact commit and reported no new issues; the thread-level
audit returned no review threads. The PR became clean and mergeable after its
draft gate was removed.

Copilot was requested after the push through the formal reviewer API and an
exact-head tagged comment, then again by tag after the PR became ready. GitHub
rejected the service account from the reviewer API because it is not a
repository collaborator, and the tagged requests produced no review or code
feedback during the completed CI/Bugbot window. No dependent-repository Unity
workflow or licensed Unity job was triggered by this central PR.
