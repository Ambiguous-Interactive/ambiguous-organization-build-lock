# Session 029: incident recovery visibility

## Scope and hypothesis

On 2026-07-29, review every open issue and pull request, prioritize impact
while minimizing licensed Unity CI churn, and complete the selected work
without changing organization policy, live lock state, or incident recovery
semantics.

Hypothesis: the manual half of issue #132 is caused by a fail-closed state that
never expires and can only be cleared with an exact identifier that lives in a
branch an operator must open by hand. A scheduled read-only monitor can prove
that identifier from committed state and publish it, with the declared recovery
inputs, in one deduplicated alert. That removes the lookup without weakening
any fail-closed path and requires no consumer re-pin, so no licensed Unity CI
run is needed.

Disconfirming evidence would be a published alert that lets recovery proceed
without the exact identifier or portal proof, an alert whose instructions the
recovery workflow cannot accept, ambiguity that silently closes an alert,
credential or evidence-digest exposure, or a required consumer change.

Safety invariants:

- Global incident recovery still requires the exact incident ID and explicit
  portal-cleanup proof.
- Admission, queue, holder, reservation, schema, and compare-and-swap behavior
  do not change.
- The monitor never writes lock state and holds no writer, reader, or Unity
  credential.
- Unprovable evidence never opens, edits, or closes the published alert.
- Published evidence excludes credential values, raw logs, and the incident
  evidence digest.

## Issue and pull-request inventory

The clean checkout started at `91a430557`, equal to `origin/main`. The GitHub
REST API returned 14 open issues and no open or draft pull requests. Push
Build lock CI run `30418244948` passed on that exact commit.

| Priority | Issues | Disposition |
| --- | --- | --- |
| P0 | #132 | Selected. Recovery ergonomics is the freshest user-reported defect and its visibility half is a bounded, fail-closed, central-only correction with zero licensed Unity CI churn. |
| P0 | #51, #83, #113 | Critical security, entitlement, and enrollment findings whose completion requires prohibited organization-policy changes, multi-repository remediation, or Unity portal evidence. |
| P1 | #44, #53 | Truthful merge gating and pre-runner FIFO fairness require consumer ruleset work or a new multi-repository admission protocol. |
| P2 | #49, #99 | Throughput work requires exhaustive consumer timing, retry, and compatibility-policy evidence. #129 already advanced the acquire-polling portion of #99. |
| Operational | #27, #29, #30, #54 | Coupled monitoring, tracker, portal, and paid-canary work gated on a seven-day observation window rather than a bounded central correction. |
| Stale/blocked | #60 | Literal zero remains intentionally blocked by #83; current config stays at one second. |
| Upstream blocked | #94 | actionlint v1.7.12 remains latest and still selects yaml/v4 rc.3; the production module is already on latest rc.6. |

Dependency inspection found no actionable update. `go list -m -u all` reported
no newer version for the root module. The isolated actionlint module reports
goldmark, x/net, and yaml/v4 rc.6 updates that are unused transitives of the
pinned linter; `go mod tidy` does not retain overrides for them and #94
explicitly rejects adding direct ones. No Dependabot pull request is open.

Only the visibility half of #132 is delivered. Seat-availability probing and
automatic incident recovery need licensed Unity evidence that this session
cannot produce, and are recorded as explicit follow-up rather than being
guessed at.

## Baseline and red-green evidence

Baseline on `91a430557`: `.devcontainer/scripts/verify.sh` passed with 599 Node
tests, all Go packages, actionlint, both module gates, and the credential
audit. The only path to an active incident identifier was reading committed
`lock-state` JSON by hand, which is exactly the manual workflow #132 reports.

The regression first failed with:

```text
cmd/lock-recovery-audit/main_test.go:30:24: undefined: incident
cmd/lock-recovery-audit/main_test.go:38:3: undefined: incidentReason
```

Green adds `cmd/lock-recovery-audit`, one least-privilege scheduled workflow,
and contract tests binding the published instructions to the declared recovery
workflow.

Cross-runtime digest parity was verified empirically rather than assumed. The
committed JavaScript `incidentEvidenceDigest` and the Go monitor produced
identical SHA-256 values for live-shaped, HTML-character, non-ASCII, and
escape-character provenance. Those runtime-produced digests are pinned as Go
regression vectors, which binds the monitor against its own past output. That
alone would not have caught the runtime changing its digest input, so a contract
test additionally binds the monitor's digest field list and order to the
runtime's `incidentEvidenceDigest` literal.

