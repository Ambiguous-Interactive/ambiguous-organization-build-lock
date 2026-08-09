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
  javascript)
    npx --yes eslint@9.35.0 \
      --no-config-lookup \
      --rule 'no-alert:error' \
      --rule 'no-constant-condition:error' \
      --rule 'no-debugger:error' \
      --rule 'no-dupe-keys:error' \
      --rule 'no-duplicate-case:error' \
      --rule 'no-func-assign:error' \
      --rule 'no-import-assign:error' \
      --rule 'no-invalid-regexp:error' \
      --rule 'no-irregular-whitespace:error' \
      --rule 'no-new-native-nonconstructor:error' \
      --rule 'no-obj-calls:error' \
      --rule 'no-self-assign:error' \
      --rule 'no-sparse-arrays:error' \
      --rule 'no-unexpected-multiline:error' \
      --rule 'no-unreachable:error' \
      --rule 'no-unsafe-finally:error' \
      --rule 'no-unused-vars:["error",{"argsIgnorePattern":"^_","varsIgnorePattern":"^_","caughtErrors":"none"}]' \
      .github/dist/*.js tools/*.mjs test/*.js
    ;;
  shellcheck)
    shellcheck -S warning tools/*.sh tools/workflows/*.sh .devcontainer/scripts/*.sh
    ;;
  *)
    echo "usage: $0 <syntax|verify-modules|tidy-modules|javascript|shellcheck>" >&2
    exit 2
    ;;
esac
