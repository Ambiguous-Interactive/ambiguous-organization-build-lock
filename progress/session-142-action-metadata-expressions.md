# Session 142: an expression in action metadata blocked a release

Date: 2026-11-16

Issues: #399.

Pull request: this repository's #400.

## Objective and safety invariants

Carry the GOAL.md directive: rank open issues by impact with the least Unity CI
churn, complete the highest-priority safe work, and drive it green.

Safety invariants: no fail-closed path is weakened. The action metadata stays
loadable by the runner. No licensed workflow changes, so the Unity matrix is
untouched.

## Baseline

- `main` at `82950e0960`. No open pull request.
- v1.18.0 (`a07d4bd88a`) is the newest approved pin. It cannot load
  `classify-unity-changes`, so every caller that moves to it fails in
  "Set up job".
- IshoBoy run `44017567798` and DoxReloaded run `44007555842` show the failure.
- `main` runs for `Build lock CI` and both audits pass.

## Open-issue priority

| Order | Issue | Impact | Unity CI churn |
| --- | --- | --- | --- |
| 1 | #399 metadata expression | Every caller pinned at v1.18.0 cannot classify, so no release can be adopted. | None. No licensed workflow changes. |
| 2 | #397 aggregate coverage | One exact-shape aggregate covers one licensed job, so the DxMessaging class waits on a decision. | High when it lands. |
| 3 | #113 DxMessaging findings, expired exceptions | 14 findings and 8 expired exceptions. Both need separate review. | High for the first; none for the second. |
| 4 | #390, #379 consumer adoption | Blocked by the release that carries this fix. | Low to medium, in consumers. |
| 5 | #335 actionlint YAML | Dependency freshness only. Blocked upstream. | None. |
| 6 | #53, #83, #29, #51, #153, #229, #231, #249, #277, #278, #334 | Each needs owner authority, a portal fact, or evidence that is not published. | Unknown until the evidence exists. |

## Root cause

`classify-unity-changes/action.yml` held `Use ${{ github.token }}.` in the
`github-token` input description. The runner evaluates `${{ }}` in action
metadata, and the `github` context is absent there. The runner refuses the whole
file, so the action never loads.

The text arrived with #385. The 12 other manifests hold no expression outside
`runs.steps`, and `validate-unity-license` holds three in `outputs.*.value`,
where they are valid.

## Change

- The description reads `Use the workflow token (github.token).`
- `test/action-manifests.test.js` gains a guard over every
  `.github/actions/*/action.yml`. It refuses an expression outside a composite
  `runs.steps` entry and an `outputs.*.value`. It reads block scalars as text,
  so a `#` line inside a folded description is checked, and an inline comment is
  not.
- A data-driven table pins 13 manifest shapes, both flagged and allowed.
- `PLAN.md` names the release authorization as the next action.

## Evidence

The guard is red on the exact published file:

```text
git show v1.18.0:.github/actions/classify-unity-changes/action.yml > action.yml
✖ no action manifest interpolates an expression in metadata
  + 'incremental-validation. Use ${{ github.token }}. The job needs actions: read,'
```

## Review findings and dispositions

An independent adversarial review found these. All are fixed.

- Miss: a `#` line inside a folded description was read as a comment, so its
  expression passed. Block scalars are now tracked by indent and read as text.
- Miss: an output literally named `value` exempted its own `description` from
  the rule. The guard now allows the exact `outputs.<name>.value` key path only.
  A review comment asked for the path form and a `value` key inside a folded
  description; both are in.
- Miss: the whole `runs` block was exempt, so `runs.main` with an expression
  passed. Only a composite `runs.steps` entry is exempt now.
- False alarm: quoted keys were not recognized, though the file's other helper
  supports them. Quoted keys now parse.
- False alarm: an inline comment naming an expression was reported. A comment is
  stripped before the check, except inside a block scalar.
- Stale plan: `PLAN.md` still told consumers to adopt v1.18.0. It now names the
  v1.18.1 authorization.
- Untested heuristics: a 13-shape table now covers every shape above.

## Validation

- `node --test test/action-manifests.test.js`: 61 pass.
- `node --test test/*.test.js`: 1053 total, 1027 pass, 23 fail, 3 skipped. The
  23 failures match the documented macOS baseline set on a clean `main`
  checkout, so this change adds no failure.
- `node tools/llm-harness.mjs check`, `go test ./...`, `go vet ./...`,
  `go test -race ./...`, `go mod verify`, both `mod tidy -diff` checks, and
  `go run ./cmd/workflow-credential-audit .`: pass.
- `bash tools/workflows/ci.sh javascript`: pass.
- actionlint over every workflow: no findings.
- `golangci-lint` and `shellcheck` are not installed on this host; CI runs both.

## Follow-up

The fix reaches consumers only in a new patch release. The next release must be
authorized in `unity-enrollment-policy.json` before a consumer can adopt it.
IshoBoy#1090 waits on that authorization.
