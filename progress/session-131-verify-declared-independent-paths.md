# Session 131: verify declared independent paths in the change classifier

Date: 2026-10-26

Issue: #356 (qora-redux #502 / #514 is the first caller of `independent-paths`).

## Objective and safety invariants

qora-redux declares Godot prefixes inert to its Unity build, so a Godot-only
pull request must not spend the licensed editor seat. Verify that the shipped
classifier bundle honors the caller input exactly as `action.yml` documents,
and pin every clause with a test.

Safety invariants: the declaration may only widen the central allowlist; the
central floor stays intact; reserved prefixes stay refused; every malformed
or ambiguous case keeps failing closed to `unity-required=true`; no
production behavior changes.

## Baseline

Observed facts:

- The pinned consumer SHA `e04369db0da0e0106af77091bf95118218ec7c02` carries a
  `.github/dist/classify-unity-changes.js` byte-identical to `main`.
- The bundle unions declared prefixes after every central check
  (`isUnityIndependent`), refuses non-`dir/**` syntax and traversal, and
  refuses `Assets/`, `Packages/`, `ProjectSettings/`, `.github/workflows/`
  overlap at parse time. Local check with the exact qora-redux declaration:
  Godot-only diff classifies `false`, a diff that adds one undeclared path
  classifies `true`, `Assets/**` is refused.
- Tests already pinned clauses 1-3 and the first half of clause 4. Gap: the
  flip back to `true` was pinned only at unit level, never end to end through
  the runner input name where #184 hid a real input-reading bug.

## Red-green

Red: a scratch mutation that drops the declaration input from the runtime
(`independentPaths: ""`) failed the runtime declaration test. Revert restored
green. No committed file was mutated in the final state.

Green: the runtime declaration test is now data-driven over both halves:

- declared-only diff reports `unity-required=false`;
- the same diff plus one undeclared path reports `unity-required=true`.

## Documentation sync

The caller-widening contract from #194 was absent from prose that still
described the skip set as the central allowlist only:

- `action.yml` output description now says "central or caller-declared".
- `README.md` and `docs/consumer-enrollment.md` now name the
  `independent-paths` input and keep the reserved-prefix refusal visible.

## Validation

`node --test test/*.test.js` 1022 pass, 6 skipped. Full local CI equivalent
`.devcontainer/scripts/verify.sh` exits 0, including `go test ./...`,
`go vet ./...`, `go test -race ./...`, `golangci-lint`, both `mod verify` and
`tidy -diff` pairs, workflow javascript and shellcheck CI, and the credential
audit.

## Continuous improvement

No durable LLM resource promoted: the contract is already documented in the
authoritative places (`action.yml`, README, consumer contract), so a new
research file would duplicate them.

## Disposition

PR closes #356. Remaining qora-redux-side observation (first live Godot-only
skip) stays in #356's consumer thread and needs no central work.
