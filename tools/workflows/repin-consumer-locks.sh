#!/usr/bin/env bash
set -euo pipefail

# Open reviewed pull requests that repin consumer lock action references to
# the newest authorized release. Consumers merge the pull request; this
# script never merges, never force-pushes, and never edits a default branch.
# A closed repin pull request is a consumer answer: the automation never
# re-offers that repin and never updates its branch underneath it.

# The reviewed enrollment policy that drives scope and repin exceptions.
# REPIN_POLICY_PATH overrides it for tests.
policy_path="${REPIN_POLICY_PATH:-unity-enrollment-policy.json}"
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
  # A reviewed, unexpired repin exception preserves one whole workflow file so
  # a pin-only update cannot move a caller to an action whose input contract
  # it cannot satisfy. Reviewed `repinCompanions` files carry the consumer
  # artifacts that derive from the pin (copyable docs, pin constants, policy
  # snapshots) through the same mechanical, mode-bound rewrite, so the repin
  # pull request is never born red.
  local directory="$1" target_sha="$2" target_version="$3" repository="$4"
  node - "${directory}" "${target_sha}" "${target_version}" "${policy_path}" "${lock_repository_prefix}" "${repository}" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const [directory, targetSha, targetVersion, policyPath, lockPrefix, repository] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(targetSha)) {
  throw new Error("Repins require a full lowercase 40-character commit SHA.");
}
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const lowered = (values) => new Set((values || []).map((value) => String(value).toLowerCase()));
if (!lowered(policy.approvedLockShas).has(targetSha) || !lowered(policy.approvedReturnShas).has(targetSha)) {
  throw new Error(`Refusing to repin to ${targetSha}: it is not authorized in both allowlists.`);
}
const exceptionPattern = /^\.github\/workflows\/[^/]+\.[yY][aA]?[mM][lL]$/;
const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const singleLine = (value) => !/[\r\n`]/.test(value);
const canonicalRepositories = new Map();
for (const value of Array.isArray(policy.repositories) ? policy.repositories : []) {
  canonicalRepositories.set(String(value.repository || "").toLowerCase(), String(value.repository || ""));
}
// Companion modes are the reviewed mechanical rewrites. They mirror the
// registry parser's validation, so a standalone rewrite cannot accept a
// policy the audit would reject.
const companionModes = new Set(["pin-lines", "pin-literal", "policy-snapshot"]);
const validCompanionPath = (value) =>
  typeof value === "string" && value.length > 0 &&
  !value.includes("\\") && !value.startsWith("/") && !value.startsWith("-") &&
  !value.startsWith(".github/") && singleLine(value) &&
  !value.split("/").includes("..") && path.posix.normalize(value) === value;
if (policy.repinExceptions !== undefined && !Array.isArray(policy.repinExceptions)) {
  throw new Error("Repins require repinExceptions to be a list when present.");
}
if (policy.repinCompanions !== undefined && !Array.isArray(policy.repinCompanions)) {
  throw new Error("Repins require repinCompanions to be a list when present.");
}
// Every entry must match the reviewed registry contract, including entries
// for other repositories, so a standalone rewrite cannot accept a policy the
// registry parser would reject.
const entries = policy.repinExceptions || [];
const seenExceptions = new Set();
for (const entry of entries) {
  const entryRepository = String(entry.repository || "");
  if (canonicalRepositories.get(entryRepository.toLowerCase()) !== entryRepository) {
    throw new Error("Repins require a registered canonical repository spelling in every repinExceptions entry.");
  }
  const entryPath = String(entry.path || "");
  if (!exceptionPattern.test(entryPath) || entryPath.includes("\\") ||
    !singleLine(entryPath) || entryPath.split("/").includes("..")) {
    throw new Error(`Repins require a normalized workflow path in repinExceptions; got ${entryPath}`);
  }
  if (!singleLine(String(entry.owner || "")) || !String(entry.owner || "").trim() ||
    !singleLine(String(entry.reason || "")) || !String(entry.reason || "").trim()) {
    throw new Error("Repins require a single-line owner and reason in every repinExceptions entry.");
  }
  const expiry = String(entry.expiresAt || "");
  if (!rfc3339Pattern.test(expiry) || !Number.isFinite(Date.parse(expiry))) {
    throw new Error(`Repins require an RFC3339 expiry in repinExceptions; got ${expiry}`);
  }
  const key = `${entryRepository.toLowerCase()}\u0000${entryPath}`;
  if (seenExceptions.has(key)) {
    throw new Error("Repins reject a duplicate repository/path repinExceptions entry.");
  }
  seenExceptions.add(key);
}
const companionEntries = policy.repinCompanions || [];
const seenCompanions = new Set();
for (const entry of companionEntries) {
  const entryRepository = String(entry.repository || "");
  if (canonicalRepositories.get(entryRepository.toLowerCase()) !== entryRepository) {
    throw new Error("Repins require a registered canonical repository spelling in every repinCompanions entry.");
  }
  const entryPath = String(entry.path || "");
  if (!validCompanionPath(entryPath)) {
    throw new Error(`Repins require a normalized repository-relative path outside .github in repinCompanions; got ${entryPath}`);
  }
  if (!companionModes.has(String(entry.mode || ""))) {
    throw new Error(`Repins require a reviewed mechanical mode in repinCompanions; got ${entry.mode}`);
  }
  const key = `${entryRepository.toLowerCase()}\u0000${entryPath}`;
  if (seenCompanions.has(key)) {
    throw new Error("Repins reject a duplicate repository/path repinCompanions entry.");
  }
  seenCompanions.add(key);
}
const exceptions = new Map();
for (const entry of entries) {
  if (entry.repository !== repository) {
    continue;
  }
  const expiry = Date.parse(String(entry.expiresAt));
  if (expiry <= Date.now()) {
    throw new Error(
      `The repin exception for ${entry.path} expired at ${entry.expiresAt}; renew or remove it before repinning.`
    );
  }
  exceptions.set(entry.path, entry);
}
const companions = [];
for (const entry of companionEntries) {
  if (entry.repository !== repository) {
    continue;
  }
  companions.push({ path: entry.path, mode: String(entry.mode) });
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
const report = { changed: 0, files: [], skipped: [], unmatched: [], companions: [], unmatchedCompanions: [] };
const matchedExceptions = new Set();
// The pins this rewrite removes, collected from the workflow lines it
// rewrites. Only these SHAs may move inside pin-literal companions, so a
// historical SHA quoted for another reason survives untouched.
const replacedPins = new Set();
const rewritePinLine = (line) => {
  const match = linePattern.exec(line);
  if (!match || match[2] === targetSha) {
    return line;
  }
  replacedPins.add(match[2]);
  let comment = match[3] || "";
  if (comment && targetVersion && versionCommentPattern.test(comment.trim())) {
    comment = ` # ${targetVersion}`;
  }
  return `${match[1]}${targetSha}${comment}`;
};
for (const filePath of files) {
  const relativePath = path.relative(directory, filePath).split(path.sep).join("/");
  const exception = exceptions.get(relativePath);
  if (exception) {
    matchedExceptions.add(relativePath);
    report.skipped.push({
      path: relativePath,
      owner: String(exception.owner || ""),
      expiresAt: String(exception.expiresAt || "")
    });
    continue;
  }
  const original = fs.readFileSync(filePath, "utf8");
  const lines = original.split("\n");
  let fileChanges = 0;
  const rewritten = lines.map((line) => {
    const rewrittenLine = rewritePinLine(line);
    if (rewrittenLine !== line) {
      fileChanges += 1;
    }
    return rewrittenLine;
  });
  if (fileChanges === 0) {
    continue;
  }
  fs.writeFileSync(filePath, `${rewritten.join("\n")}`, "utf8");
  report.changed += fileChanges;
  report.files.push({ path: relativePath, lines: fileChanges });
}
for (const [entryPath, entry] of exceptions) {
  if (!matchedExceptions.has(entryPath)) {
    report.unmatched.push({
      path: entryPath,
      owner: String(entry.owner || ""),
      expiresAt: String(entry.expiresAt || "")
    });
  }
}
const approvedListKey = /^approved[A-Za-z0-9]*Shas$/;
for (const companion of companions) {
  const companionPath = path.join(directory, ...companion.path.split("/"));
  if (!fs.existsSync(companionPath)) {
    report.unmatchedCompanions.push({ path: companion.path, mode: companion.mode });
    continue;
  }
  let companionChanges = 0;
  if (companion.mode === "pin-lines") {
    const lines = fs.readFileSync(companionPath, "utf8").split("\n");
    const rewritten = lines.map((line) => {
      const rewrittenLine = rewritePinLine(line);
      if (rewrittenLine !== line) {
        companionChanges += 1;
      }
      return rewrittenLine;
    });
    if (companionChanges > 0) {
      fs.writeFileSync(companionPath, `${rewritten.join("\n")}`, "utf8");
    }
  } else if (companion.mode === "pin-literal") {
    const original = fs.readFileSync(companionPath, "utf8");
    let updated = original;
    for (const replacedPin of [...replacedPins].sort()) {
      updated = updated.split(replacedPin).join(targetSha);
    }
    if (updated !== original) {
      companionChanges = 1;
      fs.writeFileSync(companionPath, updated, "utf8");
    }
  } else if (companion.mode === "policy-snapshot") {
    // Mirror the reviewed allowlists exactly: the same content a consumer
    // snapshot refresh derives from this policy, so the diff a reviewer reads
    // is the authorization delta and nothing else.
    const snapshot = {
      schemaVersion: policy.schemaVersion,
      organization: policy.organization
    };
    for (const [key, value] of Object.entries(policy)) {
      if (approvedListKey.test(key)) {
        snapshot[key] = value;
      }
    }
    const original = fs.readFileSync(companionPath, "utf8");
    const updated = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (updated !== original) {
      companionChanges = 1;
      fs.writeFileSync(companionPath, updated, "utf8");
    }
  }
  report.changed += companionChanges;
  report.companions.push({ path: companion.path, mode: companion.mode, lines: companionChanges });
}
process.stdout.write(`${JSON.stringify(report)}\n`);
EOF
}

