# Research: GitHub's issue list can omit its own recent items

<!-- summary: GitHub's creator-scoped issue list transiently omitted just-published bot alerts, so alert sync heals duplicates only on opt-in and keeps the flag-off refusal eager. -->

Date: 2026-10-26. Status: provisional, evidence-bounded.

## Conclusion

GitHub's creator-scoped issue list can transiently omit an issue that the
same creator just published. A monitor that creates on absence can then
publish twin alerts for one identity, and a refuse-only duplicate check
wedges every later synchronization permanently. The repository therefore
heals duplicate clusters only on explicit per-monitor opt-in, and the
flag-off refusal stays eager.

## Observed facts

- On 2026-10-22, the reaper-delivery alert monitor published three open
  twin issues in about two hours; each create path saw the alert list
  empty.
- Run logs around that window alternate minute by minute between create
  outcomes and later duplicate refusals, so some reads saw the twins and
  some did not. No client-side defect reproduces the omission today.
- The same creator listing kept showing an older closed issue with the
  same identity throughout, so the walk bound itself stayed intact.
- GitHub reported partial API instability that day; the direct cause of
  the omission is inference, not proof.

## Implications for future work

- Any monitor that creates an alert on absence must keep the
  verify-create re-discovery, so an unverifiable publish fails instead of
  silently repeating.
- Duplicate-cluster healing lives in `internal/githubissue` behind
  `Desired.ConsolidateDuplicates`. Twin closes patch state only; closed
  twins are never rewritten. Without the flag, the walk refuses at the
  second distinct match, byte-identical to the pre-heal contract.
- `Find` walks in eager-refusal mode; consolidation feeds on list mode.
  Changing either walk mode needs a fresh look at
  `TestFindRefusesDuplicatesOnThePageTheyAppear` and
  `TestBothWalkModesTreatARepeatedNumberAsOneIssue`.

## Revalidation trigger

Re-check when GitHub changes list behavior, when duplicate alerts recur,
or when a monitor grows a new create path: confirm the omission was
transient before pinning new contract language.

Pointers: `docs/operations-runbook.md` states the operator heal
semantics; `progress/session-130-consolidate-duplicate-monitor-alerts.md`
holds the evidence chain and both review rounds.
