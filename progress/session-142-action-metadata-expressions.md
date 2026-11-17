## What fails

Every caller that pins v1.18.0 fails to load `classify-unity-changes` at job
setup. The `github-token` description held `${{ github.token }}`, and the runner
evaluates actions metadata, where the `github` context is absent.

## Change

- The description now says `the workflow token (github.token)`.
- `test/action-manifests.test.js` refuses any expression outside the `runs`
  block and an `outputs.*.value`. It is red on the old text:

```text
✖ no action manifest interpolates an expression in metadata
  + 'incremental-validation. Use ${{ github.token }}. The job needs actions: read,'
```

## Verification

- `node --test test/*.test.js`: 1052 total, 1026 pass, 23 fail, 3 skipped. The
  23 failures match the documented macOS baseline set on a clean `main`
  checkout, so this change adds no failure.
- `node tools/llm-harness.mjs check`, `go test ./...`, `go vet ./...`,
  `go test -race ./...`, `go mod verify`, both `mod tidy -diff` checks, and
  `go run ./cmd/workflow-credential-audit .`: pass.
- `bash tools/workflows/ci.sh javascript`: pass.
- actionlint over every workflow: no findings.

## Follow-up

The fix reaches consumers only in a new patch release. The next release must be
authorized in `unity-enrollment-policy.json` before IshoBoy can move from
v1.17.1.
