#!/usr/bin/env bash
set -euo pipefail

# Open the reviewed pull request that authorizes a published release for
# consumer pins. Merging that pull request is the human authorization
# decision; this script never merges, edits the live policy on main, or
# approves anything by itself.

RELEASE_VERSION="${RELEASE_VERSION:-}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
policy_path="unity-enrollment-policy.json"

sha_is_authorized() {
  local release_sha="$1"
  node - "${release_sha}" "${policy_path}" <<'EOF'
const fs = require("node:fs");
const [releaseSha, policyPath] = process.argv.slice(2);
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
process.stdout.write(String(policy.approvedLockShas.includes(releaseSha)));
EOF
}

if [[ ! -f "${policy_path}" ]]; then
  echo "::error::Missing ${policy_path}." >&2
  exit 1
fi

# The step runs on every workflow run, not only when a release was just
# published. Without an explicit version, authorize the newest published
# release if the policy does not list it yet, so a failed run is retried by
# the next scheduled or manual run instead of staying silent. A superseded
# release that was never authorized is never re-offered.
if [[ -z "${RELEASE_VERSION}" ]]; then
  if ! newest_tag="$(gh api "repos/${GITHUB_REPOSITORY}/releases?per_page=30" \
    --jq '[.[] | select(.draft == false and .prerelease == false and (.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")))] | sort_by(.tag_name | ltrimstr("v") | split(".") | map(tonumber)) | reverse | .[0].tag_name' | tr -d '"')"; then
    echo "::error::Could not list published releases for authorization discovery." >&2
    exit 1
  fi
  if [[ -z "${newest_tag}" || "${newest_tag}" == "null" ]]; then
    echo "No published release exists to authorize."
    exit 0
  fi
  if ! git fetch --force origin "refs/tags/${newest_tag}:refs/tags/${newest_tag}" >/dev/null 2>&1; then
    echo "::error::Could not examine the newest published release tag; refusing to claim the newest published release is authorized." >&2
    exit 1
  fi
  newest_sha="$(git rev-parse "${newest_tag}^{commit}" 2>/dev/null)" || {
    echo "::error::Could not resolve the newest published release tag; refusing to claim the newest published release is authorized." >&2
    exit 1
  }
  if [[ ! "${newest_sha}" =~ ^[a-f0-9]{40}$ ]]; then
    echo "::error::Newest release commit is not a full SHA; refusing to claim the newest published release is authorized." >&2
    exit 1
  fi
  if [[ "$(sha_is_authorized "${newest_sha}")" == "true" ]]; then
    echo "Every published release is already authorized."
    exit 0
  fi
  RELEASE_VERSION="${newest_tag#v}"
fi

git fetch --force origin "refs/tags/v${RELEASE_VERSION}:refs/tags/v${RELEASE_VERSION}"
release_sha="$(git rev-parse "v${RELEASE_VERSION}^{commit}")"

if [[ ! "${release_sha}" =~ ^[a-f0-9]{40}$ ]]; then
  echo "::error::Release commit is not a full SHA: ${release_sha}" >&2
  exit 1
fi

if [[ "$(sha_is_authorized "${release_sha}")" == "true" ]]; then
  echo "Release ${RELEASE_VERSION} (${release_sha}) is already authorized."
  exit 0
fi

previous_sha="$(node - <<'EOF'
const fs = require("node:fs");
const policy = JSON.parse(fs.readFileSync("unity-enrollment-policy.json", "utf8"));
const shas = policy.approvedLockShas;
if (!Array.isArray(shas) || shas.length === 0) {
  process.exit(1);
}
process.stdout.write(shas[shas.length - 1]);
EOF
)"

changed_files="$(git diff --name-only "${previous_sha}" "${release_sha}" -- .github/actions .github/dist)"
if [[ -z "${changed_files}" ]]; then
  changed_files="None; the public action and runtime surface is unchanged."
fi

branch="release-authorization/v${RELEASE_VERSION}"
open_prs="$(gh pr list --head "${branch}" --state open --json number --jq length)"
if [[ "${open_prs}" != "0" ]]; then
  echo "An authorization pull request for ${RELEASE_VERSION} is already open."
  exit 0
fi
# A closed-without-merge authorization pull request is a declined release.
# Re-offering it would override that reviewed decision.
declined_prs="$(gh pr list --head "${branch}" --state closed --json state --jq '[.[] | select(.state == "CLOSED")] | length')"
if [[ "${declined_prs}" != "0" ]]; then
  echo "A prior authorization pull request for ${RELEASE_VERSION} was closed without merging; not re-offering."
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
# Branch from the live default branch, before any file mutation, so a policy
# change on main since the release cannot block this retry with a dirty file.
git checkout -B "${branch}" origin/main

node - "${release_sha}" "${policy_path}" <<'EOF'
const fs = require("node:fs");
const [releaseSha, policyPath] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(releaseSha)) {
  throw new Error("Release SHA is not a full lowercase commit SHA.");
}
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
for (const key of ["approvedLockShas", "approvedReturnShas"]) {
  if (!Array.isArray(policy[key])) {
    throw new Error(`${key} must be an array.`);
  }
  if (policy[key].includes(releaseSha)) {
    throw new Error(`${releaseSha} is already listed in ${key}.`);
  }
  policy[key].push(releaseSha);
}
fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
EOF

git add "${policy_path}"
git commit -m "chore: authorize v${RELEASE_VERSION} adoption"
git push --force origin "${branch}"

body_file="$(mktemp)"
trap 'rm -f "${body_file}"' EXIT
cat > "${body_file}" <<EOF
Authorize release v${RELEASE_VERSION} at ${release_sha} for consumer pins.

## Review before merge (merge = the authorization decision)

- Diff to review: https://github.com/${GITHUB_REPOSITORY}/compare/${previous_sha}...${release_sha}
- Public action and runtime files changed:
\`\`\`
${changed_files}
\`\`\`
- If the diff touches \`return-unity-license\` or its runtime, review the credential-bearing return path first.

Merging adds ${release_sha} to \`approvedLockShas\` and \`approvedReturnShas\` in \`${policy_path}\`.
EOF

# The repository may block the workflow identity from opening pull requests.
# Open the pull request with the reviewed writer App identity instead, and
# leave no unreviewed branch behind when creation fails.
if ! GH_TOKEN="${RELEASE_AUTHORIZATION:?RELEASE_AUTHORIZATION is required}" gh pr create \
  --head "${branch}" \
  --title "Authorize v${RELEASE_VERSION} release adoption" \
  --body-file "${body_file}"; then
  # Creation can also fail after the pull request was created server-side.
  # Only delete the branch when no pull request uses it, and say so when the
  # deletion itself fails.
  open_prs="$(gh pr list --head "${branch}" --state open --json number --jq length)"
  if [[ "${open_prs}" == "0" ]]; then
    if ! git push origin --delete "${branch}" >/dev/null 2>&1; then
      echo "::warning::Could not delete the unreviewed branch ${branch}." >&2
    fi
  else
    echo "::warning::An authorization pull request for ${branch} appeared during creation; keeping the branch." >&2
  fi
  echo "::error::Could not open the authorization pull request." >&2
  exit 1
fi

# Bot-created pull requests do not start hosted checks on their own. Dispatch
# the required workflow on the branch so the pull request shows real results.
gh workflow run "Build lock CI" --ref "${branch}" \
  || echo "::warning::Build lock CI dispatch failed; run it on ${branch} before merge."
