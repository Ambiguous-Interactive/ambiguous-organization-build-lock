#!/usr/bin/env bash
set -euo pipefail

# Open the reviewed pull request that authorizes a published release for
# consumer pins. Merging that pull request is the human authorization
# decision; this script never merges, edits the live policy on main, or
# approves anything by itself.

RELEASE_VERSION="${RELEASE_VERSION:?RELEASE_VERSION is required}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
policy_path="unity-enrollment-policy.json"

if [[ ! -f "${policy_path}" ]]; then
  echo "::error::Missing ${policy_path}." >&2
  exit 1
fi

git fetch --force origin "refs/tags/v${RELEASE_VERSION}:refs/tags/v${RELEASE_VERSION}"
release_sha="$(git rev-parse "v${RELEASE_VERSION}^{commit}")"

if [[ ! "${release_sha}" =~ ^[a-f0-9]{40}$ ]]; then
  echo "::error::Release commit is not a full SHA: ${release_sha}" >&2
  exit 1
fi

already_listed="$(node - "${release_sha}" "${policy_path}" <<'EOF'
const fs = require("node:fs");
const [releaseSha, policyPath] = process.argv.slice(2);
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
process.stdout.write(String(policy.approvedLockShas.includes(releaseSha)));
EOF
)"
if [[ "${already_listed}" == "true" ]]; then
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

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git checkout -B "${branch}" "${release_sha}"
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

gh pr create \
  --head "${branch}" \
  --title "Authorize v${RELEASE_VERSION} release adoption" \
  --body-file "${body_file}"

# Bot-created pull requests do not start hosted checks on their own. Dispatch
# the required workflow on the branch so the pull request shows real results.
gh workflow run "Build lock CI" --ref "${branch}" \
  || echo "::warning::Build lock CI dispatch failed; run it on ${branch} before merge."
