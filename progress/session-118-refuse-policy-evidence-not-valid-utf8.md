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

Every result below was measured on `46b7e81e0`, the commit before this change, by
reverting the production files this change touches and running the new tests.
Four of the seven carry these rows: the registry parser, the expectations
parser, the attestation parser, and the merge-policy response decoder.

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

Seven of those rows were the wrong verdict. They are the three places where a
tool certified, published, or accepted evidence it could not read: the
enrollment audit certified a corrupted policy as valid, the registry and the
attestation parsers accepted values no validator inspects, and the live response
decoder published `complete: true`. The other two rows name a field an ASCII
pattern already validates, so they were refused and the guard only names the
real cause. The tests record which is which, so a future reader does not have to
measure it again.

## Where the refusal belongs

The parsers own it: `ParseUnityEnrollmentRegistry`, `ParseExpectations`, and
`ParseAttestation`. Three commands and one library re-parse read the reviewed
policy, and all of them now answer the same way, including the onboarding
command that used to keep its own copy of the check in `main.go`. One rule, one
message.

`strictDecode` owns the response guard. All five of its callers already turn a
decode error into a named retrieval failure for the repository they were
reading, so the guard adds no new failure path.

## The sweep, and the two places it was wrong

Eight read paths were checked, in the entries below. The YAML entry covers two
tools. Five needed no change. The first version of this record got two more
wrong, and missed a third, and all three were real. Each was found by a review
round.

Checked, with the reason each one is already safe:

- The YAML decoder refuses invalid UTF-8 itself, for the enrollment analyzer
  and for the credential-literal audit's credential mode. Measured:
  `invalid leading UTF-8 octet (value: 255)`. The automation mode does not use
  it, and is listed below.
- `cmd/lock-recovery-audit` validates the lock name, the run identity, and the
  provenance text, then compares a digest it recomputes. A substitution breaks
  the digest comparison, so it fails closed.
- `cmd/sync-unity-enrollment-issue` and `cmd/sync-merge-policy-issue` validate
  every published field with an ASCII-anchored pattern before they write an
  issue body, so a substitution cannot reach a rendered value.
- `internal/githubissue` decodes GitHub responses only, and every field a
  caller publishes is pattern-validated afterwards.
- `cmd/llm-skill-metadata` reads an editor request from standard input and
  returns no verdict.

Wrong, and now fixed:

- `cmd/workflow-credential-audit` in its `unity-automation` mode matched a
  literal pattern against the file bytes. This record first claimed that Go's
  regexp does not decode. It does. Measured:
  `regexp.MustCompile("UNITY_SERIAL").MatchString("UNITY_\xffSERIAL")` is
  `false`. A consumer workflow whose only Unity literal carried one `0xFF` byte
  passed the audit, while the clean spelling fails it. The audit now refuses a
  file it cannot decode and names it.
- `internal/enrollment/git_snapshot.go` turned a tree entry name into a Go
  string. This record first claimed that the later `git show` fails. It does
  not. The corrupted path reached the published artifact, and the issue sync
  command then refused the whole artifact with a message that named neither the
  encoding nor the path, so one bad file name would have silenced the
  organization-wide drift alert. The snapshot now refuses that repository,
  which is the shape an operator can act on.

Missed, and now fixed:

- The same snapshot read blob content it never checked. A checked-in
  PowerShell script is scanned by matching literal needles, and
  `strings.ToLower` decodes UTF-8, so one raw byte inside a provisioning-control
  literal hid the finding. Measured:
  `strings.Contains(strings.ToLower(corrupt), "uh_ensure_editor_provisioning_budget_seconds")`
  is `false`, and `true` for the clean spelling. The snapshot now refuses a
  blob it cannot read exactly, which also covers the file the needle matched.

The transferable lesson is in the byte-safety code sample: a pattern match
decodes, so a scan that cannot read its input exactly is not evidence that it
found nothing.

## The limit this fix does not close

A byte check cannot see a JSON escape. `"\ud800"` is six valid ASCII bytes, so
`utf8.Valid` accepts the file, and the decoder substitutes U+FFFD because it
has no representation for that code point. Reproduced on `main` after the fix:
`onboard-unity-repository` reported the added repository, exited 0, and left
`ef bf bd` where the escape had been. Tracked as #316, and named in both
documents and in the byte-safety code sample.

