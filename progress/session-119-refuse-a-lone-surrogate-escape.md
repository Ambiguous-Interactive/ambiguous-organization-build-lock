# Session 119: refuse a policy that spells a value no decoder has

Date: 2026-10-01

## Open-issue priority

The live inventory held 14 open issues and no open central pull request.

| Priority | Issues | Impact and boundary |
| --- | --- | --- |
| P0 selected | #316 | The Go readers of a reviewed policy decoded an escaped lone surrogate into U+FFFD and returned no error. The onboarding command then wrote the substituted text back. The fix is central, and no licensed Unity job changes. |
| P0 | #317 | The enrollment drift issue does not name a file the audit cannot read. Follow-up from session 118. |
| P0 | #51 | App and organization-secret scope needs an owner inventory and negative probes. |
| P0 | #44, #255 | Four live rulesets accept any source App. Binding the issuer changes merge policy, which this task forbids. |
| P0 | #83 | Concurrent Unity returns report 400006 after a peer releases the shared seat. Needs owner-run licensed operations. |
| P1 | #278, #277 | Missing consumer test logs and absent canceller identity. Both need owner-run evidence. |
| P1 | #153, #229, #231, #249 | Native macOS and container return work needs reviewed authorization and licensed canaries. |
| P1 | #29, #53 | Lifecycle canaries, seven-day monitoring, and runner fairness need owner-run licensed operations and load evidence. |
| P2 | #126 | The reaper delivery alert. It self-resolved and no code defect was found. See session 115. |

#316 is the last part of the byte-safety sweep. Session 117 fixed the writers,
session 118 fixed the readers that begin with a byte the decoder cannot read,
and this session closed the one that begins with a byte it can read.

## The shape of the defect

A JSON string may spell any code point with `\uXXXX`. An unpaired surrogate
escape, such as `"\ud800"`, is six valid ASCII bytes, so the file is valid
UTF-8 and valid JSON, and the `utf8.Valid` check from session 118 accepts it.
Go has no value for that code point, so `encoding/json` writes U+FFFD and
returns no error.

`onboard-unity-repository` encodes the registry back into the file, so the
substituted text is committed inside a clean commit. Reproduced on `4948befe2`
with a copy of the reviewed policy: the run reported the added repository,
exited 0, and replaced six occurrences of the escape with `ef bf bd`.

## The issue proposed a check that cannot work

#316 offered two shapes and preferred the second: "refuse a decoded string that
does not round-trip, which is one rule for every reader and needs no escape
grammar."

That check cannot detect this. Measured:

| Input | Decodes | Decoded runes | Re-encodes to | Value round-trips |
| --- | --- | --- | --- | --- |
| `{"a":"\ud800"}` | no error | U+FFFD | `{"a":"<ef bf bd>"}` | yes |
| `{"a":"<ef bf bd>"}` | no error | U+FFFD | `{"a":"<ef bf bd>"}` | yes |

A substituted U+FFFD and a real U+FFFD are the same three bytes, so both
round-trip and the check passes on the defect. The loss happens inside the
decode, so a decoded value cannot report it.

So the guard reads the escape in the bytes, where a lone surrogate is a value
the decoder has no name for. This is the issue's first shape. The issue was
right that the rule belongs beside the encoding check and that one caller must
not keep its own copy; it was wrong about the check itself.

## Where the refusal belongs

`internal/jsonstrict` holds one exported function, `UnpairedSurrogateEscape`,
and four readers call it: `ParseUnityEnrollmentRegistry`,
`ParseExpectations`, `ParseAttestation`, and `strictDecode`. The first is read
by three commands, so four refusals answer for five entry points.

The guard runs after the decode. The decoder owns a malformed file and names
its syntax error, so a check placed earlier reports a cause the operator cannot
act on.

## The reader split, measured

#316 also claimed "the release authorization script checks the file bytes only,
so its decision reads the substituted text." That is wrong, and the first
version of this record repeated it. Measured on each reader:

| Reader | Input | Result |
| --- | --- | --- |
| `encoding/json` | `"\ud800"` | U+FFFD, no error |
| `encoding/json` | `"\udc00"` | U+FFFD, no error |
| `encoding/json` | `"\ud83d\ude00"` | one code point, correct |
| `JSON.parse` then `JSON.stringify` | `"\ud800"` | the escape, unchanged |
| `jq` | `"\ud800"` | parse error, exit 4 |
| `jq` | `"\udc00"` | U+FFFD, exit 0 |
| `jq` | `"\ud83d\ude00"` | one code point, correct |

A JavaScript string holds a lone surrogate, and `JSON.stringify` writes it back
as an escape. So the two Node writers, the release authorization and the
consumer repin, return the file unchanged. `jq` fails closed on an escaped high
surrogate and substitutes an escaped low one. Every workflow runs a Go refusal
before its first `jq`, so no `jq` step reaches such a file.

The Node result is not a copy of the input. The release authorization runs
`JSON.parse` and later `JSON.stringify`, so a measurement of the input alone
would have proved nothing. The test runs the real script and reads the pushed
policy as bytes.

## Verification

- `.devcontainer/scripts/verify.sh` exits 0.
- Every new test was run with the production guard reverted, and fails there.
  The end-to-end onboarding test reproduces the reported defect: exit 0, the
  repository reported as added, and the file rewritten.
