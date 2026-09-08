#!/usr/bin/env bash
set -euo pipefail

resolve_scope() {
  go test ./internal/mergepolicy ./cmd/audit-merge-policy
  go run ./cmd/audit-merge-policy \
    --policy unity-enrollment-policy.json \
    --expectations merge-policy-expectations.json \
    --validate-only
  repositories="$(
    jq -r '.repositories[].repository | split("/")[1]' merge-policy-expectations.json |
      LC_ALL=C sort |
      paste -sd, -
  )"
  if [ -z "${repositories}" ]; then
    echo "The merge policy reader scope is empty." >&2
    exit 1
  fi
  echo "repositories=${repositories}" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
}

record_counts() {
  if [ ! -f "${AUDIT_PATH:?AUDIT_PATH is required}" ]; then
    echo "Merge policy audit artifact unavailable." >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
    exit 1
  fi
  expected_repositories="$(jq -r '.repositories | length' merge-policy-expectations.json)"
  jq -r --arg expected "${expected_repositories}" \
    '"Repositories: \(.repositories | length)/\($expected)\nObserved required checks: \(.inventory | length)\nFindings: \(.findings | length)\nComplete: \(.complete)"' \
    "${AUDIT_PATH}" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
  if [ "$(jq -r '.complete' "${AUDIT_PATH}")" != "true" ]; then
    echo "The merge policy audit is incomplete; merge-gate status is unknown." >> "${GITHUB_STEP_SUMMARY}"
    exit 1
  fi
}

case "${1:-}" in
  resolve-scope) resolve_scope ;;
  record-counts) record_counts ;;
  *)
    echo "usage: $0 <resolve-scope|record-counts>" >&2
    exit 2
    ;;
esac
