# Session 123: report drift in the audit run

Date: 2026-10-02

## Prioritized open issues

Baseline: clean `main` at `e208e42d2`. No open pull requests. No dependency
change was needed; `node tools/llm-harness.mjs check` and both `go mod verify`
runs pass unchanged.

| Priority | Issue | Impact and evidence boundary |
| --- | --- | --- |
| P0, merge-policy source binding | #255, #44 | Four rulesets leave the required Unity aggregate unbound, so any App can satisfy it. The central audit detects it. The fix is a live ruleset edit. Not this task's to make. |
| P0, owner security action | #51 | App installation and org-secret visibility. Owner authority required. |
| P0, licensed-seat proof | #83 | Independent two-seat capacity and portal reconciliation. Owner and Unity portal evidence required. |
| P1, drift visibility | #325 | A complete audit with drift concluded green and named no finding in the run. In-repository. **Selected.** |
| P1, queue diagnostics | #53 | Items 1 to 5 need an admission design and live two-runner load. Item 6 landed in #324. |
| P1, platform cleanup | #153, #229, #231, #249 | Native and container canaries plus an immutable release authorization. Hardware and owner acts by design. |
| P1, lifecycle evidence | #29 | Hard-stop, account-block, third-runner, and seven-day monitoring canaries. Live operations. |
| P1, consumer evidence | #278 | Lock admission and release were clean. The first test log and consumer retry details are still missing. |
| P2, cancellation attribution | #277 | GitHub records no actor for the unexplained cancellation. No actor is recoverable from run records. |

I selected #325. A drift state that nothing inside the run names is the
failure mode this repository refuses everywhere else. No licensed Unity job
spends a cycle on it, and it changes no safety invariant.

Neither audit workflow is a required check on `main`. The only required context
is `Validate lock action files`, from ruleset `main-pr-ci` (id 18823716), checked
2026-10-02. So the cost of the chosen option is operator attention, not a blocked
merge. A daily run that cannot go green would hide the incomplete-audit failure
that an operator can act on from here.

## Baseline

- `.devcontainer/scripts/verify.sh` exits 0 in 9.3 s. 987 JavaScript tests,
  0 fail, 6 skipped by platform gate. All Go suites, `golangci-lint`,
  `shellcheck`, `actionlint`, `go vet`, and `go test -race` pass.
- A complete audit with one drift finding published four count lines, exited 0,
  and emitted no annotation. The finding named no repository and no reason code
  anywhere in the run.

## Hypothesis

A caller waits in one of two places (session 122). The merge-policy run had the
same shape: `record-counts` printed counts and gated only on `.complete`, so a
complete audit with findings was indistinguishable from a clean one.

Falsifiable claim: every drift finding is already in the retained artifact and in
the drift issue, so the run needs no new read and no new API call. If the
artifact did not carry the repository and the reason code, the item could not be
closed here.

The artifact carries both. Confirmed.

## Change

Two commits on `fix/325-audit-run-reports-drift`.

- Publish every drifted repository in the run summary, one row each, with its
  finding count and its reason codes.
- Emit one warning annotation naming the total, the number of repositories, and
  every reason code with its full count.
- Say in the summary that a clean audit is clean, so a green run cannot be read
  as a silent one.
- Refuse an artifact whose findings cannot be published. Such an artifact is
  evidence the step did not read, so the run now fails closed.
- State in `docs/consumer-enrollment.md` and `docs/operations-runbook.md` what a
  green run means.

## Class sweep

Two workflows share the defect: the merge-policy audit and the Unity enrollment
audit. Both had `continue-on-error: true` on the analyzer step and the same
`.complete`-only gate. Both are fixed. `rg -n 'continue-on-error'
.github/workflows/` returns exactly these two, and both now name their drift in
the run.

The table and `record_causes` are byte-identical in the two scripts.
`record_counts` differs only in the expected strings. That duplication is
pre-existing and recorded as accepted in session 120.

Two sites keep the documented habit that a known condition is a successful
monitor outcome. Both print their reason to the run log, so neither matches the
#325 definition. #326 records them as follow-up work.

## Red-green

| Check | Before | After |
| --- | --- | --- |
| `record-counts` cases | 4, duplicated per script | 2 clean runs, 8 refused artifacts, 1 summary contract, per script |
| Counts block asserted | `Complete: true` only | The whole four-line block, per script |
| `::warning::` annotation asserted | none | Whole line, including both guidance sentences |
| `record_drift` rows | absent | Repository, count, and sorted reason codes asserted |
| Cause table blank cell | asserted | asserted, scoped to the cause section |
| Clean run publishes no annotation | absent | Asserted per script |
| Incomplete run publishes no verdict | absent | Asserted per script |
| `node --test test/*.test.js` | 987 | 1001 |

Red states observed before each implementation step: no clean line, no drifted
repository row, no annotation, and a green run for an artifact with a null
findings key.

## Verification

- `.devcontainer/scripts/verify.sh` exits 0. 1001 tests, 995 pass, 0 fail,
  6 skipped by platform gate.
