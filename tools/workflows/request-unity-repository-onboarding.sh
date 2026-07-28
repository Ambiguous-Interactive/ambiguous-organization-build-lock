#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  validate-ref)
    test "${REQUEST_REF:?REQUEST_REF is required}" = "refs/heads/main"
    ;;
  write-request)
    jq -n \
      --arg repository "${TARGET_REPOSITORY:?TARGET_REPOSITORY is required}" \
      --arg defaultBranch "${TARGET_DEFAULT_BRANCH:?TARGET_DEFAULT_BRANCH is required}" \
      --argjson fork "${TARGET_FORK:?TARGET_FORK is required}" \
      --argjson allowWorkflowDispatch "${TARGET_ALLOW_WORKFLOW_DISPATCH:?TARGET_ALLOW_WORKFLOW_DISPATCH is required}" \
      '{
        repository: $repository,
        defaultBranch: $defaultBranch,
        fork: $fork,
        allowWorkflowDispatch: $allowWorkflowDispatch
      }' > "${RUNNER_TEMP:?RUNNER_TEMP is required}/unity-onboarding-request.json"
    ;;
  *)
    echo "usage: $0 <validate-ref|write-request>" >&2
    exit 2
    ;;
esac