open_repin_pull_request() {
  # One pull request body and create call, shared by the fresh-push path and
  # the identical-branch recovery path. Arguments are explicit so the two
  # paths cannot drift.
  local repository="$1" branch_name="$2" label="$3" target_sha="$4"
  local authorization="$5" file_list="$6" preserved_section="$7" companion_section="$8"
  local body_file
  body_file="$(mktemp "${RUNNER_TEMP:?RUNNER_TEMP is required}/repin-consumer-locks.XXXXXX")"
  cat > "${body_file}" <<EOF
Repin the organization lock actions to the authorized release ${label}
(\`${target_sha}\`).

## Review before merge (merge = the adoption decision)

- Only the \`@<sha>\` suffix of \`uses:\` references to
  \`${lock_repository_prefix%/*}\` changed, plus matching \`# vX.Y.Z\` comments.
- Reviewed companion artifacts named in the enrollment policy carry the
  consumer files that derive from the pin. Each one moves through one
  mechanical, mode-bound rewrite.
- Release authorization evidence: the central authorization pull request for
  this release, merged by a maintainer.
- Changed references:
\`\`\`
${file_list}
\`\`\`
${companion_section}${preserved_section}
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
    if ! report="$(rewrite_pins "${directory}" "${target_sha}" "${target_version}" "${repository}")"; then
      echo "::error::${repository}: could not rewrite the lock references." >&2
      exit 1
    fi
    local changed
    if ! changed="$(printf '%s' "${report}" | jq -er '.changed')"; then
      echo "::error::${repository}: could not read the rewrite report." >&2
      exit 1
    fi
    local preserved preserved_count
    if ! preserved="$(printf '%s' "${report}" | jq -r '
      .skipped[] | "- `\(.path)` preserved; reviewed by \(.owner) until \(.expiresAt)"
    ')" || ! preserved_count="$(printf '%s' "${report}" | jq -er '.skipped | length')"; then
      echo "::error::${repository}: could not read the rewrite report." >&2
      exit 1
    fi
    local unmatched
    if ! unmatched="$(printf '%s' "${report}" | jq -r '
      .unmatched[] | "- `\(.path)` names a repin exception but no file exists at that path; remove the exception"
    ')" || ! printf '%s' "${report}" | jq -e '.unmatched' >/dev/null; then
      echo "::error::${repository}: could not read the rewrite report." >&2
      exit 1
    fi
    local companions companion_count
    if ! companions="$(printf '%s' "${report}" | jq -r '
      .companions[] | "- `\(.path)` (\(.mode); \(.lines) line\(if .lines == 1 then "" else "s" end))"
    ')" || ! companion_count="$(printf '%s' "${report}" | jq -er '.companions | length')"; then
      echo "::error::${repository}: could not read the rewrite report." >&2
      exit 1
    fi
    local unmatched_companions
    if ! unmatched_companions="$(printf '%s' "${report}" | jq -r '
      .unmatchedCompanions[] | "- `\(.path)` (\(.mode)) names a repin companion but no file exists at that path; review the enrollment policy entry"
    ')" || ! printf '%s' "${report}" | jq -e '.unmatchedCompanions' >/dev/null; then
      echo "::error::${repository}: could not read the rewrite report." >&2
      exit 1
    fi
    if [ -n "${preserved}" ]; then
      printf '%s\n' "${preserved}"
    fi
    if [ -n "${unmatched}" ]; then
      printf '%s\n' "${unmatched}" >&2
    fi
    if [ -n "${unmatched_companions}" ]; then
      printf '%s\n' "${unmatched_companions}" >&2
    fi
    local companion_section=""
    if [ "${companion_count}" != "0" ] || [ -n "${unmatched_companions}" ]; then
      companion_section="
## Reviewed companion artifacts

These policy-reviewed files derive their content from the pin. Each one moved
through its reviewed mechanical rewrite:

${companions}
"
      if [ -n "${unmatched_companions}" ]; then
        companion_section="${companion_section}
### Missing companion files

${unmatched_companions}
"
      fi
    fi
    if [ "${changed}" = "0" ]; then
      if [ "${preserved_count}" != "0" ]; then
        printf '%s\n' "| \`${repository}\` | already pinned to \`${label}\`; ${preserved_count} file(s) preserved by reviewed repin exceptions |" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
      else
        printf '%s\n' "| \`${repository}\` | already pinned to \`${label}\` |" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
      fi
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
    local closed_prs
    if ! closed_prs="$(GH_TOKEN="${authorization}" gh pr list \
      --repo "${repository}" \
      --head "${branch_name}" \
      --state closed \
      --json number \
      --jq length)" || ! [[ "${closed_prs}" =~ ^[0-9]+$ ]]; then
      echo "::error::${repository}: could not list closed repin pull requests." >&2
      exit 1
    fi
    if [ "${closed_prs}" != "0" ]; then
      # Merging or closing the repin pull request is the consumer's adoption
      # decision. Re-offering the same repin would override that decision, so
      # the repository is skipped and the summary records the state.
      printf '%s\n' "${repository}: a repin pull request for ${label} was closed; the automation left the closed repin pull request in place." >&2
      printf '%s\n' "| \`${repository}\` | repin pull request for \`${label}\` was closed; consumers decide adoption |" >> "${GITHUB_STEP_SUMMARY}"
      exit 0
    fi
    if ! git -C "${directory}" checkout -B "${branch_name}"; then
      echo "::error::${repository}: could not create ${branch_name}." >&2
      exit 1
    fi
    git -C "${directory}" config user.name "github-actions[bot]"
    git -C "${directory}" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git -C "${directory}" add .github
    # Companion paths are validated normalized repository-relative paths with
    # no option-like leading dash, so the explicit -- guard is sufficient.
    local companion_paths
    if ! companion_paths="$(printf '%s' "${report}" | jq -r '.companions[] | select(.lines > 0) | .path')"; then
      echo "::error::${repository}: could not read the companion paths from the rewrite report." >&2
      exit 1
    fi
    while IFS= read -r companion_path; do
      if [ -z "${companion_path}" ]; then
        continue
      fi
      if ! git -C "${directory}" add -- "${companion_path}"; then
        echo "::error::${repository}: could not stage the companion artifact ${companion_path}." >&2
        exit 1
      fi
    done <<< "${companion_paths}"
    if git -C "${directory}" diff --cached --quiet; then
      echo "::error::${repository}: staged repin is empty but ${changed} lines were rewritten." >&2
      exit 1
    fi
    if ! git -C "${directory}" commit -m "chore: repin organization lock actions to ${label}"; then
      echo "::error::${repository}: could not commit the repin." >&2
      exit 1
    fi
    local file_list
    file_list="$(printf '%s' "${report}" | jq -r '.files[] | "- `\(.path)` (\(.lines) line\(if .lines == 1 then "" else "s" end))"' )"
    local preserved_section=""
    if [ "${preserved_count}" != "0" ]; then
      preserved_section="
## Preserved compatibility exceptions

These files kept their current pins. A reviewed repin exception protects each
caller because a pin-only update would break its input contract:

${preserved}
"
    fi
    local remote_tip
    if ! remote_tip="$(CONSUMER_PUSH_AUTHORIZATION="${authorization}" git -C "${directory}" \
      -c credential.helper= \
      -c 'credential.helper=!f() { printf "username=build-lock-repin\npassword=%s\n" "${CONSUMER_PUSH_AUTHORIZATION}"; }; f' \
      ls-remote "https://github.com/${repository}.git" "refs/heads/${branch_name}" |
      cut -f1)" || [[ "${remote_tip}" =~ [^0-9a-f] ]]; then
      echo "::error::${repository}: could not read the remote repin branch state." >&2
      exit 1
    fi
    if [ -n "${remote_tip}" ]; then
      # The branch already exists without an open or closed pull request: a
      # previous run pushed it but could not open the pull request. Reuse it
      # only when its content is exactly this repin's content. The automation
      # never force-updates a branch that holds other work.
      if ! CONSUMER_PUSH_AUTHORIZATION="${authorization}" git -C "${directory}" \
        -c credential.helper= \
        -c 'credential.helper=!f() { printf "username=build-lock-repin\npassword=%s\n" "${CONSUMER_PUSH_AUTHORIZATION}"; }; f' \
        fetch --depth 1 "https://github.com/${repository}.git" "${branch_name}"; then
        echo "::error::${repository}: could not fetch the existing repin branch." >&2
        exit 1
      fi
      local remote_tree local_tree
      if ! remote_tree="$(git -C "${directory}" rev-parse 'FETCH_HEAD^{tree}')" ||
        ! local_tree="$(git -C "${directory}" rev-parse 'HEAD^{tree}')"; then
        echo "::error::${repository}: could not compare the existing repin branch content." >&2
        exit 1
      fi
      if [ "${remote_tree}" != "${local_tree}" ]; then
        printf '%s\n' "${repository}: an existing repin branch holds different content; the automation left the stale repin branch untouched." >&2
        printf '%s\n' "| \`${repository}\` | existing repin branch has different content; left untouched |" >> "${GITHUB_STEP_SUMMARY}"
        exit 0
      fi
      open_repin_pull_request \
        "${repository}" "${branch_name}" "${label}" "${target_sha}" \
        "${authorization}" "${file_list}" "${preserved_section}" "${companion_section}"
      printf '%s\n' "| \`${repository}\` | opened repin pull request to \`${label}\` from the existing branch |" >> "${GITHUB_STEP_SUMMARY}"
      exit 0
    fi
    if ! CONSUMER_PUSH_AUTHORIZATION="${authorization}" git -C "${directory}" \
      -c credential.helper= \
      -c 'credential.helper=!f() { printf "username=build-lock-repin\npassword=%s\n" "${CONSUMER_PUSH_AUTHORIZATION}"; }; f' \
      push "https://github.com/${repository}.git" "${branch_name}"; then
      echo "::error::${repository}: could not push ${branch_name}." >&2
      exit 1
    fi
    open_repin_pull_request \
      "${repository}" "${branch_name}" "${label}" "${target_sha}" \
      "${authorization}" "${file_list}" "${preserved_section}" "${companion_section}"
    local lines_word="lines"
    if [ "${changed}" = "1" ]; then
      lines_word="line"
    fi
    if [ "${preserved_count}" != "0" ]; then
      printf '%s\n' "| \`${repository}\` | opened repin pull request to \`${label}\` (${changed} ${lines_word}; ${preserved_count} file(s) preserved) |" >> "${GITHUB_STEP_SUMMARY}"
    else
      printf '%s\n' "| \`${repository}\` | opened repin pull request to \`${label}\` (${changed} ${lines_word}) |" >> "${GITHUB_STEP_SUMMARY}"
    fi
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
    echo "usage: $0 <resolve-scope|rewrite-pins <directory> <target-sha> <target-version> <repository>|repin-consumers>" >&2
    exit 2
    ;;
esac
