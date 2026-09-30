# Session 115: keep each consumer's own repin comment spacing

Date: 2026-09-30

## Open-issue priority

The live inventory held 14 open issues and no open central pull request.

| Priority | Issues | Impact and boundary |
| --- | --- | --- |
| P0 selected | #307 | The central repin automation turned `unity-helpers` `main` red. The defect and its fix are central, and no licensed Unity job changes. |
| P0 | #51 | App and organization-secret scope needs an owner inventory and negative probes. |
| P0 | #44, #255 | Four live rulesets accept any source App. Binding the issuer changes merge policy, which this task forbids. |
| P0 | #83 | The central classifier fix shipped. Independent-seat and portal evidence need owner-authorized Unity operations. |
| P1 | #308 | The repin cannot carry `pin-literal` companions under `.github`, and does not move a checkout `ref:`. DoxReloaded adopts by hand meanwhile. |
| P1 | #278, #277 | Missing consumer test logs and absent canceller identity. Both need owner-run evidence. |
| P1 | #153, #229, #231, #249 | Native macOS and container return work needs reviewed authorization and licensed canaries. |
| P1 | #29, #53 | Lifecycle canaries, seven-day monitoring, and runner fairness need owner-run licensed operations and load evidence. |
| P2 | #126 | The reaper delivery alert. It self-resolved and no code defect was found. See below. |

Issue #307 is the highest-impact item with a safe central code action. It was
not a report of a cosmetic difference: the automation's own output left a
consumer default branch red.

## Root cause

Session 114's #283 fix made the rewrite write two spaces before every version
comment. That satisfies IshoBoy, whose `.yamllint.yml` sets
`comments: min-spaces-from-content: 2` at `level: error` and runs yamllint with
`-s`. It breaks `unity-helpers`, which runs Prettier over `.github/` and
asserts the `uses:` line with a literal single space in
`scripts/tests/test-unity-workflow-matrix-contract.ps1`.

The organization is not uniform. Every pin line in the six enrolled
repositories was read from the live default branches:

| Repository | Branch | Pin lines | Gap | What enforces it |
| --- | --- | --- | --- | --- |
| `DoxReloaded` | `main` | 12 | two spaces | yamllint `min-spaces-from-content: 1`; unenforced |
| `DxMessaging` | `master` | 34 | one space | yamllint `min-spaces-from-content: 1`; a contract test couples the width |
| `IshoBoy` | `main` | 22 | two spaces | yamllint `min-spaces-from-content: 2`, error level |
| `qora-redux` | `main` | 13 | two spaces | nothing |
| `unity-builder` | `main` | 0 | none | no lock pin exists |
| `unity-helpers` | `main` | 37 | one space | Prettier, plus a literal `String.Contains` |

A single canonical width therefore breaks one of them on every release.

## Change

`tools/workflows/repin-consumer-locks.sh`, `rewrite_pins`:

- A moved pin keeps the exact gap its own line already has.
- A moved pin with no comment takes the gap the repository's other workflow
  lock pins use. A `pin-lines` companion prefers its own file's gaps, because
  a documentation file has its own formatter.
- A repository whose lock pins carry no version comment, or more than one gap,
  fails closed and names the repository, file, and line.
- A gap is one or more spaces. A tab is not a gap: libyaml rejects one before a
  comment as a syntax error, verified with PyYAML and yamllint 1.38.0. Any other
  whitespace, including a non-breaking space, also fails closed. Copying such a
  gap is impossible and dropping it would fold `# vX.Y.Z` into the `uses:`
  value, after which the pin matches nothing on any later run.
- A workflow file with CRLF line endings is matched and rewritten with its
  terminator intact. Before this, `\r` defeated the pattern's `$` anchor, so
  the rewrite matched no pin at all: the run reported no change, closed its own
  offer as superseded, and left the consumer on a stale pin.
- A symlink under `.github`, and a `.github` that is not a directory, fail
  closed. A symlinked file was written through, outside the reviewed checkout,
  with a clean `git status`; a symlinked directory hid every pin inside it.
