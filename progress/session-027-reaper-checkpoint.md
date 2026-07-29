# Session 027: deadline-bounded reaper checkpointing

## Scope and hypothesis

On 2026-07-29, review every open issue and pull request, prioritize impact
while minimizing licensed Unity CI churn, and complete issue #131 without
changing organization policy, consumer workflows, live lock state, or licensed
Unity execution.

Hypothesis: scheduled reaping can exhaust its ten-minute workflow budget while
serially inspecting the FIFO before holders, preventing a proven terminal
holder transition from ever reaching the sole compare-and-swap write. Reordering
the scan by safety impact, checkpointing capacity-critical changes before queue
cleanup, and bounding status reads inside the outer workflow timeout will
restore recoverability without weakening ambiguous-state handling.

Disconfirming evidence would be an earlier state write before queue traversal,
an existing reaper-owned deadline, a bounded queue contract that makes the
scenario unreachable, or a test showing that phased checkpointing reorders the
FIFO or loses a concurrent change.

Safety invariants:

- State writes remain compare-and-swap protected and conflicts restart from a
  newly validated snapshot.
- A terminal schema-4/5 holder becomes a quarantine, never free capacity.
- Missing, timed-out, or ambiguous status evidence retains the corresponding
  holder, reservation, or queue entry fail-closed.
- Queue order and exact holder, run-attempt, and runner identity remain stable.
- Manual exact-ID reservation and incident recovery retain their existing
  proof requirements and are not governed by the scheduled-scan deadline.
- The action stops before GitHub's outer job timeout and leaves operator-visible
  failure evidence when a scan is incomplete.

## Issue and pull-request inventory

The clean checkout started at `1e6cf0cff`, equal to `origin/main`. The GitHub
connector returned 13 pre-existing open issues and no open or draft pull
requests. Current-main Build lock CI run `30410141394` was green. Independent
priority review reached the same issue dispositions.

| Priority | Issues | Disposition |
| --- | --- | --- |
| P0 | #51 | Critical all-repository App/secret scope boundary, but completion requires prohibited owner organization-policy mutations and live negative probes. |
| P0 | #83 | Highest measured production defect. Fail-closed `400006` quarantine remains required until independent entitlement identities, both return orders, consumer adoption, and portal reconciliation exist. |
| P0 | #113 | Fresh derived enrollment alert with 286 findings across 113 jobs; closure requires six consumer remediations and a complete clean audit. |
| P1 | #44, #53 | Merge-safety and pre-runner FIFO architecture gaps requiring consumer/ruleset work or a new multi-repository claim protocol and live load proof. |
| P2 | #99, #49 | Throughput work requiring exhaustive consumer retry/timing evidence or a licensed compatibility-matrix policy change. #99 was explicitly reopened after #129's bounded central advance. |
| Operational | #27, #29, #30, #54 | Coupled monitoring, tracker, portal, and paid-canary work rather than a bounded central PR. |
| Blocked/stale | #60 | v1.10 publication/adoption steps are complete; literal zero remains unsafe pending #83 evidence. |
| Upstream blocked | #94 | actionlint v1.7.12 and upstream main both fail to compile with yaml/v4 rc.6; no compatible release exists. |

Dependency inspection found no actionable update. Root yaml/v4 rc.6 is latest.
All retained actionlint verifier requirements are current except its intentional
yaml/v4 rc.3. The only reported updates are unused test transitives that
`go mod why` says the verifier module does not need; #94 explicitly rejects
adding direct overrides merely to silence that output. All pinned Actions,
devcontainer features, and tool versions are current, and no Dependabot PR is
open.

None of the 13 pre-existing issues was truthfully completable by one central
repository PR under the stated authority. Independent lifecycle review then
found the queue-first reaper failure. Issue #131 records the exact code path,
reachable failure, safety requirements, and acceptance criteria. It is the
highest-impact safely completable objective and requires no Unity seat.

## Baseline and root cause

The scheduled workflow gives reaping ten minutes. The original runtime:

