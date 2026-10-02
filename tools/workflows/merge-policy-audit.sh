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

# refuse_publish reports that this step cannot publish what the audit wrote, and
# fails the run. No green run may claim a verdict it did not read. The subject
# names what could not be published: the findings, the drift table, or the
# verdict.
refuse_publish() {
  echo "${1} could not be published; the run proves nothing about drift." >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
  exit 1
}

# require_readable_findings refuses an artifact whose findings cannot be
# published below. Every finding must name a non-empty repository and a reason
# code, and the reason code also reaches a workflow command. A finding that names
# neither is evidence this step did not read, so the run fails closed. The reason code
# shape is the rule both drift issue readers already apply to that field. The
# repository and the cause are bounded where the analyzer produces them: one is a
# validated registry entry, the other is a sanitized reason.
require_readable_findings() {
  if ! jq -e '(.findings | type) == "array" and all(.findings[];
    (.repository | type) == "string" and (.repository | length) > 0 and
    (.code | type) == "string" and
    (.code | test("^[a-z0-9][a-z0-9-]{0,79}$")) and
    ((.cause // "") | type) == "string"
  )' "${AUDIT_PATH:?AUDIT_PATH is required}" >/dev/null; then
    refuse_publish "Merge policy audit findings"
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
#
# Unlike the table above, this one does not degrade to a note. It is the only
# place the run names the drifted repositories, so a note would leave a green run
# with no repository in it. It fails the run instead.
record_drift() {
  if ! jq -r '
    if (.findings | length) == 0 then empty
    else
      [ .findings[] ]
      | group_by(.repository)
      | map("| `\(.[0].repository)` | \(length) | \(map(.code) | unique | map("`\(.)`") | join(", ")) |")
      | "### Open drift\n\n| Repository | Findings | Reasons |\n| --- | --- | --- |\n"
        + (join("\n"))
        + "\n"
    end
  ' "${AUDIT_PATH:?AUDIT_PATH is required}" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"; then
    refuse_publish "Merge policy audit drift"
  fi
}

# record_verdict states what a green run means. A complete audit with findings
# keeps the run green. The counts, the two tables, and the annotation below name
# every repository and every reason code. The drift issue is not the only
# signal. A complete audit with no findings says so, so a clean run cannot be
# read as a silent one.
#
# Consumer drift stays green on purpose. This repository does not own a
# consumer's merge policy. A daily run that keeps failing teaches operators to
# ignore it. That failure would also hide an incomplete audit, which is the
# failure that does matter.
record_verdict() {
  local summary
  if ! summary="$(jq -r '
    [ .findings[] ] as $findings
    | ($findings | group_by(.repository) | length) as $repositories
    | ($findings | map(.code) | group_by(.) | map("\(.[0]) x\(length)") | join(", ")) as $reasons
    | if $findings | length == 0
      then "clean"
      else "\($findings | length) open merge policy findings across \($repositories) repositories: \($reasons)"
      end
  ' "${AUDIT_PATH:?AUDIT_PATH is required}")"; then
    refuse_publish "Merge policy audit verdict"
  fi
  if [ "${summary}" = "clean" ]; then
    echo "The merge policy audit is complete and clean. No drift is open." >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
    return 0
  fi
  printf '::warning::%s. A green run means the audit read every repository. Read the drift issue for the detail.\n' \
    "${summary}" >&2
}

record_counts() {
  if [ ! -f "${AUDIT_PATH:?AUDIT_PATH is required}" ]; then
    echo "Merge policy audit artifact unavailable." >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
    exit 1
  fi
  require_readable_findings
  expected_repositories="$(jq -r '.repositories | length' merge-policy-expectations.json)"
  jq -r --arg expected "${expected_repositories}" \
    '"Repositories: \(.repositories | length)/\($expected)\nObserved required checks: \(.inventory | length)\nFindings: \(.findings | length)\nComplete: \(.complete)"' \
    "${AUDIT_PATH}" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
  record_causes
  record_drift
  if [ "$(jq -r '.complete' "${AUDIT_PATH}")" != "true" ]; then
    echo "The merge policy audit is incomplete; merge-gate status is unknown." >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
    exit 1
  fi
  record_verdict
}

case "${1:-}" in
  resolve-scope) resolve_scope ;;
  record-counts) record_counts ;;
  *)
    echo "usage: $0 <resolve-scope|record-counts>" >&2
    exit 2
    ;;
esac