The GitHub contract was verified against the live public repository rather than
inferred: the raw contents request returns HTTP 200 with
`application/vnd.github.raw` and a body that parses as the state file itself
rather than an API envelope. A temporary probe confirmed that the monitor
classifies the current committed state without ambiguity; the probe was
removed and no state values were retained.

The committed runtime writes `reportedAt` from `Date#toISOString`, which
includes milliseconds. The first fixture used whole seconds and therefore never
exercised the real shape. Go's RFC3339 parse was measured against both forms
before the fixture was corrected to the real one.

## Swept failure mode: unbounded issue-discovery responses

Measuring the alert-discovery request against the live repository exposed a
latent defect of the same class in existing production code. One
`state=all&per_page=100` page currently returns 837,658 bytes, of which only
268,666 bytes are issue bodies; the remaining ~5.7 KiB per issue is fixed API
envelope. `cmd/sync-unity-enrollment-issue` bounded that response at 1,048,576
bytes, so it was running at roughly 80% of a hard limit whose breach makes the
daily enrollment audit fail red and stop synchronizing its drift issue. The
page always holds the newest 100 issues, so the size is driven by body growth
rather than total issue count, but a single 60-KiB-capped alert body plus normal
variance is enough to cross it.

Raising the limit alone would only defer the failure, so the page size became
the bound: discovery requests 30 issues per page against a 4 MiB response
limit. GitHub caps an issue body at 64 KiB, so a full page cannot exceed roughly
2 MiB however large the history grows. `cmd/reaper-delivery-audit` had the same
shape with more headroom and was aligned. Each affected tool gained a regression
that walks multiple pages of maximum-size issues and asserts the response stays
inside its bound.

Bounding each response did not bound the walk itself, which is the defect Cursor
Bugbot found next and which the reviewer round below records.

## Validation, review, and delivery

Fresh complete local verification passed:

```text
.devcontainer/scripts/verify.sh
LLM harness checks passed.
tests 604; pass 604; fail 0
all Go packages passed
all modules verified
Workflow credential-literal policy passed.
```

`go test -race ./cmd/lock-recovery-audit`, `gofmt -l`, `go vet`, and
`git diff --check` also passed.

## Independent review round 1

Implementer: root agent. Reviewer: independent adversarial sub-agent
`issue132_review`, given the diff, the safety rules, and an explicit brief to
find unsafe success paths, untrusted-input vectors, Go/JavaScript divergence,
GitHub contract errors, and bloat. It re-ran the full suite and verified the
GitHub contract and the pinned digest vectors independently. Verdict: blocking.
Every finding and its disposition:

