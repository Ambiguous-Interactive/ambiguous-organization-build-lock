#!/usr/bin/env bash
set -euo pipefail

# Open reviewed pull requests that repin consumer lock action references to
# the newest authorized release. Consumers merge the pull request; this
# script never merges, never force-pushes, and never edits a default branch.

policy_path="unity-enrollment-policy.json"
lock_repository_prefix="Ambiguous-Interactive/ambiguous-organization-build-lock/"

resolve_scope() {
  go run ./cmd/audit-unity-enrollment \
    --policy "${policy_path}" \
    --validate-policy-only
  local count
  count="$(jq -er '.repositories | length' "${policy_path}")"
  if [ "${count}" -lt 6 ]; then
    echo "The Unity enrollment baseline is incomplete." >&2
    exit 1
  fi
  local repositories
  repositories="$(jq -r '.repositories[].repository | split("/")[1]' "${policy_path}" |
    LC_ALL=C sort |
    paste -sd, -)"
  if [ -z "${repositories}" ]; then
    echo "The Unity enrollment repin scope is empty." >&2
    exit 1
  fi
  echo "repositories=${repositories}" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
}

resolve_repin_target() {
  # The repin target is the newest authorized release, never the newest
  # published release. Authorization is the human merge of the release
  # authorization pull request, so the target must resolve to a reviewed
  # release tag that both allowlists approve.
  git fetch --force origin 'refs/tags/v*:refs/tags/v*' >/dev/null 2>&1 || {
    echo "Could not fetch release tags for repin target resolution." >&2
    exit 1
  }
  local target="" target_version=""
  local sha tag
  while IFS= read -r sha; do
    [ -n "${sha}" ] || continue
    tag="$(git tag --points-at "${sha}" 2>/dev/null |
      grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' |
      LC_ALL=C sort -V |
      tail -n1 || true)"
    if [ -z "${tag}" ]; then
      continue
    fi
    if [ -z "${target_version}" ] ||
      [ "$(printf '%s\n%s\n' "${target_version}" "${tag}" | LC_ALL=C sort -V | tail -n1)" = "${tag}" ]; then
      target="${sha}"
      target_version="${tag}"
    fi
  done < <(jq -r '.approvedLockShas[]' "${policy_path}")
  if [ -z "${target}" ]; then
    echo "No authorized lock SHA resolves to a release tag; refusing to guess a repin target." >&2
    exit 1
  fi
  if ! jq -e --arg sha "${target}" '.approvedReturnShas | index($sha)' "${policy_path}" >/dev/null; then
    echo "Repins require the target in approvedReturnShas; ${target} is missing." >&2
    exit 1
  fi
  printf '%s\t%s\n' "${target}" "${target_version}"
}

