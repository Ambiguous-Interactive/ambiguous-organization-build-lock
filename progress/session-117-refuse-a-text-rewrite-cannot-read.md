# Session 117: refuse a text rewrite that cannot read the file

Date: 2026-10-01

## Open-issue priority

The live inventory held 13 open issues and no open central pull request.

| Priority | Issues | Impact and boundary |
| --- | --- | --- |
| P0 selected | #312 | `rewrite-pins` decoded every workflow and companion as UTF-8 and wrote it back. A byte it could not decode became U+FFFD. The fix is central, and no licensed Unity job changes. |
| P0 | #51 | App and organization-secret scope needs an owner inventory and negative probes. |
| P0 | #44, #255 | Four live rulesets accept any source App. Binding the issuer changes merge policy, which this task forbids. |
| P0 | #83 | Concurrent Unity returns report 400006 after a peer releases the shared seat. Needs owner-run licensed operations. |
| P1 | #278, #277 | Missing consumer test logs and absent canceller identity. Both need owner-run evidence. |
| P1 | #153, #229, #231, #249 | Native macOS and container return work needs reviewed authorization and licensed canaries. |
| P1 | #29, #53 | Lifecycle canaries, seven-day monitoring, and runner fairness need owner-run licensed operations and load evidence. |

#312 is the highest-impact item with a safe central code action. #126
self-resolved and no code defect was found in it. See session 115.

## The shape of the defect

`readFileSync(path, "utf8")` replaces every byte Node cannot decode with
U+FFFD, which is three bytes long. A rewrite that reads such a file and writes
it back therefore destroys a byte the pin does not name, grows the file, and
reports only the pins it moved. The run exits 0.

Measured on `main` before the change: a `pin-lines` companion of 173 bytes came
back as 175, with `0x89` replaced by `ef bf bd`.

The sweep for the same class found six read-modify-write round trips and three
true corruption paths, not one:

- `repin-consumer-locks.sh`: workflows, and all three companion modes.
- `open-release-authorization-pr.sh`: the reviewed central policy, committed
  into the authorization pull request.
- `onboard-unity-repository`: the same policy, through `encoding/json`, which
  documents that it substitutes U+FFFD rather than failing. An atomic rename hid
  the result inside a clean-looking commit.
- `build-lock.js`: the lock state, decoded, reshaped, and encoded again.
- `llm-harness.mjs`: the credential scan on `progress/` records. A substitution
  breaks the literal pattern, so it suppressed the finding.

## Two decisions, and why

**Fail closed, not byte-preserve.** Refusing a file the rewrite cannot read is
the answer the rewrite already gives a symlink, a directory and an unreadable
parent. Silently preserving the bytes would keep a file the rewrite cannot
understand in the offer, which this rewrite has never done with anything else.

**Refuse only a file the rewrite would write.** A workflow with one Latin-1
byte and no pin was read, changed nothing, and was never written, so it could
not lose a byte. The first version of this change refused it anyway, which a
review round caught. That scope had no escape hatch: a `repinExceptions` entry
reaches neither a companion nor a workflow outside `.github/workflows`, so one
unrelated file would turn every scheduled repin for that repository red. The
exact decode now runs when a file is queued for writing, before the flush
loop, so a refusal is still atomic across the whole checkout.

## The byte order mark

Two facts about `TextDecoder` decide this, and both were measured:

- the default strips a leading U+FEFF, so a naive strict decoder trades one
  destroyed byte for another;
- `readFileSync` does not strip it, so a pin on the first line of a file the
  mark opens matches no pattern, the rewrite reports the repository already
  pinned, and the stale pin has no evidence against it.

The mark is therefore read aside as the run of marks a file opens with, and
written back beside the text. A key pattern never sees it and the file keeps
it.

The central policy writers do the opposite, on purpose. A mark is invalid JSON
and Node and all three Go analyzers reject one, so carrying it there would make
a case that used to fail now succeed, and commit a policy the repository's own
audits refuse on the next run.

## Verification

- `.devcontainer/scripts/verify.sh` exits 0: 970 tests, 964 pass, 6 skipped, 0
  fail, plus Go, race, vet, gofmt, golangci-lint, shellcheck, the JavaScript
  lint, the LLM harness, module verification and the credential audit.
- Every new test was run against the base commit `6222c44b4` and fails there.
  Two tests were also run against a partial fix: removing the second policy
  check in the authorization script, and the base lock state decoder, each
  makes exactly one test fail.
- A second reviewer swept 20 byte shapes across the four write surfaces. The
  output equals the input apart from the pin bytes and the version comment.

## Three review rounds, and what each changed

| Finding | Disposition |
| --- | --- |
| The refusal covered every file read, not every file written | Fixed. The scope is now the files the rewrite would change. |
| Carrying a mark into the policy made a failing case succeed | Fixed. The policy writers leave a mark in place. |
| `auditProgressRecords` lost a credential finding to one stray byte | Fixed. The scan decodes strictly and names the file. |
| The authorization check ran before the checkout that replaced the file | Fixed. The check runs before the decision and after the checkout. |
| A missing policy was reported as "not valid UTF-8" | Fixed. The read is outside the guard. |
| The lock state round trip was not in the first sweep | Fixed. `readState` decodes strictly. |
| `ignoreBOM` was inert in two of three uses | Fixed. The load-bearing one says why it is there. |
| The documentation promised a byte-exact round trip for `policy-snapshot` | Fixed. The mode generates the document, and the docs now say so. |
| The documentation promised a byte-exact file for a NUL byte | Fixed. A NUL byte does not refuse the file, and comes back with the rest. |
| The second policy check had no test | Fixed. The test advances the remote branch after the clone. |
| A `policy-snapshot` mark was the one untested fix | Fixed. The round-trip test covers one mark and two. |

## Known limits, named in the documents

A file that is valid UTF-8 but is not text is still rewritten. A NUL byte is
accepted. `readLockConfig` and the editor diagnostics read lossily and never
write the file back, and both already fail closed through their own parsers.