- A differential test compares the guard with the decoder over 200000
  generated documents. The decoder damaged 156256 of them. The guard refused
  every one, and refused none of the 43744 the decoder read exactly. Run
  `go test -v -run TestGuardCoversTheDecoderLoss ./internal/jsonstrict/` to
  read the counts. The oracle is itself pinned in both directions, because an
  oracle that always returns false would also pass.
- The first version of that oracle was wrong four times, and each fault is
  recorded below. It compared a re-encoding against the input, which loses the
  escape. It tested for the presence of a real U+FFFD rather than counting, so
  one document that spelled a real U+FFFD hid a lone escape beside it. It
  listed five of the sixteen hex spellings of that escape. And it counted
  values but not keys, so a real U+FFFD in a key cancelled a loss in a value.
- The generated documents vary in shape as well as content: a value, a key, an
  array element, a nested object, and a string beside a number. The first
  version produced one shape only, so the oracle answered "no loss" for every
  other shape. That is the direction that hides a broken guard.
- Mutation: a guard that refuses every well-formed pair, and one that refuses
  every `\u` escape, both failed the suite. The first version of the table had
  no row for either class, so both mutations passed it.
- Mutation: moving the guard above the decode in all three parsers failed the
  suite. The first version asserted the ordering for one reader only.
- One mutation survived and is equivalent, not a gap. Returning the partner
  index one byte short resumes the scan on the last hex digit of a consumed
  pair, and no case matches a hex digit. Both forms agree on all 200000
  generated documents.
- The new Node test fails when the release script is given a lossy write-back,
  so it binds the claim it makes.

## Review rounds, and what each changed

| Finding | Disposition |
| --- | --- |
| The guard table had no row for a well-formed pair, so refusing every pair passed | Fixed. Four pair rows and an ordinary-escape row, and both mutations now fail. |
| The guard had no differential proof against the decoder | Fixed. 200000 documents, and the oracle is pinned both ways. |
| The ordering contract was asserted for one reader | Fixed. Each parser now asserts the decoder's message for a truncated file. |
| The same contract was still unpinned for `strictDecode` | The malformed input carried no escape, so it held at any position. Fixed: the input now carries one, and moving the guard above the decode fails the suite. |
| The oracle counted values but not keys | Wrong, and wrong in the direction that hides a broken guard. A real U+FFFD in a key cancelled a loss in a value. Fixed, and pinned. |
| The oracle listed five of the sixteen hex spellings | Wrong. Eleven spellings reported a loss that did not happen. Fixed by lowercasing, so no list can drift. |
| The oracle could not read an array, a nested object, or a non-string value | Wrong. It answered "no loss" for every shape it could not decode. Fixed, and the generator now produces seven shapes. |
| This record said the differential set damaged 159408 documents | Corrected to 156256. The number rose when the generator learned more shapes, and the earlier count covered one shape only. |
| This record said `jq` refuses such a file | Wrong. It refuses an escaped high surrogate and substitutes an escaped low one. Fixed in both documents and the code sample. |
| This record named one Node writer | Incomplete. The consumer repin reads the policy. It never writes it, so it is a second reader and not a second writer. Both are now named, and the record said which is which. |
| This record said "every workflow runs a Go refusal first" | Wrong. `auto-release.yml` runs no Go step. Corrected: every workflow that reads the file with `jq` runs one, which is the claim the ordering supports. |
| This record said four readers have no guard | Wrong count. Five files and six decode sites. #321 was corrected to the measured enumeration. |
| This record said "three readers" | Wrong count. Four readers answer, including the consumer attestation. |
| The `ParseExpectations` guard changes no verdict today | Accepted. Every field in that file already has a validator that rejects U+FFFD, so the guard is defence in depth there. The registry and the attestation each have free-text fields with no such validator, and those are the rows the tests show the guard closing. |
| The first oracle compared a re-encoding against the input | Wrong. Fixed, and the failure is recorded above. |
| The oracle tested presence rather than counting | Wrong. One real U+FFFD hid a lone escape. Fixed. |
| A mutation in the partner index survived | Not a gap. Equivalent, measured over 60000 documents. |
| The guard's message is discarded by all six `strictDecode` callers | Out of scope. Pre-existing, and now #320. |
| Six more JSON decode sites have no encoding guard at all | Out of scope. Each is fail-closed for a measured reason. Now #321. |
| The guard sits after the `schemaVersion` check, so a file with an escape and a wrong version names the version | Accepted. Both messages are true, the run fails either way, and the order keeps the schema error first. The documents say "by name", which holds for an otherwise valid file. |
| The three test helpers are duplicated across packages | Accepted. A shared test package is more scaffolding than the duplication costs. |
| The escape check needs `encoding/json/v2` | Rejected. That package is behind a build tag. The reference was used to check the guard, never to build it. |

## What a consumer repository gains

`ParseAttestation` reads a file a consumer publishes, so a consumer could
write this escape. It was the most exposed of the four readers, and the review
that flagged it is why it is in the change. The refusal names the cause, and
the finding code does not change, so the alert keeps its shape.

## Known limits, named in the documents

The four readers that have no encoding guard are listed in #321 with the
measured reason each one is still fail-closed.

The reason a retrieval failure reaches an operator is #320. Neither changes
this fix.