rewrite_pins() {
  # Mechanical mutation contract: replace only the 40-hex reference suffix on
  # `uses:` lines that name this repository's actions, and normalize a trailing
  # `# vX.Y.Z` comment when the release tag is known. Everything else is
  # untouched, and the target must already be authorized in both allowlists.
  local directory="$1" target_sha="$2" target_version="$3"
  node - "${directory}" "${target_sha}" "${target_version}" "${policy_path}" "${lock_repository_prefix}" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const [directory, targetSha, targetVersion, policyPath, lockPrefix] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(targetSha)) {
  throw new Error("Repins require a full lowercase 40-character commit SHA.");
}
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const lowered = (values) => new Set((values || []).map((value) => String(value).toLowerCase()));
if (!lowered(policy.approvedLockShas).has(targetSha) || !lowered(policy.approvedReturnShas).has(targetSha)) {
  throw new Error(`Refusing to repin to ${targetSha}: it is not authorized in both allowlists.`);
}
const linePattern =
  /^(\s*(?:-\s+)?uses:\s*Ambiguous-Interactive\/ambiguous-organization-build-lock\/\S+?@)([0-9a-f]{40})(\s+#.*)?$/;
const versionCommentPattern = /^#\s*v\d+\.\d+\.\d+$/;
const files = [];
const visit = (entry) => {
  for (const item of fs.readdirSync(entry, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const itemPath = path.join(entry, item.name);
    if (item.isDirectory()) {
      visit(itemPath);
    } else if (/\.(yml|yaml)$/.test(item.name)) {
      files.push(itemPath);
    }
  }
};
visit(path.join(directory, ".github"));
const report = { changed: 0, files: [] };
for (const filePath of files) {
  const original = fs.readFileSync(filePath, "utf8");
  const lines = original.split("\n");
  let fileChanges = 0;
  const rewritten = lines.map((line) => {
    const match = linePattern.exec(line);
    if (!match || match[2] === targetSha) {
      return line;
    }
    fileChanges += 1;
    let comment = match[3] || "";
    if (comment && targetVersion && versionCommentPattern.test(comment.trim())) {
      comment = ` # ${targetVersion}`;
    }
    return `${match[1]}${targetSha}${comment}`;
  });
  if (fileChanges === 0) {
    continue;
  }
  fs.writeFileSync(filePath, `${rewritten.join("\n")}`, "utf8");
  report.changed += fileChanges;
  report.files.push({ path: path.relative(directory, filePath), lines: fileChanges });
}
process.stdout.write(`${JSON.stringify(report)}\n`);
EOF
}

repin_consumer() {
  # The caller inspects this function's result, which makes bash ignore
  # errexit for the whole body, including subshells. Every fallible command
  # therefore carries an explicit status guard; a tolerated failure here
  # would be a false-success repin report.
  (
    local repository="$1" branch="$2" target_sha="$3" target_version="$4" authorization="$5"
    local directory="consumers/${repository#*/}"
    local label="${target_version:-${target_sha:0:7}}"
    local branch_name="automation/repin-lock-${target_sha:0:7}"
    rm -rf "${directory}"
    if ! GH_TOKEN="${authorization}" gh repo clone "${repository}" "${directory}" -- \
      --branch "${branch}" \
      --single-branch \
      --no-tags \
      --depth 1; then
      echo "::error::${repository}: could not clone ${branch}." >&2
      exit 1
    fi
    local report
    if ! report="$(rewrite_pins "${directory}" "${target_sha}" "${target_version}")"; then
      echo "::error::${repository}: could not rewrite the lock references." >&2
      exit 1
    fi
    local changed
    if ! changed="$(printf '%s' "${report}" | jq -er '.changed')"; then
      echo "::error::${repository}: could not read the rewrite report." >&2
      exit 1
    fi
    if [ "${changed}" = "0" ]; then
      printf '%s\n' "| \`${repository}\` | already pinned to \`${label}\` |" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
      exit 0
    fi
    local open_prs
    if ! open_prs="$(GH_TOKEN="${authorization}" gh pr list \
      --repo "${repository}" \
      --head "${branch_name}" \
      --state open \
      --json number \
      --jq length)" || ! [[ "${open_prs}" =~ ^[0-9]+$ ]]; then
      echo "::error::${repository}: could not list open repin pull requests." >&2
      exit 1
    fi
    if [ "${open_prs}" != "0" ]; then
      printf '%s\n' "| \`${repository}\` | repin pull request for \`${label}\` is already open |" >> "${GITHUB_STEP_SUMMARY}"
      exit 0
    fi
    if ! git -C "${directory}" checkout -B "${branch_name}"; then
      echo "::error::${repository}: could not create ${branch_name}." >&2
      exit 1
    fi
    git -C "${directory}" config user.name "github-actions[bot]"
    git -C "${directory}" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git -C "${directory}" add .github
    if git -C "${directory}" diff --cached --quiet; then
      echo "::error::${repository}: staged repin is empty but ${changed} lines were rewritten." >&2
      exit 1
    fi
    if ! git -C "${directory}" commit -m "chore: repin organization lock actions to ${label}"; then
      echo "::error::${repository}: could not commit the repin." >&2
      exit 1
    fi
    if ! CONSUMER_PUSH_AUTHORIZATION="${authorization}" git -C "${directory}" \
      -c credential.helper= \
      -c 'credential.helper=!f() { printf "username=build-lock-repin\npassword=%s\n" "${CONSUMER_PUSH_AUTHORIZATION}"; }; f' \
      push "https://github.com/${repository}.git" "${branch_name}"; then
      echo "::error::${repository}: could not push ${branch_name}." >&2
      exit 1
    fi
    local body_file
    body_file="$(mktemp "${RUNNER_TEMP:?RUNNER_TEMP is required}/repin-consumer-locks.XXXXXX")"
    local file_list
    file_list="$(printf '%s' "${report}" | jq -r '.files[] | "- `\(.path)` (\(.lines) line\(if .lines == 1 then "" else "s" end))"' )"
    cat > "${body_file}" <<EOF
Repin the organization lock actions to the authorized release ${label}
(\`${target_sha}\`).

## Review before merge (merge = the adoption decision)

- Only the \`@<sha>\` suffix of \`uses:\` references to
  \`${lock_repository_prefix%/*}\` changed, plus matching \`# vX.Y.Z\` comments.
- Release authorization evidence: the central authorization pull request for
  this release, merged by a maintainer.
- Changed references:
\`\`\`
${file_list}
\`\`\`

This pull request is opened by central automation. It never merges itself and
never edits a default branch.
EOF
    if ! GH_TOKEN="${authorization}" gh pr create \
      --repo "${repository}" \
      --head "${branch_name}" \
      --title "Repin organization lock actions to ${label}" \
      --body-file "${body_file}"; then
      echo "::error::${repository}: could not open the repin pull request." >&2
      exit 1
    fi
    rm -f "${body_file}"
    printf '%s\n' "| \`${repository}\` | opened repin pull request to \`${label}\` (${changed} lines) |" >> "${GITHUB_STEP_SUMMARY}"
  )
}

repin_consumers() {
  local authorization="${CONSUMER_AUTHORIZATION:?CONSUMER_AUTHORIZATION is required}"
  : "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
  local target_line target_sha target_version
  if ! target_line="$(resolve_repin_target)"; then
    echo "::error::Could not resolve the repin target from the reviewed policy." >&2
    exit 1
  fi
  target_sha="${target_line%%$'\t'*}"
  target_version="${target_line##*$'\t'}"
  local failed=false
  local repository branch
  while IFS=$'\t' read -r repository branch; do
    if ! repin_consumer "${repository}" "${branch}" "${target_sha}" "${target_version}" "${authorization}"; then
      printf '%s\n' "| \`${repository}\` | failed; see the job log |" >> "${GITHUB_STEP_SUMMARY}"
      failed=true
    fi
  done < <(jq -r '.repositories[] | [.repository, .defaultBranch] | @tsv' "${policy_path}")
  if [ "${failed}" = true ]; then
    echo "::error::At least one consumer repin failed; the run is red so the gap stays visible." >&2
    exit 1
  fi
}

case "${1:-}" in
  resolve-scope) resolve_scope ;;
  rewrite-pins)
    shift
    rewrite_pins "$@"
    ;;
  repin-consumers) repin_consumers ;;
  *)
    echo "usage: $0 <resolve-scope|rewrite-pins <directory> <target-sha> <target-version>|repin-consumers>" >&2
    exit 2
    ;;
esac