1. read and normalized the complete state;
2. sequentially awaited every queue run/job status;
3. only then evaluated holders;
4. then scanned aged quarantines; and
5. issued its only state write after every scan completed.

There is no configured queue maximum. Each status lookup may paginate jobs and
perform bounded retries, while the original reaper supplied no abort signal.
A valid matrix-heavy FIFO plus slow Actions API responses could therefore reach
the outer workflow kill before an already-terminal holder was evaluated or
written. The next five-minute invocation repeated the queue-first work, so
licensed capacity could remain blocked indefinitely.

The focused regression first failed with this exact observed order:

```text
actual:   queue-status, holder-status, write
expected: holder-status, write
```

The failing fixture used valid schema-4 state with one terminal holder and one
queued identity. No malformed or adversarial state was needed.

## Chosen architecture

Scheduled `reap` now uses safety-ordered phases from one freshly validated
snapshot:

1. prune expired cooldowns and evaluate holders;
2. checkpoint any holder/cooldown change immediately;
3. when no capacity-critical change exists, evaluate schema-5 aged
   quarantines and checkpoint any safe auto-recovery;
4. only then scan routine queue entries in FIFO order.

The status scan has an eight-minute abort signal. Reads and all consumer
run/job lookups share it. State writes use a separate nine-minute total
deadline, leaving one minute before the workflow's ten-minute kill for Node
shutdown and GitHub runner accounting.

When the scan deadline interrupts a phase, the current identity and every
unscanned identity are retained. Proven transitions in the current phase are
written with CAS, then the action fails red with `REAP_DEADLINE_ELAPSED`; if
nothing changed, it fails without a write. Capacity-critical phases checkpoint
the first proven transition immediately. Routine queue cleanup continues while
the scan budget is healthy, batches every exact entry proven terminal in the
scanned prefix, and preserves every retained entry's relative order.

If that checkpoint conflicts, scheduled reaping rereads normalized state under
the still-live total deadline and reapplies only a byte-for-byte normalized
holder, queue, or reservation version. A concurrent change to run provenance,
timestamps, reservation reason/state, or incident state invalidates the old
proof. In particular, a newly latched schema-5 global incident vetoes stale
quarantine auto-recovery. A skipped replay emits `reaped=false` and the fresh
state SHA rather than claiming mutation.

### Affected surfaces

| Surface | Effect |
| --- | --- |
| Committed runtime | Reap ordering, deadline propagation, phased writes, and incomplete-scan diagnostics. |
| Public action manifest | No input/output change; the existing runtime entrypoint remains synchronized. |
| State/config schema | No change. Existing schemas 1-5 and exact identities are preserved. |
| Scheduled workflow | No YAML change; its literal ten-minute timeout is now mechanically compared with internal budgets. |
| Tests | Red-green ordering, deadline hierarchy, holder partial checkpoint, queue partial checkpoint, FIFO retention. |
| README/runbook | Document capacity-first ordering, deadlines, fail-closed retention, and visible failure. |
| Consumers/live lock | No change or dispatch; no consumer repin or Unity run required. |

### Alternatives rejected

- Raising the workflow timeout only postpones the same unbounded traversal and
  does not prevent a hung request.
- Parallelizing the entire queue risks a burst of cross-repository API traffic
  and still lacks a safe write checkpoint.
- Removing unverified entries would convert missing evidence into free capacity
  or a FIFO bypass.
- A schema cursor or queue rotation would add migration and ordering complexity
  not required to restore capacity-critical recovery.
- Treating an incomplete scan as green would hide a recurring reader/API
  outage from the existing delivery monitor.

### Failure and recovery map

- Terminal holder: quarantine/reap is CAS-written before queue inspection.
- Active or unknown holder: retained with the existing stale reason.
- Status deadline: current and unscanned identities remain; proven earlier
  changes are checkpointed; action fails red.
- CAS conflict: retry from a fresh normalized snapshot under the still-live
  total deadline, with exact-version fencing and fresh incident preconditions.