| Severity | Finding | Disposition |
| --- | --- | --- |
| P0 | A `go build` without `-o` left an 8.7 MB executable at the repository root and `git add -A` tracked it. | Fixed. Untracked and removed, root binaries ignored, and a policy test now rejects any tracked ELF/PE/Mach-O file. The test was proven red against a real executable before being accepted. |
| P1 | Treating a foreign-authored marker issue as fatal let any user of this public repository permanently suppress incident publication. | Fixed. Authorship became a match condition, matching the sibling monitor: a lookalike is ignored and the automation publishes its own alert. |
| P1 | No HTTP or context timeout; a stalled request would consume the whole job budget while the next run could not replace it. | Fixed. Explicit per-request and whole-audit deadlines. |
| P1 | Rejecting a backtick, pipe, or long name classified a genuinely provable incident as unprovable, so the alert would never open. | Fixed. Validation now rejects only what makes evidence unprovable; rendering escapes and truncates instead. |
| P1 | The task record cited review evidence that did not exist in the referenced progress log. | Fixed by this section. |
| P2 | Exact-title matching orphaned a renamed alert and could wedge the audit on a rename-back. | Fixed. Identity is marker plus authorship; the title is restored by the update. |
| P2 | Offset pagination over a newest-first list could skip an alert and publish a duplicate. | Fixed, but the first fix and its stated rationale were both wrong. Ascending order stabilized offsets yet made every run walk the whole issue history, which Cursor Bugbot then found. The rationale for rejecting the reviewer's `Link` suggestion was false: measured against the live API, `/issues` `rel="next"` carries an opaque `after=` cursor, so Link traversal is cursor-based and would have avoided both the race and the history walk. The accepted fix is server-side `creator` scoping, which also bounds the walk. Two monitors now use page offsets and one uses Link cursors; that divergence belongs to #140. |
| P2 | Nothing bound the monitor's schema ceiling or incident field set to the committed runtime, so a future runtime change would silently stop publication. | Fixed. A contract test binds both, proven red against a bumped ceiling and a removed field. |
| P2 | Failure diagnostics collapsed distinct causes into two strings, and a size bound was checked before the status code. | Fixed. The sanitized error class is reported and status is checked first. |
| P2 | The GitHub client is a third copy of an existing one; the duplication itself produced several of these findings. | Accepted, deferred. The argument is sound, but extracting a shared package rewrites three production monitors and belongs in its own reviewed change rather than in a recovery-visibility PR. Filed as follow-up. |
| P3 | `runnerId`, `incidentId`, and `evidenceDigest` were not trimmed before digesting, unlike the runtime. | Fixed. Trimming now mirrors `normalizeIncident`. |
| P3 | An epoch-zero timestamp was accepted although the runtime treats it as absent. | Fixed. |
| P3 | The state's own `lock` field was never checked against the requested lock. | Fixed. |
| P3 | `origin()` rejects an API URL with a path, unlike the runtime. | Rejected with evidence. The request builder resolves root-anchored paths, so accepting a path-bearing API URL would silently drop it. Failing closed on an unsupported deployment is correct. |
| P3 | `TrimRight` over-trims relative to the encoder contract; a UTF-8 guard was dead after JSON decoding. | Fixed. `TrimSuffix` and the dead guard removed. |
| P3 | A permanent operational alert cited `#132`, which will close. | Fixed. Removed from the alert body. |
| P3 | The alert marker is not lock-scoped. | Rejected with evidence. One lock exists and its name is a required flag; scoping the marker now would be speculative. |
| P3 | An unreachable same-origin check in the request builder. | Kept as defense in depth for future call sites. |

The reviewer independently confirmed no unsafe success path, no Markdown or link
injection vector, correct GitHub API usage verified against the live repository,
and that the pinned digest vectors are genuine cross-runtime evidence. It also
confirmed the 1 MiB discovery bound this session had already fixed, having
measured the same 837,658-byte page independently.

## Automated reviewer round

Cursor Bugbot reviewed exact head `5d145f1de` and reported one high-severity
finding: ascending-order discovery walked the repository's entire issue history
and stopped at the page budget, so once the history exceeded that budget an alert
created later would never be found. The finding was correct, and it was a
regression introduced by the round-1 remediation that made offsets stable.

Raising the budget would only defer it, so discovery is now restricted
server-side to the issues this automation created. The filter was verified
against the live repository before being adopted: `creator=github-actions[bot]`
returns exactly the two bot-authored issues rather than the full history. The
walk is therefore bounded by this automation's own output instead of by
repository activity, and remains ascending so offsets stay stable.

Sweeping that fix exposed a further defect in existing production code:
`cmd/sync-unity-enrollment-issue` matched its alert on the marker alone, with no
authorship condition. Its marker is published in the public alert body, so an
outsider could post a lookalike and have it adopted and overwritten, or post two
and stall synchronization. Authorship is now part of that alert's identity, as it
already was for the reaper monitor. Existing fixtures failed on the new condition
until they carried an author, which confirms the check is real rather than
tautological, and a regression now proves a foreign lookalike is ignored without
stalling discovery.

GitHub Copilot was requested through the reviewer API and returned quota
exhaustion without code feedback, as in the preceding sessions.

## Independent review round 2

A second independent adversarial sub-agent reviewed the remediated diff with the
round-1 dispositions in hand and an explicit brief to verify each remediation
empirically rather than by reading the record. It confirmed the history rewrite,
re-rendered the alert's escaping through GitHub's own Markdown renderer, and
measured Go against Node for control-character parity. Verdict: blocking.

