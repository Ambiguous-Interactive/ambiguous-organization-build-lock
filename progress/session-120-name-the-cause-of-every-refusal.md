# Session 120: name the cause of every refusal

Date: 2026-10-01

## Open-issue priority

The live inventory held 14 open issues and no open central pull request.

| Priority | Issues | Impact and boundary |
| --- | --- | --- |
| P0 selected | #321, #320, #317 | The three refusals a reviewer could not act on. All central. No licensed Unity job changes and no consumer repository contract changes. |
| P0 | #51 | App and organization-secret scope needs an owner inventory and negative probes. |
| P0 | #44, #255 | Four live rulesets accept any source App. Binding the issuer changes merge policy, which this task forbids. |
| P0 | #83 | Concurrent Unity returns report 400006 after a peer releases the shared seat. Needs owner-run licensed operations. |
| P1 | #278, #277 | Missing consumer test logs and absent canceller identity. Both need owner-run evidence. |
| P1 | #153, #229, #231, #249 | Native macOS and container return work needs reviewed authorization and licensed canaries. |
| P1 | #29, #53 | Lifecycle canaries, seven-day monitoring, and runner fairness need owner-run licensed operations and load evidence. |
| P2 | #126 | The reaper delivery alert. It self-resolved and no code defect was found. See session 115. |

The three selected issues are one theme and one class. Session 118 refused
evidence that is not valid UTF-8. Session 119 refused an escaped lone
surrogate. Both sessions left the refusal where it stops: six readers had no
guard, and the two audits threw the cause away on the way to the operator.
This session finishes the class.

## One rule, one order

`internal/jsonstrict` gains `Unrepresentable`, which answers both doors, and
`Refusal`, `Label`, and `Reason`, which keep the cause recoverable through a
wrapping `%w`. `SanitizeCause` maps every rune outside `CauseAlphabet` to `?`.

Every one of the nine JSON decode sites now calls it, in the same place:

| Step | 1 | 2 | 3 | 4 |
| --- | --- | --- | --- | --- |
| | size bound | decode | trailing value | **guard** |
| then | every content check | | | |

The guard sits after the decoder and before every content check. That order is
the whole contract:

- A malformed document keeps the decoder's own message, which names a cause
  the operator can act on.
- A document the decoder read but could not represent is refused as unreadable,
  so no value in it ever reaches a comparison, a digest, or a verdict.

This session **moved** the encoding arm. Before it, `utf8.Valid` ran before the
decode and the escape guard ran after the schema check. Session 119 accepted
that split and recorded it. This session put both arms after the decode and
before every content check, and it changed a message. Measured on
`ParseExpectations`:

| Input | Before this session | After |
| --- | --- | --- |
| invalid UTF-8 and `schemaVersion: 9` | `are not valid UTF-8` | `is not valid UTF-8` |
| `\ud800` and `schemaVersion: 9` | `schemaVersion must be 2` | `is an escaped lone surrogate ...` |

The first row is a fix: a file nobody can read is not a schema problem. The
second is a deliberate change and it is the better answer for the same reason.
Both fail closed either way. Session 119's record is left as written; this
record is where the decision moved.

Both arms now carry a row in every "keeps the decoder's message" table. Before
this session only the escape arm did, so moving `utf8.Valid` back above the
decode kept the whole suite green. Measured after the fix: the mutation fails
`TestUnityEnrollmentRegistryNamesTheSyntaxErrorForAMalformedFile`, the same way
the escape mutation already did.

## What a consumer repository gains

`ParseAttestation` reads a file a consumer publishes. Its cause now reaches the
issue table in the Detail column, because that consumer is the one who has to
change the file. Before, every one of its nineteen refusal sentences collapsed
into one generic sentence, so a consumer who published a file with a stray byte
republished it unchanged.

## What an operator gains

| Channel | Before | After |
| --- | --- | --- |
| Merge-policy finding | code only | code, cause, and the read that failed |
| Merge-policy attestation | one generic sentence | the cause, when there is one |
| Unity enrollment finding | code only | code, cause, and the file |
| Run summary | counts only | counts and a bounded cause table |
| Lock recovery stderr | `lock-state-invalid` | `lock-state-invalid (lock state is not valid UTF-8)` |

A cause is bounded to 256 bytes and mapped to a fixed ASCII alphabet, so it
cannot break a table row or carry text nobody wrote. A finding with no cause has
no row in the run summary, which is deliberate: a cause means the audit could
not read its evidence, which is a different problem from evidence that failed a
rule.

## Review rounds, and what each changed

