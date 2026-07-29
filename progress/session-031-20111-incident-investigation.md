# Session 031: 20111 Incident Investigation

## Objective

Prioritize all open central-lock issues by organization impact while favoring
the least Unity CI churn, then complete the highest-priority safely bounded
issue.

Safety invariants: never admit work while a real leaked seat may exist, never
infer portal state from a recovery checkbox, preserve exact-ID recovery, and
retain only sanitized public evidence.

Hypothesis: historical evidence will either identify a reliable false-positive
signature for safe automatic recovery or disprove that automatic recovery is
currently supportable.

## Open-issue priority

Priority combines safety/availability impact, whether the work is actionable in
this repository without changing organization policy, and expected paid Unity
churn.

| Rank | Issues | Impact and disposition |
| ---: | --- | --- |
| 1 | #139, #132 | Org-wide 20111 outages and recovery ergonomics. #139 is selected: it is evidence-bounded, requires no licensed run, and decides whether automation can preserve safety. The visibility half of #132 is already delivered. |
| 2 | #51 | Shared credential scope is security-critical, but completion requires owner-authorized organization policy and secret visibility changes prohibited in this session. |
| 3 | #83, #60 | Shared entitlement returns cause frequent false quarantine and block zero cooldown. Needs independently returnable identities or a coordinated lifecycle design and consumer rollout; treating 400006 as clean would weaken fail-closed safety. |
| 4 | #113 | The enrollment alert reports broad cross-repository policy drift. Remediation spans consumer repositories and rulesets rather than one low-churn central PR. |
| 5 | #44 | Truthful merge gates have high safety value but require coordinated consumer workflow and repository-ruleset changes. |
| 6 | #53 | Pre-FIFO runner starvation harms fairness and throughput; the required two-phase admission protocol and real two-runner proof are a larger architecture project. |
| 7 | #27, #29, #30 | Rollout/incident trackers depend on live canaries, owner evidence, and a monitoring window; they are not a bounded code change. |
| 8 | #49, #54 | Consumer compatibility and cleanup canaries require paid Unity matrices and consumer-repository changes. |
| 9 | #99 | Acquire polling was improved, but exhaustive consumer activation/return retry evidence remains cross-repository. |
| 10 | #94 | The dependency update has zero Unity churn, but actionlint v1.7.12 remains latest and does not compile with yaml/v4 rc.6. Root-module dependencies are current; direct transitive overrides are explicitly out of scope. |

There were no open or draft pull requests to continue. `go list -m -u` found no
available root-module update. The isolated actionlint graph exposed newer
transitive versions, but its direct dependency remains current and issue #94
explicitly rejects adding unused direct overrides.

## Baseline and experiments

1. Fetched `origin/lock-state` and searched the complete lock-file history for
   additions/removals of `unity-account-limit-20111`.
2. Found exactly four distinct latches and four exact-ID recoveries.
3. Read sanitized source/recovery run metadata through GitHub APIs.
4. Searched public issues by every exact incident ID and source run ID.
5. Compared recovery assertions with independent portal-outcome statements.
6. Reviewed Unity's supported command-line license operations to evaluate a
   read-only probe.

The detailed sanitized dataset, uncertainty bounds, sources, and revalidation
triggers are in
`.llm/research/20111-incident-outcomes-2026-07-29.md`.

## Result

The hypothesis did not yield a safe automatic signature:

- one incident has a direct operator statement that there was no seat leak,
  but no incident has an independently recorded portal observation at latch
  time;
- all four incidents are therefore unprovable;
- zero incidents are independently proven real leaks;
- the population false-positive rate is therefore not measurable;
- activation is a mutating operation, not a read-only capacity probe.

Decision: keep 20111 admission fail-closed and retain exact-ID,
portal-confirmed recovery. Do not auto-expire, bulk-recover, or activation-probe
incidents. Continue reducing operator effort only through read-only visibility.

## Review and validation

### Independent roles and findings

- **Implementer:** the initial investigation agent assembled the sanitized
  four-incident dataset, documented the safety decision, and added the runbook
  guidance.
- **Reviewer:** a distinct adversarial-review agent found that the `00aa`
  incident was overclassified from an operator statement, the resulting
  false-positive bounds were overstated, the new runbook prose interrupted the
  Markdown operator table, and the research cutoff needed a fresh fetch before
  handoff.
- **Remediator:** a third, distinct agent accepted every finding. It
  reclassified all four incidents as `unprovable`, retained the `00aa`
  statement only as an observation, recalculated the proven lower bound to 0%
  and the possible range to 0%–100%, moved the prose below the complete table,
  fetched `origin/lock-state`, and reran the exact bounded history search.
- **Second review:** a subsequent independent reviewer found that the probe
  analysis still called a transient condition “already observed,” although
  the evidence established only an operator statement about the absence of a
  leak. The remediator accepted the finding and removed the claim that a
  transient outcome had been observed.
- **Third review:** the next independent reviewer found two remaining audit
  issues. First, the replacement phrase still implied that the operator had
  reported a transient condition; the remediator accepted the finding and
  changed the probe result to the neutral boundary that a 20111 response does
  not establish whether a leaked activation exists. Second, the progress
  record omitted the second and third review findings and dispositions; the
  remediator accepted the finding and added this review-round history.

**Final independent re-review:** no actionable findings. The reviewer
confirmed that every prior finding was resolved, the dataset remained
evidence-bounded, fail-closed safety and public-record privacy were preserved,
and the review/remediation trail was complete.

The fresh fetched tip was
`b90fafdff12a47a968765ea0793a632d68af4c8f`. The exact command

```bash
git log origin/lock-state -S'unity-account-limit-20111' -- \
  locks/wallstop-organization-builds.json
```

still returned eight transitions: four distinct latch commits and four
corresponding exact-ID recovery commits. The dataset population therefore
remains four.

### Continuous-improvement decision

Trigger: the investigation changed operational guidance and produced a
reusable evidence boundary. Evidence examined: the refreshed lock-state
history, sanitized run/issue observations, the research diff, the runbook
diff, and the adversarial findings.

Observed fact: the repository history contains four latches and four
recoveries through the recorded cutoff, while none has an independently
recorded incident-specific portal observation at latch time. Inference: some
or all may have been transient false positives; the available evidence cannot
measure that rate.

Decision: **promote** the bounded result as dated research and link it from the
runbook. This preserves the revalidation triggers without turning an uncertain
historical observation into permanent policy.

### Validation

Validation after remediation:

- `node tools/llm-harness.mjs generate` — passed; regenerated
  `.llm/index.md`.
- `node tools/llm-harness.mjs check` — passed.
- `node --test test/llm-harness-catalog.test.js
  test/llm-harness-contract.test.js test/documentation-policy.test.js` —
  passed, 24 tests.
- `git diff --check` — passed.
- `.devcontainer/scripts/verify.sh` — passed after remediation: 604 Node
  tests, all Go packages, both module verification/tidy gates, actionlint, and
  the workflow credential audit were green.

PR review, hosted CI, merge, and post-merge `main` evidence remain pending and
are not claimed by this handoff.
