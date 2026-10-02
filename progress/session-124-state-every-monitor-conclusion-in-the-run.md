# Session 124: state every monitor conclusion in the run

Date: 2026-10-02

## Prioritized open issues

Baseline: clean `main` at `291b1f50a`. No open pull requests. Thirteen open
issues. No dependency change was needed; `node tools/llm-harness.mjs check` and
both `go mod verify` runs pass unchanged.

| Priority | Issue | Impact and evidence boundary |
| --- | --- | --- |
| P0, merge-policy source binding | #255, #44 | Four rulesets leave the required Unity aggregate unbound, so any App can satisfy it. The central audit detects it. The fix is a live ruleset edit. Not this task's to make. |
| P0, owner security action | #51 | App installation and org-secret visibility. Owner authority required. |
| P0, licensed-seat proof | #83 | Independent two-seat capacity and portal reconciliation. Owner and Unity portal evidence required. |
| P1, monitor visibility | #326 | Two scheduled monitors keep a known condition a successful run outcome and name it in one step-log line. In-repository. **Selected.** |
| P1, queue diagnostics | #53 | Items 1 to 5 need an admission design and live two-runner load. Item 6 landed in #324. |
| P1, platform cleanup | #153, #229, #231, #249 | Native and container canaries plus an immutable release authorization. Hardware and owner acts by design. |
| P1, lifecycle evidence | #29 | Hard-stop, account-block, third-runner, and seven-day monitoring canaries. Live operations. |
| P1, consumer evidence | #278 | Lock admission and release were clean. The first test log and consumer retry details are still missing. |
| P2, cancellation attribution | #277 | GitHub records no actor for the unexplained cancellation. No actor is recoverable from run records. |

I selected #326. A green run that names its condition only in a log is the
failure mode this repository refuses everywhere else. No licensed Unity job
spends a cycle on it, and it changes no safety invariant.

Neither monitor is a required check on `main`. The only required context is
`Validate lock action files`, from ruleset `main-pr-ci` (id 18823716). So the
cost of the change is operator attention, not a blocked merge.

## Baseline

- `.devcontainer/scripts/verify.sh` exits 0. 1004 JavaScript tests, 0 fail, 6
  skipped by platform gate. All Go suites, `golangci-lint`, `shellcheck`,
  `actionlint`, `go vet`, and `go test -race` pass.
- An active global incident left the `Build lock incident recovery audit` run
  green with `Build lock incident alert synchronized: incident-….` on stdout,
  no job summary line, and no annotation. Every new Unity admission was blocked.
- An overdue reaper delivery left the `Reaper delivery audit` run green with
  `Reaper delivery alert synchronized: scheduled-run-overdue.` on stdout, no
  job summary line, and no annotation.

## Hypothesis

Both monitors already hold every value a conclusion needs: `observation.Reason`
and the sanitized incident or run evidence. So the change needs no new read and
no new API call. A falsifiable claim is that nothing in either monitor is lost
by publishing what it already printed.

Confirmed. The only new input is the runner's own `GITHUB_STEP_SUMMARY` path.

## Change

Three commits on `fix/326-monitors-state-their-conclusion`.

- `internal/runnotice` renders one conclusion into both operator surfaces. It
  takes a meaning sentence, a reason code, and an optional handle, and builds one
  summary line and one annotation. A handle is what makes a conclusion alerting,
  so an alerting conclusion cannot be published without naming what to act on.
- Both monitors carry a `monitorMeanings` map from reason code to the sentence
  that says what the reason concluded, plus a handle builder.
- Every classified outcome publishes. A refused state, an unreadable state, and
  a failed alert synchronization all publish their own reason code.
- The conclusion that keeps the run green also reaches the annotations tab as one
  warning.
- A conclusion the run cannot publish fails the run with
  `run-notice-unpublished`. An absent summary path is one such refusal, which
  matches the `${GITHUB_STEP_SUMMARY:?}` rule the two central audit scripts
  already follow.
- `README.md` and `docs/operations-runbook.md` state where a conclusion is
  published. A test pins both claims in both documents.
- Every meaning states only what the classification proved. A healthy reaper
  means the delivery is on time and its run either succeeded or is still inside
  the run-duration threshold.
- `.llm/skills/operations-and-documentation` item 7 records that a summary line
  and an annotation are operator-visible surfaces.

## Class sweep

Every workflow in `.github/workflows/` was checked. A run that fails red on its
finding is not in this class, because the red run is the signal.

