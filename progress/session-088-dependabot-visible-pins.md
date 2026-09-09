# Session 088: Dependabot-visible repin pins

## Task

Answer issue 263: zero-touch client dependencies. The operator asked
whether the lockstep, manifest-driven SHA pin approach fits Dependabot.

## Hypothesis and evidence

Dependabot reads a SHA-pinned action only through its `# vX.Y.Z` version
comment. Live evidence:

- DoxReloaded Dependabot pull request 775 bumped exactly one build-lock pin,
  `classify-unity-cleanup-evidence`, from 1.13.0 to 1.14.0. That pin carried
  a version comment at the time.
- A 2026-09-09 API survey of all six enrolled default branches found 74
  central pins at v1.14.2 (`d79e1cc2`). DoxReloaded, IshoBoy, and qora-redux
  carry zero version comments; DxMessaging and unity-helpers carry partial
  coverage. The repin rewrite preserved a valid comment but never added one,
  so central repins made pins invisible to Dependabot.

Conclusion: the manifest-driven approach fits Dependabot; the gap was the
missing comment normalization. The fail-closed authorization gate is the
reason Dependabot cannot be the sole updater: Dependabot moves only the
`uses:` line, cannot rewrite reviewed companions, and proposes before the
release is authorized. A Dependabot pin to an unauthorized SHA fails closed
as `unapproved-lock-ref`.

## Change

`tools/workflows/repin-consumer-locks.sh`, `rewritePinLine`:

- A moved pin now gains `# vX.Y.Z` when it had no comment, and a version
  comment updates to the new release.
- A pin already at the target keeps its exact shape, so supersession
  detection and orphan-branch tree comparison are unchanged.
- A comment that is not a version (reviewed witness note) survives.
- An unknown target version changes no comment; it never deletes a label.
- The target version must match `vMAJOR.MINOR.PATCH` or the rewrite fails
  closed before any write. The scheduled resolver already emits only that
  grammar; the check closes the standalone `rewrite-pins` CLI path.

Docs: `docs/consumer-enrollment.md` gains the normalization contract and the
Dependabot limits. `docs/operations-runbook.md` states the grammar gate,
the Dependabot boundary, the close scope (central offers only), and the
one-time migration for pre-normalization orphan branches.

## Adversarial review rounds

Round 1 found four minors; all fixed in 538188ee7:

1. An empty target version deleted an existing version comment. Now the
   comment is preserved; a stale label is better evidence than a deleted
   one.
2. The target version reached rewritten lines unvalidated. Now the grammar
   check runs before any write.
3. The runbook said the run closes "the other offer"; the run cannot close
   a Dependabot pull request. Reworded to central offers only.
4. Pre-normalization orphan branches read as different content after this
   change. Documented delete-once recovery. Live survey: every existing
   orphan branch has a closed pull request, so the closed-offer path skips
   the comparison; no live stranding exists.

Round 2 verified all four fixes and found one minor wording overclaim
("accepts only" versus the empty-version recovery mode). Fixed in
b84f81caf.

## Tests

- `test/workflow-scripts.test.js` gains a data-driven disposition matrix:
  three comment shapes (absent, version, witness) times two version states
  (release tag, unknown), plus a newline-injection case that must fail
  closed with a byte-identical file.
- The companion-artifact end-to-end test now proves a `pin-lines` doc line
  without a comment gains the version comment.
- The orphan-branch harness fixture models what a current run pushes.

## Verification

- `node --test test/*.test.js`: 885 pass, 0 fail, 6 skipped
  (architecture-gated).
- `node tools/llm-harness.mjs check`: pass.
- `go test ./...`, `go test -race ./...`, `go vet ./...`: pass.
- `go mod verify`, `go mod tidy -diff` (both modules): clean.
- `golangci-lint run --timeout=5m`: 0 issues.
- `bash tools/workflows/ci.sh javascript`, `ci.sh shellcheck`: clean.
- `go run ./cmd/workflow-credential-audit .`: pass.
- `.devcontainer/scripts/verify.sh`: pass.

## Dispositions and follow-ups

- Considered and rejected: a new enrollment-audit finding for comment-less
  pins. The repin normalization keeps pins current through the release
  train; an extra finding code adds contract weight without preventing a
  recurring failure.
- Full consumer zero-touch (auto-merge of green repin offers) reverses the
  2026-09-07 directive that the automation never merges. Opened a follow-up
  issue for the operator decision instead of implementing it.