| Finding | Disposition |
| --- | --- |
| `ReasonLoneSurrogateEscape` held a comma, so `causePattern` rejected it and the issue sync refused the whole artifact | Fixed. The reason was reworded to a clause the alphabet accepts. `TestEveryPublishedCauseIsPublishable` runs the shipped `causePattern`, and `TestEveryPublishedEnrollmentCauseIsPublishable` runs the shipped `causePattern` too, over unsanitized strings. Re-inserting the comma fails both. |
| The encoding arm's ordering was unpinned | Fixed. An unreadable-byte row sits beside every escape row in every parser, the `githubissue` client, both `readAudit` tables, the skill metadata reader, and the lock state reader. The guard-above-the-decode mutation now fails each of them. |
| The "guard before every content check" half of the order was unpinned | Fixed. One row per parser feeds a damaged document whose `schemaVersion` is also wrong, and asserts the encoding refusal wins. Moving the guard back below the schema check now fails all three. |
| The enrollment publishability test sanitized first and re-derived the pattern, so it could not fail | Fixed. It runs the shipped `causePattern` over the unsanitized strings, and it asserts a raw hostile path is refused while its sanitized form is accepted, so the sanitizing rule is shown to be load bearing. |
| `UnrepresentableError` had an exported `Reason` field any caller could set to a published value | Fixed. The field is unexported. The only ways to build the error are `Refusal`, `Label`, and `UnrepresentableErrorf`, and all three build it from the two reason clauses and a reader name. Every reader name is pinned against every publishing validator. |
| `SanitizeCause` was load bearing only on the enrollment paths, and the merge-policy call sites were unpinned | Corrected. It now runs only where hostile text exists, which is the enrollment retrieval and analysis paths. Both are pinned: a raw byte in a tree name, and a job name holding a pipe and a backtick. Removing either call fails its test. |
| Six places said a cause always means an unreadable file | Corrected. The Unity enrollment audit publishes a cause for a refused commit, a refused origin, and a rule a consumer workflow broke. Every one of those places now says to read the reason code before the cause, and the `repository-analysis-incomplete` row was updated with the remedy it now reports. |
| `docs/operations-runbook.md` claimed every refusal names a cause | Fixed. The runbook now names the refusals that carry a cause and lists the ones that do not. |
| The docs and both shell comments claimed the cause is sanitized. The merge-policy path only truncated | Fixed. `jsonstrict.SanitizeCause` is now the single sanitizing rule, both audits use it, and both validators use its alphabet. The duplicate sanitizer in `internal/enrollment` is gone. |
| `BoundDetail` only truncates, and the docs claimed a sanitizing rule that did not exist for the merge-policy path | Fixed. `SanitizeCause` now runs where hostile text exists, which is the enrollment retrieval and analysis paths, and the merge-policy type can no longer be built with a value nobody checked. |
| `ParseUnityEnrollmentRegistry` was still shown with the check above the decode in the byte-safety sample | Fixed. The sample now shows the guard after the decode. |
| `TestEveryPublishedCauseIsPublishable` re-derived the pattern instead of using the shipped one | Fixed. It uses `causePattern`. The same test in `cmd/audit-merge-policy` cannot, and it says so. |
| The enrollment end-to-end test damaged a script body, so its alphabet assertion passed for a sanitizer that did nothing | Fixed. A second row commits a git tree entry whose name holds a raw byte and whose mode is not a regular blob. The snapshot reader reports that name with `%s`, so the byte reaches the cause raw. Reverting `SanitizeCause` now fails this test. |
| `internal/jsonstrict/**` was missing from both audit workflow path filters | Fixed, with a test that reads the filters. A commit confined to the guard would have left both audits on the old behaviour. |
| `internal/githubissue` echoed response bytes into the error chain | Fixed. The message is fixed again. This is the one reader of a response nobody here controls, and a JSON syntax error quotes a byte from it. |
| The merge-policy issue body said it holds reason codes only | Fixed. It says what it holds now, and says a cause carries no live text. |
| A stale `reason` parameter on the publishability helper | Fixed. The helper takes the cause only. |
| `firstNonEmpty` had one call site | Fixed. It became `attestationRefusal`, which also carries the comment explaining why the cause wins over the generic sentence. |
| `UnpairedSurrogateEscape` had no out-of-package caller | Accepted. It stays exported and its comment says callers use `Unrepresentable`. The code sample and the oracle test both name it, and unexporting it would make the documented primitive unnameable. |
| The `record_causes` table is duplicated in both workflow scripts | Accepted. Every workflow script here is standalone on purpose, and `record_counts` is already duplicated the same way. |
| `Unrepresentable` could not state that the caller must discard the decoded value | Fixed. It says so. All nine sites do, and a caller that logs past the guard is a fail-open nothing can repair afterwards. |
| `json.Unmarshal` is stricter than the decoder it replaced in the skill metadata reader | Accepted. It refuses trailing data, which the decoder accepted. The harness never sends trailing data. |
| The run summary listed a cause only from the merge-policy shape | Fixed for the first two runs of each script. The bounded-table run uses one fixed cause for both scripts, so that one block still does not exercise each script's own alphabet. |
| No cause is published for an HTTP status, a pagination guard, a size bound, a duplicate identity, or a decoder syntax error | Accepted. Each has a reason code and its own message. The runbook names them. |

## Verification

- `.devcontainer/scripts/verify.sh` exits 0.
- Every new test was run with the production guard or sanitizing rule reverted.
  Removing a guard fails its own table. Moving a guard above the decode fails
  the ordering row at that site. Moving any parser's guard back below its
  `schemaVersion` check fails that parser's new row. Removing either
  `SanitizeCause` call fails the enrollment test for that path. Re-inserting the
  comma into a reason fails both publishability tests. Removing
  `internal/jsonstrict/**` from a workflow path filter fails the filter test.
  Removing `record_causes` fails the node test.
- The 200000-document differential oracle from session 119 still passes. It
  drives `UnpairedSurrogateEscape`, the escape primitive, so it pins that half of
  the rule only. The encoding half is a `utf8.Valid` call, which the oracle does
  not reach.

## Known limits, named in the documents

The refusals that carry no cause are listed in the operations runbook. The
cause field is added to both audit artifacts, so a consumer that pins an older
`sync-*-issue` binary would refuse an artifact it did not write. Neither
command is a published action with a version pin; both are run by the central
audits, which ship together.