#!/usr/bin/env bash
set -euo pipefail

node --check tools/llm-harness.mjs
node tools/llm-harness.mjs check

for action_file in .github/dist/*.js; do
  node --check "${action_file}"
done

for test_file in test/*.test.js; do
  node --check "${test_file}"
done

go -C tools/actionlint run -mod=readonly \
  github.com/rhysd/actionlint/cmd/actionlint -color
bash tools/workflows/ci.sh javascript
bash tools/workflows/ci.sh shellcheck
GOLANGCI_LINT_CACHE="${RUNNER_TEMP:-/tmp}/ambiguous-golangci-cache" golangci-lint run --timeout=5m
node --test test/*.test.js
go test ./...
go vet ./...
go test -race ./...
go mod verify
go -C tools/actionlint mod verify
go mod tidy -diff
go -C tools/actionlint mod tidy -diff
go run ./cmd/workflow-credential-audit .
