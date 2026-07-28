#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  syntax)
    node --check tools/llm-harness.mjs
    for action_file in .github/dist/*.js; do
      node --check "${action_file}"
    done
    for test_file in test/*.test.js; do
      node --check "${test_file}"
    done
    ;;
  verify-modules)
    go mod verify
    go -C tools/actionlint mod verify
    ;;
  tidy-modules)
    go mod tidy -diff
    go -C tools/actionlint mod tidy -diff
    ;;
  *)
    echo "usage: $0 <syntax|verify-modules|tidy-modules>" >&2
    exit 2
    ;;
esac
