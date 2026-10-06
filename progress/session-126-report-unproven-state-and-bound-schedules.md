# Session 126: report unproven state and bound scheduled admission

Date: 2026-10-05

## Objective and current-state audit

Complete GOAL.md and address at least three open issues. Preserve coverage and
reduce CI time. Attempt a large local iteration speed improvement.

The previous session made progress: PR #336 merged as 5b994ae40. This turn
verified that commit against GitHub, rather than assuming its final checks.
Main Build lock CI 37386541740, Development container 37386541994, and enrollment
37386541760 passed. Both central monitors had fresh successful runs. No PR,
including a draft or dependency PR, was open. The local worktree was clean.

All 17 open issues were read before selection. This order favors impact and
limits licensed Unity CI churn. Owner evidence remains a boundary, not a reason
to change organization policies.

| Priority | Issues | Impact and disposition |
| --- | --- | --- |
| P0: credential scope | #51 | Owner-authorized App/secret inventory and scope changes remain. No org-policy change is authorized. |
| P0: merge gate | #255, #44 | Live source binding and enforcement remain. Keep truthful central audit evidence. |
| P0: independent seat capacity | #83 | Portal reconciliation and return-order evidence remain. Preserve both configured holders. |
| P1: misleading resource evidence | #328 | Selected. Unknown holder status must not produce a clean-state claim. |
| P1: unattended admission | #332 | Selected. Permit reviewed, bounded schedules with explicit per-repository opt-in. |
| P1: scheduler availability | #334 | Fresh monitors now start and pass. Independent delivery-path or owner decision remains. Do not close on a recovered run alone. |
| P1: queue fairness | #53 | Live load and admission design remain. Existing runner/FIFO diagnostics remain intact. |
| P1: platform authorization | #153, #229, #231, #249 | Native/container canaries and exact release authorization need physical and portal evidence. |
| P1: operational canaries | #29 | Deliberate failure and seven-day monitoring evidence remain. |
| P1: consumer test failure | #278 | Lock cleanup was clean; consumer failure/retry evidence remains. |
| P2: release visibility | #330 | Selected. A successful no-release run must name its unreleased train. |
| P2: cancellation actor | #277 | Run records do not prove the actor. Preserve that evidence boundary. |
| P2: linter compatibility | #335 | Latest actionlint still requires the earlier YAML API. Keep the tested compatible tool module. |

## Hypotheses, red results, and implementation

Safety invariants: no licensed admission, holder fencing, capacity, cleanup,
recovery, FIFO, credential scope, or required-check name is weakened. No live
licensed run or organization-policy change is needed for this group.

#328: the no-change verdict uses queue mutation as proof of the whole state.
A new test reproduced the error on the starting runtime: unreadable holder
status produced `No stale state found`. The fix publishes only the number of
holders retained for unavailable run status before lease expiry. It publishes
no holder or API identity. The no-change verdict now says no stale state was
proven, including when a queue or quarantine status remains unproven. Holds,
state writes, and output names do not change. Data-driven cases cover 404, 401,
25 retained holders, queue cleanup, cooldown pruning, and known-active status.

#332: strict trigger policy can accept a bounded schedule without changing other
controls. The initial regression failed because AllowSchedule did not exist.
The typed registry and audit policy now carry the flag. Absent means false.
Paid and fallback cleanup jobs use the same trigger check. Onboarding carries
the typed value end to end. IshoBoy alone opts in.

One cron entry is required, with fixed numeric minute/hour and valid numeric
date fields. Multiple entries are refused even when each is individually daily:
per-entry checks cannot bound total unattended admission. Scheduled workflows
remain paid-serial, not controlled canaries. Tests cover opt-in, malformed
syntax/types, out-of-range fields, duplicate keys, multiple entries, fallback
mirroring, missing protected-branch evidence, and dispatch opt-in independence.

#330: the old report exits silently when every subject is conventional. Its new
regression failed on both the starting runtime and the original introducing
commit in an isolated scratch layout. The final report uses the caller's
successful no-publication result and states the tag, count, and commit types.
It does not infer a release result from duplicated parser rules. Git and summary
errors warn and keep the diagnostic successful. No release dependency is added.

## Speed and coverage evidence

Baseline full verifier: exit 0 in 11.74 seconds. The local verifier now overlaps
three independent check groups and prints each group's output together. It
waits for all groups and fails if any fails. No check is removed.

An independent reviewer injected failures into all 59 executable/argument
forms. Every failure produced a nonzero parent result. Review found that killing
a background shell could leave its foreground child alive. Root remediation
runs each group in its own Linux session. Cleanup stops the whole process group.
A fresh test with a TERM-resistant child returned 143 in 0.004 seconds; the
child's process entry was gone. ShellCheck passed.

Same current Node suite, sequential measurements on this container:

| File concurrency | Wall time | Tests | Failures | Native skips |
| --- | --- | --- | --- | --- |
| 3 | 13.08 s | 1015 | 0 | 6 |
| 8 | 5.73 s | 1015 | 0 | 6 |

Linux CI now pins eight active test files. It keeps the same glob, assertions,
job name, native-platform checks, and timeout. Hosted evidence is required below.
Prior main Linux job: 90 seconds; Node test step: 15 seconds. Prior Windows job:
59 seconds; test step: 45 seconds. Prior Darwin job: 10 seconds.

## Dependency audit

Live release/registry queries confirm current ESLint 10.12.0, semantic-release
25.0.9, GitHub plugin 12.0.10, actionlint 1.7.12, GitHub CLI 2.102.0, and
GolangCI-Lint 2.14.0. Configured action releases also remain current. The root
YAML dependency is current rc.6; actionlint's compatible rc.3 boundary remains
tracked in #335. New goldmark and x/net graph releases are unused according to
`go mod why -m`; no unused requirements were added. Discovery needed a writable
GOPATH for sumdb metadata; checksum verification stayed enabled.

## Review and continuous improvement

Implementers: root (#328, verifier, CI concurrency); schedule332 (#332);
release330 (#330). Independent reviewers: release330 (#328 and #332);
review330_speed (#330, verifier, CI concurrency, and knowledge). Root handled
verifier remediation; release330 handled report remediation. No self-review is
called independent review.

| Finding | Disposition |
| --- | --- |
| Local verifier cancellation could orphan a tool child | Fixed with isolated process groups; fresh resistant-child test confirms cleanup. |
| Copied release grammar missed pinned parser and revert behavior | Removed the duplicated semantics. Use the caller's actual publication result. |
| Registry regression assumed map iteration order after parser sorting | Test bug fixed by matching the repository identity. |
| Cron validator if/else chain failed Go lint | Rewritten as switch; fresh lint passed. |

Continuous-improvement trigger: runtime evidence, policy, workflows, tests,
docs, validation, and multi-step review changed. Observed fact: current upstream
parser code differed from the installed pinned release parser. Revise the
existing testing skill to require exact pinned-tool and parser evidence when
matching tool behavior. The generated index and harness checks passed. Separate
knowledge review found no actionable findings. Stable operator contracts live
in their existing runbooks; no competing guidance was added.

Final local verification, remote review, merge, issue closures, timing, and main
checks are recorded below after they complete. This record does not claim those
pending gates passed.

## Final local gate

Latest implementation verification exited 0 in 6.64 seconds, against 11.74
seconds before. This is a 43% reduction in this container. It ran 1010 Node
tests: 1004 passed, zero failed, six native-platform skips. All Go tests, vet,
race checks, module verification/tidy checks, linters, harness, and credential
audit passed. No original test/check was removed. The 1015-test speed experiment
above used the intermediate report implementation; five speculative grammar
cases became unnecessary when the duplicated parser was removed.

The latest independent review rounds found no actionable findings in #328,
#330, #332, the verifier, the CI command, or the knowledge change. Full local
verification ran after implementation and review remediation stopped.

## Verified remote delivery (2026-10-06)

PR #337 merged as `57107d1e01c4ed5aafbeaefd47712bb121bd3272`.
Fresh GitHub API checks confirm that #328, #330, and #332 are closed.
All applicable PR checks passed, including Bugbot and native Windows/macOS.
The PR has no review submissions or inline comments. Independent review and
remediation evidence remains in the section above.

Merged-main evidence:

- Build lock CI 37390137569: all three jobs passed.
- Development container 37390137372: amd64 and arm64 passed.
- Enrollment audit 37390136471: passed, complete retrieval, zero findings,
  115 active inventory rows. Alert #113 is closed. Its older reproduction
  task is obsolete at the audited consumer commits.
- Merge-policy audit 37390136610: passed. This does not close #255's
  enforcement and source-binding requirements.
- Incident recovery audit 37398519667 and reaper delivery audit 37400198701:
  passed on the same merged SHA.

GitHub job timestamps confirm the PR's recorded comparison:

| Validation job | Prior main | Merged main |
| --- | ---: | ---: |
| Linux action checks | 90 s | 55 s |
| Windows native checks | 59 s | 84 s |
| macOS native checks | 10 s | 9 s |
| Container amd64 | 290 s | 251 s |
| Container arm64 | 222 s | 217 s |
| Total runner time | 671 s | 616 s |

Total observed runner time fell 8%. The longest job fell from 290 to 251
seconds. The Linux Node step stayed at 15 seconds. The Windows command did
not change; this comparison does not establish a Windows speed improvement.
No check or original test was removed. Hosted variation limits extrapolation.
The local 43% verifier improvement and same-suite concurrency experiments
remain recorded above. No draft, dependency, or other PR was open when checked.

Final remote evidence is also retained in
[PR #337](https://github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/pull/337).
