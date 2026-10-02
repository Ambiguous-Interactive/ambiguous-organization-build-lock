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

# require_readable_findings refuses an artifact whose findings cannot be
# published below. Every finding must name a repository and a reason code, and
# the reason code also reaches a workflow command. A finding that carries neither
# is evidence this step did not read, so the run fails closed. The shape matches
# the rule both drift issue readers already apply to the same field.
require_readable_findings() {
  if ! jq -e '(.findings | type) == "array" and all(.findings[];
    (.repository | type) == "string" and
    (.code | type) == "string" and
    (.code | test("^[a-z0-9][a-z0-9-]{0,79}$")) and
    ((.cause // "") | type) == "string"
  )' "${AUDIT_PATH:?AUDIT_PATH is required}" >/dev/null; then
    echo "Unity enrollment audit findings could not be published; the run proves nothing about drift." >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
    exit 1
  fi
}

# record_causes publishes every finding that names a refusal cause, so an
# operator reads the file or the reason in the run summary instead of opening a
# consumer checkout. The drift issue keeps counts, codes, and reviewed
# expectation text, because a cause can name a consumer-controlled file.
#
# The analyzer sanitizes every cause to an alphabet with no pipe, no backtick,
# and no newline, so the table needs no escaping. A finding with no cause has no
# row here, so every row names a specific read and a specific reason.
#
# The table is bounded; the retained artifact holds the complete set. A jq
# failure here must not skip the incomplete line below, so it is reported rather
# than aborting the step.
record_causes() {
  jq -r '
    [ .findings[] | select(((.cause // "") | length) > 0) ] as $causes
    | ($causes | length) as $total
    | if $total == 0 then empty
      else "### Refused evidence\n\n| Repository | Reason | Cause |\n| --- | --- | --- |\n"
        + ($causes[0:20] | map("| `\(.repository)` | `\(.code)` | \(.cause) |") | join("\n"))
        + (if $total > 20 then "\n_... and \($total - 20) more in the retained artifact._" else "" end)
        + "\n"
      end
  ' "${AUDIT_PATH:?AUDIT_PATH is required}" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}" ||
    echo "Refusal causes could not be read from the retained artifact." >> "${GITHUB_STEP_SUMMARY}"
}

# record_drift names every repository that carries a finding. The table above
# publishes the reads that failed. This one publishes the repositories that
# drifted, which is the rest of what an operator needs. One row per repository,
# so its length is the number of drifted repositories and not the number of
# findings. A repository can carry many findings.
record_drift() {
  jq -r '
    if (.findings | length) == 0 then empty
    else
      [ .findings[] ]
      | group_by(.repository)
      | map("| `\(.[0].repository)` | \(length) | \(map(.code) | unique | map("`\(.)`") | join(", ")) |")
      | "### Open drift\n\n| Repository | Findings | Reasons |\n| --- | --- | --- |\n"
        + (join("\n"))
        + "\n"
    end
  ' "${AUDIT_PATH:?AUDIT_PATH is required}" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
}

# record_verdict states what a green run means. A complete audit with findings
# keeps the run green. The counts, the two tables, and the annotation below name
# every repository and every reason code. The drift issue is not the only
# signal. A complete audit with no findings says so, so a clean run cannot be
# read as a silent one.
#
# Consumer drift stays green on purpose. This repository does not own a
# consumer's enrollment policy. A daily run that keeps failing teaches operators
# to ignore it. That failure would also hide an incomplete audit, which is the
# failure that does matter.
record_verdict() {
  local summary
  summary="$(jq -r '
    [ .findings[] ] as $findings
    | ($findings | group_by(.repository) | length) as $repositories
    | ($findings | map(.code) | group_by(.) | map("\(.[0]) x\(length)") | join(", ")) as $reasons
    | if $findings | length == 0
      then "clean"
      else "\($findings | length) open Unity enrollment findings across \($repositories) repositories: \($reasons)"
      end
  ' "${AUDIT_PATH:?AUDIT_PATH is required}")"
  if [ "${summary}" = "clean" ]; then
    echo "The Unity enrollment audit is complete and clean. No drift is open." >> "${GITHUB_STEP_SUMMARY}"
    return 0
  fi
  printf '::warning::%s. A green run means the audit read every repository. Read the drift issue for the detail.\n' \
    "${summary}"
}

record_counts() {
  if [ ! -f "${AUDIT_PATH:?AUDIT_PATH is required}" ]; then
    echo "Unity enrollment audit artifact unavailable." >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
    exit 1
  fi
  require_readable_findings
  expected_repositories="$(jq -r '.repositories | length' unity-enrollment-policy.json)"
  jq -r --arg expected "${expected_repositories}" \
    '"Repositories: \(.repositories | length)/\($expected)\nActive jobs: \(.inventory | length)\nFindings: \(.findings | length)\nComplete: \(.complete)"' \
    "${AUDIT_PATH}" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
  record_causes
  record_drift
  if [ "$(jq -r '.complete' "${AUDIT_PATH}")" != "true" ]; then
    echo "The Unity enrollment audit is incomplete; policy status is unknown." >> "${GITHUB_STEP_SUMMARY}"
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
