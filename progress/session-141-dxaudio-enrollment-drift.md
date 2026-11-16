# Session 141: DxAudio enrollment drift

Date: 2026-11-16

Issues: #113.

Pull requests: Ambiguous-Interactive/DxAudio#49, and this repository's
registry change.

## Objective and safety invariants

Carry the GOAL.md directive: rank open issues by impact with the least Unity CI
churn, complete the highest-priority safe work, and drive it green.

Safety invariants: no fail-closed path is weakened. The registry stays the only
authority for paid consumers. A licensed job stays unprovable until the audit
can enumerate every leg. The audit still refuses every unapproved shape.

## Baseline

- `main` at `b877430e5d` (release v1.18.0 authorized at `a07d4bd88a`). No open
  pull request in this repository.
- The enrollment audit run `43947938794` is complete with 27 findings: DxAudio
  5, DxMessaging 14, and 8 expired policy exceptions in `unity-builder` and
  `unity-helpers`.
- `main` runs pass for `Build lock CI`, both audits, and the scheduled reaper.

## Open-issue priority

The order favours impact against Unity CI churn.

| Order | Issue | Impact | Unity CI churn |
| --- | --- | --- | --- |
| 1 | #113 DxAudio findings | A paid job cannot prove its per-leg editor gate or return pins. A licensed schedule is not authorized. | Low. Pull-request legs stay at two; nightly legs drop from four to two. |
| 2 | #113 DxMessaging findings | 14 findings on three licensed jobs in one workflow. | High. It reshapes three jobs. |
| 3 | #113 expired exceptions | 8 registry exceptions expired on 2026-10-31. | None, but the owner must re-review each one. |
| 4 | #390 status adoption, #379 merge queue | v1.18.0 now publishes an approved pin, so consumer adoption is unblocked. | Low to medium. Consumer pull requests, no new licensed step. |
| 5 | #335 actionlint YAML | Dependency freshness only. | None, and blocked upstream. |
| 6 | #53, #83, #29, #51, #153, #229, #231, #249, #277, #278, #334 | Each needs owner authority, a portal fact, or evidence that is not published. | Unknown until the evidence exists. |

Session 141 takes the DxAudio class of #113. The DxMessaging findings and the
expired exceptions stay open; both need separate review.

## Root cause

Reproduced with the unmodified analyzer over a blobless clone of DxAudio at the
audited commit `e571319a`:

| Code | Cause |
| --- | --- |
| `ineligible-unity-trigger` | The workflow runs licensed work from a daily `schedule`, and the registry entry has `allowSchedule: false`. |
| `missing-unity-editor-check` | The matrix is `include: ${{ fromJSON(needs.plan-lanes.outputs.matrix) }}`. A generated matrix cannot be enumerated, so the per-leg editor version is unprovable. |
| `missing-unity-return`, `unsafe-central-return-suffix`, `classifier-inputs-not-typed` | `evidence-suffix` holds `${{ matrix.lane }}`, so the return step is untyped. The same generated matrix also withholds the per-leg return pin. |

A second defect became visible once the matrix was fixed: the two
current-PR-head guard steps carried `if: ${{ github.event_name == 'pull_request' }}`.
Contract item 3 refuses any `if` on the reviewed editor-check prefix, because a
conditional step cannot prove GitHub's implicit `success()` chain. The guard
needs no `if`: it reports current without an API call when no pull request is in
scope.

## Change

Consumer, Ambiguous-Interactive/DxAudio#49:

- `unity-tests` uses literal `unity-version` and `lane` axes. Pull requests
  still run two Unity 6 legs.
- `evidence-suffix` is a literal.
- The guard steps carry no `if`.
- The nightly oldest-editor lane moves to `unity-tests-legacy.yml` with the same
  daily schedule, both integration states, and its own exact-shape aggregate.
  Pull requests never run it.

Central, this repository:

- `unity-enrollment-policy.json` authorizes a schedule for DxAudio. The merge
  of this pull request is the authorization decision.
- `docs/consumer-enrollment.md` states three rules the code already enforces:
  the editor-check prefix takes no `if`, `evidence-suffix` is a literal, and one
  exact-shape aggregate covers one licensed job.
- `PLAN.md` records the new finding counts.

## Evidence

Unmodified analyzer over the consumer commit, with the policy inputs for that
repository:

```
before (e571319a):                  findings=5
after consumer fix, schedule false: findings=1  ineligible-unity-trigger
after consumer fix, schedule true:  findings=0
```

The one remaining finding is the registry authorization, which this repository's
pull request supplies.

## Review findings and dispositions

An independent adversarial review found these issues. All are fixed.

- Over-claim: the first draft split the nightly lane on the strength of the
  matrix alone. The analyzer showed the `evidence-suffix` expression was a
  second, independent cause. The change fixes both, and the evidence table names
  each one.
- Masked defect: the first draft kept the `if` on the guard steps because a
  scheduled run has no pull request. That hid a real prefix violation. The guard
  action reports current without an API call, so the `if` is wrong on every
  event, not only on a schedule.
- Two licensed jobs in one workflow: the first draft added the nightly job to
  `unity-tests.yml`. The exact-shape aggregate covers one licensed job, so that
  shape cannot pass. The nightly lane now owns a workflow file.
- Stale comments: the workflow comment that named the nightly matrix and the
  aggregate `needs` list that named the removed planning job were both
  corrected.

## Validation

- `node tools/llm-harness.mjs check`: pass.
- `node --test test/*.test.js`: 1051 total, 1025 pass, 23 fail, 3 skipped. The
  failure set is the documented macOS baseline set; it is unchanged by this
  change.
- `go test ./...`, `go vet ./...`, `go mod verify`, both `mod tidy -diff`
  checks: pass.
- `bash tools/workflows/ci.sh javascript`: pass. `shellcheck` is not installed
  on this host; CI runs it.
- actionlint over every workflow: no findings.
- `go run ./cmd/workflow-credential-audit .`: pass.
- `cmd/audit-unity-enrollment -validate-policy-only`: the registry is valid.
- `golangci-lint` is not installed on this host; CI runs it.

## Merge and post-merge evidence

Pending.