- Ambiguous accepted write: retain existing `ambiguousReap` reconciliation.
- Reader 403 or malformed response: existing hard failure remains; it is not
  converted into cleanup evidence.
- Manual recovery: exact reservation/incident ID and portal/resource proof
  paths remain unchanged.

## Red-green evidence

Focused checks after implementation:

```text
node --test --test-name-pattern='scheduled reap (checkpoints stale-holder|reserves bounded checkpoint|checkpoints proven stale|checkpoints completed queue)' test/build-lock.test.js
node --test --test-name-pattern='reap|quarantine' test/build-lock.test.js
node --check .github/dist/build-lock.js
git diff --check
```

The focused cases and all 359 build-lock tests passed. The new cases prove:

- stale-holder state is written before any queue lookup;
- the eight- and nine-minute budgets remain ordered inside the literal
  ten-minute workflow timeout;
- a proven holder transition is checkpointed immediately without querying a
  later holder, while the complete FIFO remains untouched;
- a deadline after a proven completed queue entry checkpoints that entry
  without querying later queue entries, which remain in order;
- a healthy scan batches multiple completed entries while preserving the live
  FIFO tail;
- a first-write conflict rereads state under the write budget, preserves
  concurrent FIFO additions, and reapplies only the proven entry;
- an accepted-but-ambiguous retry checkpoint survives reconciliation and emits
  `reaped=true` with the fresh state SHA;
- changed queue provenance invalidates the earlier terminal proof; and
- a concurrently latched global incident vetoes quarantine recovery.

## Validation, review, and delivery

The first independent adversarial review found that a deadline-partial CAS
conflict tried to sleep with the already-aborted scan signal, so no fresh read
could occur. A distinct remediation pass moved conflict reconciliation to the
still-live total signal and added the concurrent-state regression. A root safety
pass then found that replay needed exact normalized version matching and a
fresh incident gate; the remediation pass added both regressions and truthful
no-op outputs. The next independent review found that stopping after one
completed queue entry would create five-minute-per-entry backlog drain and that
accepted-write ambiguity inside the retry helper was discarded. Remediation
restored healthy-scan batching, retained deadline-bounded partial checkpointing,
and propagated ambiguity from every retry write.

Complete local verification after remediation:

```text
.devcontainer/scripts/verify.sh
LLM harness checks passed.
tests 599; pass 599; fail 0
all Go packages passed
all modules verified
Workflow credential-literal policy passed.
```

Independent post-remediation runtime and knowledge review is complete with no
remaining actionable finding. PR CI/review evidence, merge, and exact-main
post-merge verification remain pending.

## Continuous-improvement disposition

Trigger: public lifecycle behavior, operational guidance, implementation,
tests, and a reusable starvation failure all changed.

Observed facts: the original queue-first loop had no internal deadline and only
one final write; the red regression observed `queue-status, holder-status,
write`; the revised tests prove capacity-first checkpointing, fail-closed
deadline retention, exact-version CAS replay, FIFO batching, and visible partial
failure. The adversarial loop additionally demonstrated that a write budget is
not useful unless conflict retry stops using the expired scan signal, and that
accepted-write ambiguity must be accumulated across every retry.

Decision: **revise** the existing build-lock invariant reference. The stable
repository-specific rule is that scheduled reaping orders capacity-critical
ownership before routine queue cleanup, keeps internal scan/write deadlines
inside its workflow deadline, retains unverified identities, and reports
partial progress as failure. The reference records that compact invariant;
this dated record and the runbook retain the implementation-specific budgets
and evidence. No task-only details were promoted.

Implementer: root agent. Independent reviewer: `issue131_review2`. Remediator:
`issue131_remediation`. The reviewer first found expired-signal CAS retry, then
found single-entry queue draining and lost inner ambiguous-write evidence.
Every finding was accepted and remediated with a regression. The final
post-remediation review reported no actionable findings after 27 focused cases.