A file that is valid UTF-8 but is not text is still judged by its own parsers,
as before.

## Verification

- `.devcontainer/scripts/verify.sh` exits 0: 974 Node tests, 968 pass, 6
  skipped, 0 fail, every Go package green, plus race, vet, gofmt,
  golangci-lint, shellcheck, the JavaScript lint, the LLM harness, module
  verification, and the credential audit.
- Every new test was run against `46b7e81e0` and fails there. A partial fix was
  measured too: with the three parser guards reverted and the response guard
  left in place, both reviewed-file command tests still fail and the response
  test passes, so each test is bound to the guard it names.
- Every table row asserts both directions. A field no validator inspects must
  still parse with the byte substituted; a field with a validator must be
  refused by it. Weakening one validator was measured: `validRefName` and
  `validActorType` each fail exactly the row that depends on them.
- The two refusals found in the second round were measured before the fix, not
  after: the `regexp` result above, and an end-to-end run of
  `workflow-credential-audit unity-automation` over a workflow holding
  `UNITY_\xffSERIAL`, which exited 0 while the clean spelling exited 1.
- The blob refusal found in the third round was measured the same way, with the
  `strings.ToLower` result above.

## Review rounds, and what each changed

| Finding | Disposition |
| --- | --- |
| The byte-safety code sample taught the removed caller-side guard and a message no tool emits | Fixed. The sample shows the parser, the reader list, and the 2026-10 evidence. |
| 11 of the 16 table rows are refused by a second validator, so they only prove the message | Fixed. Every row now asserts both directions. |
| The fixture helpers corrupted JSON syntax when a fragment did not end in a quote, while the comment claimed the file stayed valid JSON | Fixed. All three helpers now fail loudly on invalid JSON. |
| The free-text `reason` field, the same class as `owner`, was not covered | Fixed. Added, with both assertions. |
| The documents said every tool refuses the file, while a later shell step reads it with `jq` | Fixed. Both documents now name `jq` as a reader the run never reaches. |
| No record of the change existed | Fixed. This file. |
| This record claimed Go's regexp does not decode, and the Unity automation audit therefore cannot substitute | Wrong, and the claim hid a real fail-open. Fixed in the audit and in this record. |
| This record claimed a corrupted tree path fails at `git show` | Wrong. The path reached the artifact and the whole drift alert was silenced downstream. Fixed in the snapshot and in this record. |
| The snapshot read blob content it never checked, so one raw byte in a script literal hid a finding | Fixed. The snapshot refuses a blob it cannot read exactly. |
| A table row that depends on a validator was not pinned, so a weakened validator kept the test green | Fixed. Both directions are asserted, and the weakening was measured. |
| This record said four commands read the reviewed policy | Wrong. Three commands and one library re-parse. Fixed. |
| This record counted 15 table rows, and the sweep list did not match its own count | Wrong. Fixed here. |
| This record said three of the nine measured rows were the wrong verdict | Wrong. Seven were. The sentence named the free-text fields and missed the enrollment audit, which certified a corrupted policy, and the response decoder, which published `complete: true`. |
| The 15 mutated inputs in the sentence below were measured by a review round, not by this session | Corrected. The claim is attributed where it belongs. |
| A policy over the size bound and also not valid UTF-8 is refused on its size only | Accepted. Both refusals exit 2 and write nothing, so the bound is checked first, and the runbook now says so. |

The first round also confirmed, with an independent mutation run, that no
fail-closed path was removed: the onboarding command's exit code is unchanged,
and no script, test, or document matched the old message. The second review
round measured 15 mutated policy inputs on the base and on that branch, and no
input flipped from refused to accepted.

## Known limits, named in the documents

The credential-literal audit in its `unity-automation` mode is not described in
`docs/`, so its new refusal is recorded here and in the byte-safety sample
instead of a new section.

A refusal that lands on a consumer file names the repository and not the file,
so the finding-code row sends an operator to the consumer checkout. Naming the
file is #317.