| Severity | Finding | Disposition |
| --- | --- | --- |
| P1 | The runtime-binding contract test bound the schema ceiling and the incident field names, but nothing bound the digest input's field list and order. A runtime change there would classify every real incident as unprovable, leaving the audit red and the alert unopened, with the whole suite still green. The progress record asserted protection that did not exist. | Fixed. The contract test now binds the digest field list order-sensitively, proven red by reordering two fields. The record claim is corrected. |
| P2 | Creation was not self-verifying. If the discovery filter ever stopped matching, the audit would publish a new alert every ten minutes and exit zero: an unbounded write with no operator signal. | Fixed. Publication re-runs discovery and fails red unless it finds exactly what it created, with a regression that simulates a filter that stopped matching. |
| P2 | The round-1 rejection of the reviewer's `Link` suggestion rested on a false technical claim. | Fixed. Measured against the live API and corrected in the round-1 table; the divergence between the two pagination strategies is recorded for #140. |
| P3 | `provableText` rejected U+007F although both runtimes encode it identically, so a provable incident could be classified unprovable. | Fixed. Measured Go against Node for U+007F, U+0008, U+000C, and U+2028; only U+2028/U+2029 diverge. DEL is accepted and the comment now states the real reasons. |
| P3 | The tracked-binary guard scanned only the current tree, so the very commit it was written for would have passed it. | Fixed. It now also walks blobs introduced by each branch commit, proven red against a binary added and then deleted in history. |
| P3 | The table-integrity assertion counts characters and cannot detect a cell split; no backslash-bearing input was covered. | Fixed. Pre-escaped pipe, trailing backslash, and long backtick-run cases were added with exact expected cells. |
| P3 | No test asserted the stable ordering parameters, so dropping the round-1 fix would pass. | Fixed. |
| P3 | Two permanently-red terminal states had no operator procedure. | Fixed in the runbook. |
| P3 | Stale contract numbers in the task record and stale claims in the progress record. | Fixed. |
| P3 | The alert issue's decoded title is never read. | Fixed. Removed. |
| P3 | Duplicate handling now diverges across the three copies. | Accepted, deferred to #140 with the other divergence. |

The reviewer independently confirmed the two round-1 findings rejected with
evidence, and confirmed that deferring the shared-client extraction does not
block while noting that this change is the strongest argument yet for doing it.

## Delivery evidence

Before the branch was pushed, the round-1 P0 build artifact was removed from the
branch history rather than only from the working tree: the middle commit was
amended and the remediation commit replayed onto it, so the 8.7 MB blob exists in
no commit that reaches the remote. The rewritten head has a byte-identical tree
to the pre-rewrite head, confirmed with `git diff --stat`, and complete
verification passed again afterwards.

Pull request #138 was opened from head `5d145f1de`. Push-triggered Build lock CI
run `30420721491` passed on that exact head; the Dependabot auto-merge workflow
skipped as expected.

Follow-up work found in scope but deliberately not attempted here was filed with
its own evidence requirements rather than guessed at: issue #139 for the
seat-probing and automatic-recovery half of #132, and issue #140 for the
deferred shared issue-synchronization client.

### Credential interruption

The session credential became invalid partway through delivery and was restored
later. During that window the Cursor Bugbot remediation and the round-2
remediation were committed locally but could not be pushed, so pull request #138
briefly pointed at a head carrying defects that were already fixed on disk. The
record was kept accurate at each step rather than describing the fix as
delivered.

### Reviewed and delivered

After the credential was restored, head `e3440b422` was pushed. Build lock CI run
`30421778584` passed on that exact head and the Dependabot auto-merge workflow
skipped as expected. Cursor Bugbot re-reviewed the exact head and reported no
issues; its earlier high-severity finding is resolved. GitHub Copilot was
re-requested through the reviewer API and again returned quota exhaustion without
code feedback.

## Continuous-improvement disposition

Trigger: a public operational contract and a fail-closed recovery surface
changed.

Observed fact: a never-expiring fail-closed state demands proof that only an
operator can supply, but the operator first had to find that proof by hand. The
cost was discovery, not authorization.

Decision: **revise** the build-lock invariant reference. Recovery evidence may
be published automatically only by a read-only path that proves the state it
reports; unprovable state never opens, edits, or closes a published alert, and
publication never relaxes the exact identity and external proof recovery
requires. The invariant generalizes to quarantine and future fail-closed
surfaces, so it is narrower and more reusable than duplicating task detail in
agent guidance.