| Workflow | In class | Reason |
| --- | --- | --- |
| `lock-recovery-audit.yml` | yes, fixed | `incident-active` kept the run green. |
| `reaper-delivery-audit.yml` | yes, fixed | Four delivery reasons kept the run green. |
| `reap-stale-locks.yml` | yes, filed as #328 | A holder kept for an unprovable run status is named in the step log, and the summary then says no stale state was found. `build-lock.js` is the most safety-critical committed runtime, so it is not changed here. |
| `merge-policy-audit.yml` | no | Drift keeps the run green and `merge-policy-audit.sh` already publishes a summary line and a warning. |
| `unity-enrollment-audit.yml` | no | Same shape. |
| `dx-unity-automation-audit.yml` | no | `workflow-credential-audit` returns 1 on a finding, so the run is red. |
| `auto-release.yml` | no, filed as #330 | `report-nonconventional-commits.sh` publishes a summary line and a warning for the stall it detects. A train with no releasable commit type is silent; filed. |
| `ci.yml`, `devcontainer.yml` | no | Every gate fails the run red. |
| `recover-build-lock.yml` | no | Every proof-bearing refusal throws and exits red. |
| `onboard-unity-repository.yml`, `request-unity-repository-onboarding.yml` | no | `reject-untrusted-request` and `validate-ref` use `test` and fail red. |
| `dependabot-auto-merge.yml` | no | Every skip is a routing outcome, not a detected condition. |
| `request-unity-enrollment-audit.yml`, `repin-consumer-locks.yml` | no | `repin-consumer-locks.sh` already writes a summary row per repository and a warning per anomaly. |

The 17 committed runtimes under `.github/dist/` were checked for the same shape.
Only `build-lock.js` publishes a summary line that can state the opposite of a
condition it could not prove; that is #328.

## Red-green

| Check | Before | After |
| --- | --- | --- |
| Job summary line per outcome | none | Exact line asserted for all five lock reasons and all eight reaper reasons. |
| Annotation for the green condition | none | Whole line asserted, including the derived plain-text form. |
| Annotation count per reason | none | Asserted for five lock reasons and five reaper reasons. |
| Reason code with no stated meaning | publishable | `ErrUnstatedReason`, and a test closes the vocabulary in both directions. |
| Refused publication | run returned 0 | `run-notice-unpublished`, exit 1, and no stdout verdict, asserted on the green and alerting branch of both monitors. |
| Missing `GITHUB_STEP_SUMMARY` | ignored | Refused. Asserted in `internal/runnotice` and in both `parseConfig` tests. |
| Unwritable summary file | ignored | `errSummaryWrite` with the underlying error, for an open failure and a write failure. |
| Line break in a published value | publishable | Refused for the summary and escaped for the annotation. |
| Percent sign in the annotation | literal | Escaped as `%25`, matching `.github/dist/build-lock.js`. |
| Reaper handle | run and issue title | Run id, delivery time, both configured thresholds, and the issue title, asserted as literals. |
| `node --test test/*.test.js` | 1004 | 1006 |

Red states observed before each implementation step: no summary file, no
annotation, a green run with an unwritable summary path, an unstated reason
published as a bare code, a missing `%` escape, and a computed expectation in the
reaper test that matched whatever `reaperHandle` returned.

## Verification

- `.devcontainer/scripts/verify.sh` exits 0. 1006 tests, 1000 pass, 0 fail, 6
  skipped by platform gate. All Go suites, `golangci-lint`, `shellcheck`,
  `actionlint`, `go vet`, and `go test -race` pass.
- Thirty-three mutations of the two monitors, `internal/runnotice`, the two
  documents, and the skill were each caught: skipping publication on any branch,
  ignoring a refusal exit code, dropping the reason code, dropping the handle,
  dropping the thresholds, hiding an open failure, hiding a rejected annotation
  stream, accepting a missing summary path, accepting an unstated reason,
  accepting a missing annotation stream, truncating the summary instead of
  appending, dropping the workflow command, annotating a clean conclusion,
  annotating a red run, announcing one meaning for every reason, escaping the
  summary, double-escaping the annotation, leaving the annotation unescaped,
  suppressing the classified reason, never reading the runner summary path,
  renaming a monitor, and dropping each documented claim.
- One mutation survives: removing the `.llm` skill sentence. No test pins agent
  prose. The harness checks the skill's structure, not its content, and the
  sentence is guidance for agents rather than a machine-checked contract.
- No credential, personal data, or live lock state appears in this record.

## Review rounds, and what each changed

Two independent adversarial reviews, then the Cursor Bugbot pull-request
review. The first reviewed the code. The second reviewed the class, the
documents, the progress requirements, and two of the first review's claims.