- A `repinExceptions` file is neither read nor used as gap evidence, so it can
  neither veto a consumer repin nor fail the read.
- Every write, workflow and companion alike, is buffered and flushed once. Only
  a workflow pin this rewrite removes may move inside a `pin-literal`
  companion, so a companion's own pin cannot license a reviewed witness to
  change or skip the stale-pin check.
- A companion path that cannot be read at all is not a missing companion. Only
  `ENOENT` is; anything else surfaces the filesystem error instead of offering
  a commit that omits a policy-required artifact.

## Verification

- `bash .devcontainer/scripts/verify.sh` passed: 946 Node tests, 940 pass, 0
  fail, 6 platform skips; every Go package, `go vet`, `go test -race`, both
  module checks, `golangci-lint`, actionlint, shellcheck, and the credential
  audit.
- Mutation testing killed 25 of 25 guards. Removing any one of the gap
  validation, the symlink refusals, the exception skip, the companion
  fallback, the write buffering for any of the three companion modes, the
  CRLF handling, the `pin-literal` snapshot, or the `lstatSync` code check
  fails at least one test.
- The gap validation was swept over the whole codepoint space. Every
  whitespace character the pin pattern accepts but `/^ +$/` rejects produces
  exit 1, a message naming the file and line, and a byte-identical checkout.
  Over 400 sampled space-and-tab gaps, the rewrite either reproduced the gap
  exactly or refused. It never emitted a gap outside `[ \t]+` in any run.
- Replay against the real default branches of all six repositories, with the
  production policy and target `84b8d875ab1968716ef95b5b56d10307609237ca`:
  `DoxReloaded` 12, `DxMessaging` 36, `IshoBoy` 22, `qora-redux` 13,
  `unity-helpers` 37, `unity-builder` 0. Every output was byte-identical to the
  live branch except for the moved pins and their version comments. A second
  run reported `changed: 0` for all five.
- Consumer gates on the rewritten trees: `yamllint` 1.38.0 with each
  repository's own configuration passed, and
  `npx prettier@3.9.9 --check '.github/workflows/*.yml'` with
  `unity-helpers`' own `.prettierrc.json` and `.prettierignore` passed.
- Control: the pre-change script on the same `unity-helpers` tree failed
  Prettier in three files and failed the `String.Contains` contract. That is
  #307 reproduced, and both gates pass on the fixed output.

## Review

Four independent adversarial sub-agent reviews ran against this branch. They
found 28 distinct issues, including two the author introduced while fixing
earlier ones: an empty `Set` is truthy in JavaScript, so the documented
companion-to-workflow gap fallback did not exist, and libyaml's treatment of a
tab before a comment contradicted the claim that a tab is a YAML separation
space. Every accepted finding is fixed, and every fix has a test that fails
when the fix is removed. Deliberately accepted and recorded: a
`pin-literal` stale SHA survives when a different workflow pin moved, because
a mechanical edit cannot tell a stale constant from a reviewed witness; the
embedded rewrite program is not linted by CI, and the one error the
repository's own ruleset reports there, an unused `lockPrefix`, is pre-existing
on `main`.

## #126

The reaper delivery alert was open and reporting `scheduled-run-overdue` with
a run from 2026-09-23 while fresh scheduled runs existed. A manual dispatch of
the same committed monitor reported `healthy`, named run `36674108834`, and
closed the issue. The audit reads the newest two scheduled runs and
reclassifies from that evidence alone, and a full read of the response body at
the same URL returned run IDs from 2026-09-23 before returning current ones
minutes later. The observed behavior is a stale read of the Actions API, not a
defect in the classifier: the monitor fails closed on evidence it cannot read,
which is its contract. No code changed for #126 and the issue closed itself.

## Scope

No licensed Unity workflow, lock configuration, credential, organization
policy, consumer file, or enrollment policy entry changed. The only files are
the repin script, its tests, two consumer documents, `PLAN.md`, and this
record.
