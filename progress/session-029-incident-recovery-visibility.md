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
escape-character provenance. Those runtime-produced digests are now pinned as
Go regression vectors, so a future canonicalization change fails the suite
instead of silently invalidating every published identifier.

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

Raising the limit alone would only defer the failure, so the page size is now
the bound: discovery requests 30 issues per page against a 4 MiB response
limit. GitHub caps an issue body at 64 KiB, so a full page cannot exceed roughly
2 MiB however large the history grows, and the page budget was raised so
coverage is unchanged. `cmd/reaper-delivery-audit` had the same shape with more
headroom and was aligned. Each affected tool gained a regression that walks
multiple pages of maximum-size issues and asserts the response stays inside its
bound.

## Validation, review, and delivery

Fresh complete local verification passed:

```text
.devcontainer/scripts/verify.sh
LLM harness checks passed.
tests 602; pass 602; fail 0
all Go packages passed
all modules verified
Workflow credential-literal policy passed.
```

`go test -race ./cmd/lock-recovery-audit`, `gofmt -l`, `go vet`, and
`git diff --check` also passed.

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
