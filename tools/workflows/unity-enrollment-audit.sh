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

max_head_revalidation_attempts=3

revalidate_heads_once() {
  local stale_snapshots="$1"
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
  note_stale_snapshot() {
    local repository="$1"
    local branch="$2"
    printf '%s\t%s\n' "${repository}" "${branch}" >> "${stale_snapshots:?stale snapshot ledger is required}"
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
      note_stale_snapshot "${repository}" "${branch}"
      record_finding "${repository}" "${audited_sha}" "default-branch-revalidation-incomplete"
    elif [ "${audited_sha}" != "${current_sha}" ]; then
      note_stale_snapshot "${repository}" "${branch}"
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
  [ "${failed}" != true ]
}

refresh_stale_snapshots() {
  local stale_snapshots="$1"
  local repository
  local branch
  local directory
  while IFS=$'\t' read -r repository branch; do
    directory=".policy-consumers/${repository#*/}"
    rm -rf "${directory}"
    GH_TOKEN="${READER_AUTHORIZATION:?READER_AUTHORIZATION is required}" gh repo clone "${repository}" "${directory}" -- \
      --branch "${branch}" \
      --single-branch \
      --no-tags
  done < "${stale_snapshots:?stale snapshot ledger is required}"
  local analysis_status=0
  go run ./cmd/audit-unity-enrollment \
    --policy unity-enrollment-policy.json \
    --repositories-root .policy-consumers \
    --output "${AUDIT_PATH:?AUDIT_PATH is required}" || analysis_status=$?
  if [ "$(jq -r '.complete // false' "${AUDIT_PATH}")" != "true" ]; then
    echo "The audit re-analysis did not produce complete evidence (status ${analysis_status}); the audit fails closed." >&2
    return 1
  fi
}

revalidate_heads() {
  local attempt
  local stale_snapshots
  for ((attempt = 1; attempt <= max_head_revalidation_attempts; attempt++)); do
    stale_snapshots="$(mktemp "${RUNNER_TEMP:?RUNNER_TEMP is required}/unity-enrollment-stale.XXXXXX")"
    if revalidate_heads_once "${stale_snapshots}"; then
      rm -f "${stale_snapshots}"
      return 0
    fi
    if [ "${attempt}" -eq "${max_head_revalidation_attempts}" ]; then
      echo "Consumer default branches stayed stale for ${max_head_revalidation_attempts} revalidation attempts; the audit fails closed." >&2
      rm -f "${stale_snapshots}"
      return 1
    fi
    echo "Consumer default branches advanced while the audit read them; refreshing the stale snapshots." >&2
    refresh_stale_snapshots "${stale_snapshots}"
  done
}

# record_findings publishes every finding the audit wrote, so an operator reads
# the run instead of opening the drift issue. Every value in the table is bounded
# where it is produced: the repository name is a reviewed registry entry, the
# reason code is an analyzer constant, and the analyzer sanitizes the cause to an
# alphabet with no pipe, no backtick, and no newline. So the table needs no
# escaping. The workflow path, job, commit, and detail stay in the drift issue.
#
# The table is bounded; the annotation in record_verdict carries the full count
# of every reason code, so a bounded table still names every finding. A jq
# failure means this step read a finding it cannot render, which no green run may
# hide, so it fails closed instead of reporting a note and exiting zero.
record_findings() {
  if ! jq -r '
    .findings as $findings
    | ($findings | length) as $total
    | if $total == 0 then empty
      else "\n### Open drift\n\n| Repository | Reason | Cause |\n| --- | --- | --- |\n"
        + ($findings[0:20] | map(
            "| `\(.repository)` | `\(.code)` | \(if ((.cause // "") | length) > 0 then .cause else "-" end) |"
          ) | join("\n"))
        + (if $total > 20 then "\n_... and \($total - 20) more in the retained artifact._" else "" end)
        + "\n"
      end
  ' "${AUDIT_PATH:?AUDIT_PATH is required}" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"; then
    echo "Unity enrollment audit findings could not be published; the run proves nothing about drift." >> "${GITHUB_STEP_SUMMARY}"
    exit 1
  fi
}

# record_verdict states what the run's conclusion means. Consumer drift must not
# red a run this repository owns: a daily run that is red until every consumer
# fixes its policy teaches operators to ignore it, and it collides with the
# incomplete-audit red that does mean the audit failed. So a complete audit with
# findings keeps the run green and reports the drift in the run instead.
record_verdict() {
  local total reasons
  total="$(jq -r '.findings | length' "${AUDIT_PATH}")"
  if [ "${total}" -eq 0 ]; then
    echo "The organization audit is complete and clean. No drift is open." >> "${GITHUB_STEP_SUMMARY}"
    return 0
  fi
  reasons="$(jq -r '[.findings[].code] | group_by(.) | map("\(.[0]) x\(length)") | join(", ")' "${AUDIT_PATH}")"
  printf '::warning::%s open Unity enrollment findings: %s. A green run means the audit read every repository. Read the drift issue for the detail.\n' \
    "${total}" "${reasons}"
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
  record_findings
  if [ "$(jq -r '.complete' "${AUDIT_PATH}")" != "true" ]; then
    echo "The organization audit is incomplete; policy status is unknown." >> "${GITHUB_STEP_SUMMARY}"
    exit 1
  fi
  record_verdict
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
