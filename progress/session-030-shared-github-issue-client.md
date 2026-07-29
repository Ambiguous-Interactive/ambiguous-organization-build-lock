# Session 030: shared GitHub issue client

## Scope, safety, and hypothesis

On 2026-07-29, review every open issue and pull request, prioritize impact
while favoring the least licensed Unity CI churn, and complete issue #140.

Hypothesis: the repeated issue-synchronization defects came from three
independent implementations of the same security-sensitive transport,
discovery, and state transition rules. A shared package can eliminate the
divergence while leaving each monitor's evidence classification and rendering
unchanged.

Disconfirming evidence would be a monitor adopting a foreign-authored marker or
pull request, silently accepting duplicate or truncated discovery, forwarding
credentials across origin, losing a timeout, rewriting retained recovery
evidence, or requiring a Unity consumer change.

Safety invariants:

- Missing, malformed, duplicate, oversized, or exhausted evidence fails closed.
- Credentials never cross an API-origin boundary or appear in diagnostics.
- Recovery alert closure retains the last proven incident body.
- The recovery monitor still verifies that a newly created alert is
  rediscoverable before succeeding.
- Classification, lock state, queueing, admission, release, and organization
  policy do not change.

## Issue and pull-request inventory

The clean checkout started at `8575a759b`, equal to `origin/main`. The GitHub
connector and CLI returned 16 open issues and no open or draft pull requests.
The latest Build lock CI run on that exact main commit passed.

| Priority | Issues | Disposition |
| --- | --- | --- |
| P0 | #83 | Highest raw operational impact: measured concurrent-return failures create false quarantines. A safe fix needs lifecycle design, consumer repins, and live two-holder canaries, so it has high Unity churn. |
| P0 | #51 | Highest security impact, but owner-authorized secret scope, App installation, rotation, and live negative probes cannot be completed by a central code PR alone. |
| P1 selected | #140 | Three central fail-closed monitors had proven transport and discovery divergence. Fully local, no external authority, no licensed Unity execution. |
| P1 | #113, #44 | Large active enrollment and truthful-aggregate policy gaps require broad consumer workflow and ruleset changes. |
| P1 | #53 | Runner starvation requires a new two-phase admission protocol and live cross-repository runner evidence. |
| P2 | #139, #132 | Automatic incident recovery is blocked on historical Unity Portal reconciliation evidence. |
| P2 | #49, #99 | Compatibility throughput and retry timing require broad consumer measurements and paid Unity execution. |
| Operational | #54, #29, #30 | Paid canary, monitoring, and umbrella tracker work rather than one bounded central PR. |
| Blocked | #60 | Literal zero cooldown remains blocked by #83 and requires release plus consumer repins. |
| Upstream blocked | #94 | Latest actionlint remains incompatible with the newer yaml/v4 parser API. |
| Needs triage | #27 | Historical incident link is underspecified and overlaps later evidence-backed work. |

The independent prioritization reviewer agreed that #140 is the best safely
deliverable choice under the least-churn preference, while explicitly ranking
#83 and #51 higher in raw impact.

Dependency inspection found no open dependency PR. Root and isolated module
update checks are recorded with final validation below; #94 governs the known
actionlint/yaml incompatibility.

## Baseline and red-green evidence

The three focused command suites passed before implementation, establishing
that the extraction must preserve existing tested behavior.

The new shared-package regression then failed to compile with undefined
`New`, `Options`, `Client`, `Issue`, `Identity`, and `Desired`, proving the red
test exercised an absent contract rather than an existing path.

Green adds `internal/githubissue`, which owns:

- a same-origin client with a mandatory timeout and redirect fence;
- bounded raw and strict JSON requests;
- escaped repository paths;
- creator-scoped, ascending marker discovery over GitHub's bounded opaque
  same-origin cursor;
- pull-request and foreign-author filtering;
- invalid and duplicate evidence rejection;
- idempotent create, update, reopen, and close;
- retained-body close and verified-create options used by recovery.

Each command retains its classification, marker, title, body, and decision
about whether the alert should be open or closed.

## Swept failure mode: encoded response size

The previous task record claimed 30 maximum 64-KiB issue bodies fit comfortably
under a 4-MiB response bound. That counted raw body bytes, not JSON wire bytes.
Go's encoder expands a `<` byte to `\u003c`, a sixfold increase, so 30 hostile
but valid maximum-size bodies can exceed 11 MiB before envelope data.

The shared discovery page is five issues. A representative full issue-list
envelope with five worst-case escaped maximum bodies and an additional 400 KiB
of reserved envelope per issue encodes below 4 MiB. That reserve is over 70
times the previously measured per-issue envelope. The page count is 240,
retaining the previous 1,200-issue total discovery window. A regression
constructs and encodes that boundary directly, and another proves actual
response overflow is rejected.

## Validation and review

Focused green:

```text
go test ./internal/githubissue ./cmd/reaper-delivery-audit \
  ./cmd/sync-unity-enrollment-issue ./cmd/lock-recovery-audit
all four packages passed
```

An initial `.devcontainer/scripts/verify.sh` run passed 604 Node tests, all Go
packages, both module verification/tidy gates, actionlint, and the credential
audit. A subsequent source review found that the first shared request
implementation checked its body bound before non-2xx status, regressing an
existing recovery-monitor diagnostic. The order was fixed and a regression now
proves HTTP status wins over an oversized error body. Because code changed
afterward, that initial full run is not final completion evidence.

## Independent review

Implementer: root agent.

The first independent agent reviewed the issue prioritization and selected
scope. It agreed with #140 and found four specification conflicts that required
explicit handling:

- timeout and no-write behavior differed among monitors;
- redirect policies differed;
- reaper title identity differed from marker-only identity;
- 30 maximum-size bodies were not proven below 4 MiB after JSON escaping.

Dispositions: the shared package applies an explicit timeout and rejects
redirects; no-write is the target acceptance behavior; title identity is an
option retained for reaper; and the page bound was corrected to five with a
wire-encoded full-envelope regression.

### Code review round 1

Reviewer: independent adversarial sub-agent `issue140_review`.

| Severity | Finding | Disposition |
| --- | --- | --- |
| High | Switching directly to Link cursors removed the legacy full-page numbered fallback and initially weakened two existing migration fixtures. | Fixed. Cursor traversal is preferred, but a full page without Link retains bounded numbered fallback until a cursor has been used. The original no-Link command fixtures are unchanged. |
| High | Same-origin alone allowed a Link to another repository, whose issue number could then be patched in the configured repository. | Fixed. Cursor path and identity query are validated, then the opaque query is rebased onto the configured repository path. |
| High | GitHub's live Link canonicalizes the path to `/repositories/{numeric-id}/issues`, which the first strict path fence rejected. | Fixed. The canonical numeric shape is accepted only as cursor evidence and is never requested directly; a live-shaped regression proves the rebased request stays under the configured `/repos/{owner}/{repo}/issues` path. |
| Medium | The first maximum-body test modeled only the reduced decoded struct and reserved too little space for the complete API envelope. | Fixed. Page size is five, the encoded fixture models representative response fields plus 400 KiB of reserve per issue, and a shared transport regression proves overflow is rejected. |

After remediation, the reviewer discarded stale conclusions, reran focused,
race, Go, harness, module, tidy, credential, and diff checks, and reported zero
actionable findings. It also live-probed the canonical cursor query rebased to
the configured repository endpoint and observed HTTP 200.

### Code review round 2

Reviewer: independent adversarial sub-agent `issue140_review2`.

| Severity | Finding | Disposition |
| --- | --- | --- |
| P2 | The generic request resolver fenced origin but not repository, so a future same-origin adapter mistake could send the bearer token to another repository. `workflowRuns` also ignored a repository argument that differed from the configured client. | Fixed. Every request path must equal or descend from the configured repository root after URL resolution. Direct foreign-repository and traversal paths are rejected before I/O, and `workflowRuns` rejects a repository mismatch before request construction. |
| P2 | An absolute same-origin endpoint with percent-encoded dot segments retained a decoded repository prefix while a server could normalize it outside that repository. | Fixed. Generic requests now reject nonempty `RawPath`, userinfo, and fragments before I/O. Regressions cover encoded dot-segment and encoded-slash traversal. |

After the final remediation the reviewer discarded stale conclusions, checked
the path fence and zero-I/O traversal regressions, reran the focused four-package
suite and diff check, and reported zero actionable findings. Both independent
implementation reviewers therefore agree the latest worktree has no remaining
finding.

### Final reviewed validation

After both review rounds and all remediations, the complete repository verifier
passed on the latest source:

```text
.devcontainer/scripts/verify.sh
604 Node tests passed; all Go packages passed
both module verification/tidy gates passed
actionlint and the credential policy audit passed
```

Additional latest-source checks passed:

```text
go test -race ./internal/githubissue ./cmd/reaper-delivery-audit \
  ./cmd/sync-unity-enrollment-issue ./cmd/lock-recovery-audit -count=1
go vet ./...
git diff --check
gofmt -l <all changed Go files>  # no output
```

The root Go module is already current. The isolated actionlint module has only
unused transitive candidates, while the actionlint upgrade remains constrained
by the incompatible YAML release candidate already tracked in #94.

## Knowledge retention

Trigger: substantial shared safety architecture plus a falsified response-bound
assumption.

Observed fact: JSON encoding can expand a maximum-size issue body sixfold, and
three copies had already diverged on several correctness decisions.

Inference: central ownership will reduce future monitor drift; only future
changes can confirm that maintenance benefit.

Decision: revise the stale issue #132 task record and make the shared package's
boundary regression the executable source of truth. No broader skill change is
needed because the existing testing guidance already requires large-input and
boundary evidence.
