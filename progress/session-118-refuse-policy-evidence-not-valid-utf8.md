# Session 118: refuse policy evidence that is not valid UTF-8

Date: 2026-10-01

## Open-issue priority

The live inventory held 14 open issues and no open central pull request.

| Priority | Issues | Impact and boundary |
| --- | --- | --- |
| P0 selected | #314 | The enrollment and merge-policy audits decoded the reviewed policy, the expectations, and a consumer attestation with `encoding/json`, which substitutes U+FFFD. The fix is central, and no licensed Unity job changes. |
| P0 | #51 | App and organization-secret scope needs an owner inventory and negative probes. |
| P0 | #44, #255 | Four live rulesets accept any source App. Binding the issuer changes merge policy, which this task forbids. |
| P0 | #83 | Concurrent Unity returns report 400006 after a peer releases the shared seat. Needs owner-run licensed operations. |
| P1 | #278, #277 | Missing consumer test logs and absent canceller identity. Both need owner-run evidence. |
| P1 | #153, #229, #231, #249 | Native macOS and container return work needs reviewed authorization and licensed canaries. |
| P1 | #29, #53 | Lifecycle canaries, seven-day monitoring, and runner fairness need owner-run licensed operations and load evidence. |
| P2 | #126 | The reaper delivery alert. It self-resolved and no code defect was found. See session 115. |

#314 is the highest-impact item with a safe central code action. It is the
last part of the byte-safety sweep in #312: that session fixed the writers and
recorded the pattern, and this session closed the readers.

## The measured shape of the defect

Every result below was measured on `46b7e81e0`, the commit before this change,
by reverting only the five production files and running the new tests.

| Surface | Result with one `0xFF` byte |
| --- | --- |
| `audit-unity-enrollment --validate-policy-only` | Exit 0, "policy is valid". A corrupted reviewed policy was certified. |
| `ParseUnityEnrollmentRegistry`, exception `owner` | Accepted, no error. |
| `ParseUnityEnrollmentRegistry`, `repinExceptions` `reason` | Accepted, no error. |
| `ParseUnityEnrollmentRegistry`, `repinCompanions` `path` | Accepted, no error. |
| `ParseAttestation`, `rulesetName` | Accepted, no error, then compared with the live ruleset. |
| `ParseAttestation`, required context | Accepted, no error. |
| `ParseExpectations`, all five field classes | Refused, with a message that named the wrong cause. |
| `audit-merge-policy --validate-only`, both files | Exit 2, with a message that named the wrong cause. |
| `audit-merge-policy` live ruleset detail | Published `complete: true`, with one finding that named the wrong cause. |

Three of those rows are the wrong verdict, and they are the fields no
validator inspects. The rest were already refused, by an ASCII pattern, so the
guard only names the real cause. The tests record which is which, so a future
reader does not have to measure it again.

## Where the refusal belongs

The parsers own it: `ParseUnityEnrollmentRegistry`, `ParseExpectations`, and
`ParseAttestation`. Four commands read the reviewed policy and all four now
answer the same way, including the onboarding command that used to keep its own
copy of the check in `main.go`. One rule, one message.

`strictDecode` owns the response guard. All five of its callers already turn a
decode error into a named retrieval failure for the repository they were
reading, so the guard adds no new failure path.

## The sweep

Seven other Go read paths were checked and left alone, each for a stated reason
rather than by assumption:

- The YAML decoder refuses invalid UTF-8 itself. Measured:
  `invalid leading UTF-8 octet (value: 255)`. The enrollment analyzer and the
  credential audit therefore cannot substitute.
- `cmd/lock-recovery-audit` validates the lock name, the run identity, and the
  provenance text, then compares a digest it recomputes. A substitution breaks
  the digest comparison, so it fails closed.
- `cmd/sync-unity-enrollment-issue` and `cmd/sync-merge-policy-issue` validate
  every published field with an ASCII-anchored pattern before they write an
  issue body, so a substitution cannot reach a rendered value.
- `internal/githubissue` decodes GitHub responses only, and every field a
  caller publishes is pattern-validated afterwards.
- `cmd/workflow-credential-audit` matches an ASCII pattern against raw bytes.
  Go's regexp does not decode, so the bytes it sees are the bytes on disk.
- `internal/enrollment/git_snapshot.go` converts a path to a string and then
  uses the same string for `git show`, which fails and becomes a retrieval
  finding.
- `cmd/llm-skill-metadata` reads an editor request from standard input and
  returns no verdict.

## The limit this fix does not close

A byte check cannot see a JSON escape. `"\ud800"` is six valid ASCII bytes, so
`utf8.Valid` accepts the file, and the decoder substitutes U+FFFD because it
has no representation for that code point. Reproduced on `main` after the fix:
`onboard-unity-repository` reported the added repository, exited 0, and left
`ef bf bd` where the escape had been. Tracked as #316, and named in both
documents and in the byte-safety code sample.

## Verification

- `.devcontainer/scripts/verify.sh` exits 0: 974 tests, 968 pass, 6 skipped, 0
  fail, plus Go, race, vet, gofmt, golangci-lint, shellcheck, the JavaScript
  lint, the LLM harness, module verification, and the credential audit.
- Every new test was run against `46b7e81e0` and fails there. A partial fix was
  measured too: with the three parser guards reverted and the response guard
  left in place, both reviewed-file command tests still fail and the response
  test passes, so each test is bound to the guard it names.
- The three registry rows that no validator inspects assert the second half of
  the claim: the same file with the byte substituted parses cleanly. Without
  that assertion the table would only prove that the message wins an ordering
  race.

## Review rounds, and what each changed

| Finding | Disposition |
| --- | --- |
| The byte-safety code sample taught the removed caller-side guard and a message no tool emits | Fixed. The sample shows the parser, the reader list, and the 2026-10 evidence. |
| 11 of 15 table rows are refused by a second validator, so they only prove the message | Fixed. Each row records whether the substituted form still parses. |
| The fixture helpers corrupted JSON syntax when a fragment did not end in a quote, while the comment claimed the file stayed valid JSON | Fixed. Both helpers now fail loudly on invalid JSON. |
| The free-text `reason` field, the same class as `owner`, was not covered | Fixed. Added, with the substituted-form assertion. |
| The documents said every tool refuses the file, while a later shell step reads the expectations with `jq` | Fixed. Both documents now say each run validates the file before any later step reads it. |
| No record of the change existed | Fixed. This file. |

The first round also confirmed, with an independent mutation run, that no
fail-closed path was removed: the onboarding command's exit code is unchanged,
and no script, test, or document matched the old message.
