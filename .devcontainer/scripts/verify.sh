#!/usr/bin/env bash
set -euo pipefail

# Independent checks overlap locally. Keep each group's output together and
# wait for every group, so a failure cannot hide another check's result.
verify_logs="$(mktemp -d)"
verify_pids=()
cleanup() {
  for pid in "${verify_pids[@]}"; do
    kill -TERM -- "-${pid}" 2>/dev/null || true
    kill -KILL -- "-${pid}" 2>/dev/null || true
  done
  wait || true
  rm -rf -- "${verify_logs}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A separate process group lets interruption stop each tool and its children.
setsid bash -euo pipefail -c '
  node --check tools/llm-harness.mjs
  node tools/llm-harness.mjs check
  bash tools/workflows/ci.sh syntax
  bash tools/workflows/ci.sh javascript
' >"${verify_logs}/javascript" 2>&1 &
verify_pids+=("$!")

setsid bash -euo pipefail -c '
  go -C tools/actionlint run -mod=readonly \
    github.com/rhysd/actionlint/cmd/actionlint -color
  GOLANGCI_LINT_CACHE="${RUNNER_TEMP:-/tmp}/ambiguous-golangci-cache" golangci-lint run --timeout=5m
  go test ./...
  go vet ./...
  go test -race ./...
  go mod verify
  go -C tools/actionlint mod verify
  go mod tidy -diff
  go -C tools/actionlint mod tidy -diff
  go run ./cmd/workflow-credential-audit .
' >"${verify_logs}/go" 2>&1 &
verify_pids+=("$!")

setsid bash -euo pipefail -c '
  node --test test/*.test.js
  bash tools/workflows/ci.sh shellcheck
' >"${verify_logs}/tests" 2>&1 &
verify_pids+=("$!")

verify_failed=0
for pid in "${verify_pids[@]}"; do
  if ! wait "${pid}"; then
    verify_failed=1
  fi
done
verify_pids=()
cat "${verify_logs}/javascript" "${verify_logs}/go" "${verify_logs}/tests"
exit "${verify_failed}"
