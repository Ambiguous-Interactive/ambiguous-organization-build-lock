# Session 140: status keeps a proven reaper fact

Date: 2026-11-16

Issues: #390, #335.

## Baseline

- `main` at `b56e6c880d`; the last fifteen `main` runs pass.
- No open pull request in this repository.
- Node tests: 1049 total, 1023 pass, 23 fail, 3 skipped. The 23 failures are the
  known macOS path and git-release fixtures. They fail on an unmodified worktree
  too.
- `go test ./...`, `go mod verify`, both `mod tidy -diff` checks, actionlint,
  ESLint, and the credential audit pass.

## Open-issue priority

The order favours impact against Unity CI churn. No open issue can close
without owner authorization, live evidence, or a consumer merge.

| Order | Issue | Impact | Unity CI churn |
| --- | --- | --- | --- |
| 1 | #390 status adoption | Every consumer can name the block after a denied acquire, and the reaper-run fact never argues from an unknown. | None. Central manifest, runtime, docs, and tests only. |
| 2 | #113 enrollment drift | 22 findings stay on the weekly alert: 14 DxMessaging shape findings and 8 expired exceptions. | High. It reshapes DxMessaging Unity jobs, and the exceptions need an owner re-review. |
| 3 | #379 merge queue adoption | Adds the queue trigger to DoxReloaded. | Medium. It waits for the next authorized release pin. |
| 4 | #335 actionlint YAML | Removes a stale indirect pin. | None, but the pinned linter cannot build against YAML v4.0.0. |
| 5 | #53 runner starvation, #83 shared seat | Admission fairness and return capacity. | High. Both need live two-runner measurement first. |
| 6 | #29 canaries, #153/#229/#231/#249 Darwin, #51 credentials, #277/#278/#334 evidence | Each needs owner authorization, a portal fact, or run evidence that is not published yet. | Unknown until the evidence exists. |

Session 140 takes #390. Its central half is decidable now. Consumer adoption
needs a release pin, so this session records that step and leaves it to the next
release.

## Change

- The `reap-stale-locks` action keeps `github-token` optional. A token can read
  the lock repository's Actions history only when it has Actions read on that
  repository, so a consumer token cannot. The input description now states that.
- `lastSuccessfulReaperRun` retries anonymously when the token read is refused
  (`401`, `403`, `404`). A mis-scoped or expired token therefore never leaves the
  fact less proven than no token at all. A transient failure keeps its single
  bounded retry budget. The report still never fails for this fact.
- The runbook records the consumer shape: one step outside every licensed job,
  no secret, no required check. It also states the anonymous read limit.
- README, the manifest description, and the runbook now say what the code does.

## Review findings and dispositions

An independent adversarial review found these issues. All are fixed.

- Over-claim: the first draft defaulted `github-token` to `${{ github.token }}`
  and the docs said the read was "never anonymous". A consumer token is scoped
  to the consumer repository, so it cannot read the lock repository's Actions
  history. The default is gone and the docs state the limit.
- Retry cost: the first draft retried anonymously after every failure, which
  doubled the bounded retry budget on a transient outage. The retry now answers
  a refused credential only.
- Test cost: one test returned `500`, so it spent 35 s of retry backoff. It now
  returns two refused reads and runs in milliseconds.
- Untested log: the two-read report now pins the `(anonymous retry: ...)` text
  and the exact request order.
- Manifest test: the description assertion accepts wrapped prose, and a new
  assertion proves the input has no default.

## Validation

- Node tests: 1051 total, 1025 pass, 23 fail, 3 skipped. The failure set is the
  same baseline set. The two new tests pass.
- Red check: with the `origin/main` runtime, both new tests fail.
- `node tools/llm-harness.mjs check`: pass.
- `bash tools/workflows/ci.sh javascript`: pass.
- actionlint over every workflow: no findings.
- `go test ./...`, `go vet ./...`, `go mod verify`: pass.
- `go run ./cmd/workflow-credential-audit .`: pass.
- #335 stays blocked: `go -C tools/actionlint run` against YAML v4.0.0 fails
  with `undefined: yaml.ParserError` in actionlint v1.7.12. The dependency was
  restored.

## Merge and post-merge evidence

- PR #393 merged at `3b7204b6`.
- CodeRabbit asked for a job-level status example. Commit `a5c9ed9c` adds the
  reporting job with `needs` and a job-level `if: failure()`. The bot approved
  the same commit.
- `main` runs at `3b7204b6`: `Build lock CI` success, `Organization Unity
  enrollment audit` success, `Reaper delivery audit` success, `Reap stale build
  locks` success, `Build lock incident recovery audit` success.
- #390 keeps the consumer adoption step, which needs the next release pin.
- #335 has the fresh compiler evidence.