- `shellcheck -S warning` clean on both scripts.
- Nine mutations of the two scripts were each caught by the new tests: dropping
  `record_drift`, clamping the annotation total, dropping the refusal gate,
  moving the verdict above the completeness gate, deleting the annotation
  guidance, deleting the counts block, dropping the cause filter, and dropping
  the reason code rule.
- No credential, personal data, or live lock state appears in this record.

## Review rounds, and what each changed

Two independent adversarial reviews, one for the code and one for the class.

| Finding | Severity | Disposition |
| --- | --- | --- |
| A `null` or missing `findings` key has length 0 in jq, so the first version published a confident "complete and clean" for evidence it never read. The old cause table errored on that shape and printed a note. | should-fix | `require_readable_findings` refuses it and fails closed. Eight shapes are now table-driven cases. |
| The bounded cause table filtered to causes before the bound. The first version sliced the whole array, so drift rows pushed every cause out of an incomplete run's only cause channel. | should-fix | The cause table is main's code, unchanged. The repository table is the new block. |
| A reason code with a line break could forge a second workflow command, because the annotation interpolates a value read from a file. No producer can write one today, and only step order would have caught it. | should-fix | The refusal gate applies the rule both drift issue readers already apply to the same field. |
| The annotation counted reason codes but named no repository, so a large audit left most consumers unnamed. | should-fix | One row per drifted repository, bounded by the audited set instead of by finding count. |
| Nothing asserted the four count lines any more. Deleting the counts block from both scripts passed every test. | should-fix | `record()` asserts the whole block for every case. |
| The annotation total was unclamped by any assertion. | should-fix | The bounded case asserts the headline total and the repository count. |
| Both guidance sentences in the annotation were unasserted. | minor | The annotation is now asserted as a whole line. |
| Whether an incomplete run publishes a verdict was undecided. | minor | It does not. A failing run must not also publish a green verdict. |
| `label` in the case table was dead data. | minor | Both `label` and `inventoryLabel` build assertions now. |
| Three names for two audits in operator-facing copy. | minor | The enrollment script now says "Unity enrollment audit" in all four lines. |
| The workflow test asserted `printf '::warning::%s open `, which pins a spelling. | minor | It asserts `::warning::` instead. The script test proves the message. |
| Nine new comments and doc sentences ran past 20 words, and three used "red" as a verb. | minor | Split. The scripts and docs use "keeps the run green" and "fails the run". |
| `README.md` still published the superseded contract, so two of the three documents that state it were corrected and one was not. | blocker | Corrected, and a test now pins the shared sentence in all three. |
| `record_drift` had no fallback, so a jq failure there skipped the incomplete line that `record_causes` protects. | should-fix | It fails the run with its own line instead. Degrading would leave a green run with no repository in it. |
| Nothing stopped `record_causes` from publishing a blank cause cell after the old assertion was deleted. | should-fix | Asserted again, scoped to the cause section so the drift table may still name a causeless repository. |
| The gate comment claimed it matched the drift readers' rule for every field. It does not. | should-fix | The comment now says the rule covers the reason code, and names where the repository and the cause are bounded. |
| The refusal fixtures claimed all eight can reach the step. Four cannot, because Go refuses to decode them. | should-fix | The comment now says which three can, and why the rest stay. |
| `test/workflow-policy.test.js` read the whole script, so the assertion did not prove the job runs it. | minor | It now reads the scripts the job invokes. |
| The annotation went to stdout while every other emitter in this repository uses stderr. | minor | Switched, with the assertions. |
| `merge-policy-audit.sh` lost its final newline. | minor | Restored. |
| `GITHUB_STEP_SUMMARY` guards were inconsistent between neighbouring functions. | minor | Every new line uses the guarded form. |
| The three publish sites repeated one failure line each. | minor | `refuse_publish` holds it once, and the subject names what could not be published. |
| `progress/session-120` documents `record_causes`, which still exists, and calls the two scripts a duplication to accept. | minor | Both statements still hold. This record adds the drift table. |

## Known limits

- The drift table holds one row per drifted repository. Its length is bounded by
  the audited set, so it does not need the bound the cause table needs.
- The annotation is the headline. The summary and the drift issue hold the
  detail. The required check context and the finding detail stay in the drift
  issue, as before.
- `require_readable_findings` applies the reason code rule that both drift issue
  readers already apply. It does not re-check the repository name or the cause.
  Both are bounded where the analyzer produces them: one is a validated registry
  entry, the other is a sanitized reason.
- The cause table still degrades to a note, because a cause is extra evidence and
  the run is already red without it. The drift table fails the run instead,
  because it is the only place a green run names the drifted repositories.
- An incomplete audit still fails the run, and it publishes its cause before it
  does. That is unchanged.
- A clean audit says so in one summary line and emits no annotation.
- #255 keeps its four open findings. This change only makes the run name them.
- #325 stays open until the option chosen here is reviewed and merged.