| Finding | Severity | Disposition |
| --- | --- | --- |
| An unset `GITHUB_STEP_SUMMARY` left a green run with nowhere to state its conclusion, and the runbook sentence was false. | blocker | An absent path is now a refusal, matching the `${GITHUB_STEP_SUMMARY:?}` rule the central audit scripts already follow. |
| A publication refusal returned before the classified reason, so a red incident-recovery run lost its root cause. | should-fix | The classified reason is stated on stderr before publication. |
| `runnotice` discarded the `*os.PathError`, so ENOSPC and EACCES read alike. | should-fix | The refusal wraps the underlying error. The runbook already promises a named cause. |
| `monitorMeanings`, the rendering, and the refusal line were duplicated in two `package main` trees. | should-fix | `runnotice` now owns the rendering. Each monitor keeps only its vocabulary and one thin wrapper. |
| The reaper test computed its expected handle by calling `reaperHandle`. | should-fix | Every expected line is a literal now. |
| The "no annotation on a red run" rule was asserted for only some reasons. | should-fix | Every reason of both monitors is a row in the annotation-count table. |
| `TestRunSucceedsAfterSynchronizingKnownAlert` asserted only that stderr contained `::warning::`. | should-fix | It asserts the whole stderr line, the whole summary line, and the whole stdout line. |
| `reasonEvidenceInvalid` said "history could not be read", which is what the other unreadable reason says. | should-fix | It now says the run evidence was refused, which is what the code did. |
| The threshold meanings named no value, so an operator could not tell 31 minutes from policy. | should-fix | The handle publishes both configured thresholds. |
| `README.md` claimed the warning always names the scheduled run, and `scheduled-run-missing` has none. | blocker | Corrected to "the scheduled run when it has one". |
| The runbook said "every reason code says what the conclusion means", but `run-notice-unpublished` is a run outcome with no meaning. | should-fix | Corrected to "every classified reason code". |
| The runbook's earlier paragraph still taught the old habit with no forward reference. | should-fix | It points forward, and a test pins that pointer. |
| `README.md` and the runbook claimed a failed run always publishes a summary line. The refusal and the invalid-configuration paths publish none. | minor | Both now say "when it could publish one" and name the refusal. |
| The reaper's credential-leak check read only stderr. | minor | It reads the summary too. |
| A refused lock state named its cause on stderr only. | minor | Declined. The run is red, the fixed fail-closed sentence carries the cause next to it, and a second text field on the notice would add a state to cover. The runbook sentence that over-promised is corrected instead. |
| The reaper had no assertion that a green branch withholds its stdout verdict until publication succeeds. | minor | Added, and the separate test it replaced is gone. |
| `runnotice` claimed the runner does not decode escapes in a command message, and a `%0A` in a value could forge a second workflow command. | should-fix | The claim was wrong. `actions/runner` decodes `%0D`, `%0A`, and `%25` in a command message, and `.github/dist/build-lock.js` already escapes for that reason. The annotation now escapes the percent sign, which also neutralises the two encoded forms, because a real line break is refused. |
| `summaryFileMode` was unasserted. | minor | The create test asserts the mode. |
| `runnotice` silently skipped the annotation when the stream was absent. | minor | An absent stream is now a refusal when a warning exists. |
| `plan.md` claimed this session with no record behind it. | blocker | This record. |
| The reaper's healthy meaning claimed "its run succeeded", but `classifyRuns` also returns healthy for a run still inside the run-duration threshold. Cursor Bugbot, on pull request 331. | should-fix | The meaning now says the run either succeeded or is still inside the threshold. |
| The reaper's missing-delivery meaning claimed stale build locks "are not being reaped". A manual reap is evidence too. | minor | It now says they may not be reaped on schedule, which matches the unsuccessful meaning. |

Two dispositions are recorded as declined with reasons rather than fixed:

- The scheduled reaper's summary (#328) and the release report (#330) are the
  same class in two other workflows. Both are filed with verified evidence
  rather than changed here. `build-lock.js` is the most safety-critical
  committed runtime in the repository and its holder path deserves its own
  review.
- The reaper writes its alert issue before it fails red (#329). That order is
  deliberate and has a test. It is recorded as a follow-up, and the run summary
  and the issue now both describe the same condition in one run.

## Known limits

- An annotation is published only for the conclusion that keeps the run green.
  A red run publishes its summary line and no annotation.
- A refused lock state publishes its reason code, not its cause. The cause is on
  the run log.
- `internal/runnotice` escapes the percent sign on the annotation only. A real
  line break is refused before the annotation is built, so the percent escape
  covers `%0D` and `%0A` as well.
- The reaper's handle publishes both configured thresholds on every alerting
  conclusion. That is one clause of repeated text per run.
- The two monitors share one package for rendering. They keep separate
  vocabularies, which are separate by design: their reason codes differ.
- #255 keeps its four open findings. This change only makes the run name them.
- #326 closes when this pull request merges.