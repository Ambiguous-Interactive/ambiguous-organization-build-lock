#!/usr/bin/env bash
set -euo pipefail

resolve_scope() {
  go test ./internal/enrollment ./cmd/audit-unity-enrollment
  go run ./cmd/audit-unity-enrollment \
    --policy unity-enrollment-policy.json \
    --validate-policy-only
  repository_count="$(jq -er '.repositories | length' unity-enrollment-policy.json)"
  if [ "${repository_count}" -lt 6 ]; then
    echo "The Unity enrollment baseline is incomplete." >&2
    exit 1
  fi
  if ! jq -e '
    .organization == "Ambiguous-Interactive" and
    ([.repositories[].repository] | length == (unique | length)) and
    all(
      .repositories[];
      (.repository | test("^Ambiguous-Interactive/[A-Za-z0-9_.-]+$")) and
      (.defaultBranch | type == "string" and length > 0)
    )
  ' unity-enrollment-policy.json >/dev/null; then
    echo "The Unity enrollment registry cannot define reader scope." >&2
    exit 1
  fi
  repositories="$(
    jq -r '.repositories[].repository | split("/")[1]' unity-enrollment-policy.json |
      LC_ALL=C sort |
      paste -sd, -
  )"
  if [ -z "${repositories}" ]; then
    echo "The Unity enrollment reader scope is empty." >&2
    exit 1
  fi
  echo "repositories=${repositories}" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
}

clone_consumers() {
  mkdir -p .policy-consumers
  while IFS=$'\t' read -r repository branch; do
    directory=".policy-consumers/${repository#*/}"
    GH_TOKEN="${READER_AUTHORIZATION:?READER_AUTHORIZATION is required}" gh repo clone "${repository}" "${directory}" -- \
      --branch "${branch}" \
      --single-branch \
      --no-tags
  done < <(
    jq -r '.repositories[] | [.repository, .defaultBranch] | @tsv' \
      unity-enrollment-policy.json
  )
}

revalidate_heads() {
  failed=false
  record_finding() {
    local repository="$1"
    local sha="$2"
    local code="$3"
    local temporary
    temporary="$(mktemp "${RUNNER_TEMP:?RUNNER_TEMP is required}/unity-enrollment-audit.XXXXXX")"
    jq --arg repository "${repository}" --arg sha "${sha}" --arg code "${code}" \
      '.complete = false | .findings += [{repository: $repository, sha: $sha, code: $code}]' \
      "${AUDIT_PATH:?AUDIT_PATH is required}" > "${temporary}"
    mv "${temporary}" "${AUDIT_PATH}"
    failed=true
  }
  verify_head() {
    local repository="$1"
    local branch="$2"
    local directory="$3"
    local audited_sha=""
    local current_sha=""
    if [ -d "${directory}/.git" ]; then
      audited_sha="$(git -C "${directory}" rev-parse HEAD)"
    fi
    if ! current_sha="$(GH_TOKEN="${READER_AUTHORIZATION:?READER_AUTHORIZATION is required}" gh api "repos/${repository}/git/ref/heads/${branch}" --jq .object.sha)"; then
      record_finding "${repository}" "${audited_sha}" "default-branch-revalidation-incomplete"
    elif [ "${audited_sha}" != "${current_sha}" ]; then
      record_finding "${repository}" "${audited_sha}" "default-branch-advanced"
    fi
  }
  while IFS=$'\t' read -r repository branch; do
    verify_head \
      "${repository}" \
      "${branch}" \
      ".policy-consumers/${repository#*/}"
  done < <(
    jq -r '.repositories[] | [.repository, .defaultBranch] | @tsv' \
      unity-enrollment-policy.json
  )
  if [ "${failed}" = true ]; then
    exit 1
  fi
}

record_counts() {
  if [ ! -f "${AUDIT_PATH:?AUDIT_PATH is required}" ]; then
    echo "Unity enrollment audit artifact unavailable." >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
    exit 1
  fi
  expected_repositories="$(jq -r '.repositories | length' unity-enrollment-policy.json)"
  jq -r --arg expected "${expected_repositories}" \
    '"Repositories: \(.repositories | length)/\($expected)\nActive jobs: \(.inventory | length)\nFindings: \(.findings | length)\nComplete: \(.complete)"' \
    "${AUDIT_PATH}" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
  if [ "$(jq -r '.complete' "${AUDIT_PATH}")" != "true" ]; then
    echo "The organization audit is incomplete; policy status is unknown." >> "${GITHUB_STEP_SUMMARY}"
    exit 1
  fi
}

case "${1:-}" in
  resolve-scope) resolve_scope ;;
  clone-consumers) clone_consumers ;;
  revalidate-heads) revalidate_heads ;;
  record-counts) record_counts ;;
  *)
    echo "usage: $0 <resolve-scope|clone-consumers|revalidate-heads|record-counts>" >&2
    exit 2
    ;;
esac
