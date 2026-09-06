const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflowPath = path.join(__dirname, "..", ".github", "workflows", "auto-release.yml");
const releaseScriptPath = path.join(__dirname, "..", "tools", "workflows", "auto-release.sh");
const authorizationScriptPath = path.join(
  __dirname,
  "..",
  "tools",
  "workflows",
  "open-release-authorization-pr.sh"
);
const releaseConfigPath = path.join(__dirname, "..", ".releaserc.json");
const credentialedGitHubTokenUser = new RegExp("x-access-" + "token", "i");

test("auto release workflow is scheduled and uses semantic-release", () => {
  const text = fs.readFileSync(workflowPath, "utf8");
  const script = fs.readFileSync(releaseScriptPath, "utf8");

  assert.match(text, /^\s*name:\s*Auto release\s*$/m);
  assert.match(text, /^\s*-\s*cron:\s*"0 9 \* \* 1"\s*$/m);
  assert.match(text, /^\s*workflow_dispatch:\s*$/m);
  assert.match(text, /^\s*concurrency:\s*$/m);
  assert.match(text, /^\s*group:\s*auto-release\s*$/m);
  assert.match(text, /^\s*cancel-in-progress:\s*false\s*$/m);
  assert.match(text, /^\s*uses:\s*cycjimmy\/semantic-release-action@[a-f0-9]{40}\s+#\s+v[0-9.]+\s*$/m);
  assert.match(text, /^\s*contents:\s*write\s*$/m);
  assert.match(text, /^\s*issues:\s*write\s*$/m);
  assert.match(text, /^\s*pull-requests:\s*write\s*$/m);
  assert.match(text, /^\s*actions:\s*write\s*$/m);
  assert.match(text, /new_release_published\s*==\s*'true'/);
  assert.match(text, /new_release_major_version\s*==\s*'1'/);
  assert.match(text, /run: bash tools\/workflows\/auto-release\.sh/);
  assert.match(text, /run: bash tools\/workflows\/open-release-authorization-pr\.sh/);
  assert.match(text, /RELEASE_VERSION: \$\{\{ steps\.semantic\.outputs\.new_release_version \}\}/);
  assert.match(text, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(script, /git config user\.name "github-actions\[bot\]"/);
  assert.match(script, /git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"/);
  assert.match(script, /git tag -fa v1/m);
  assert.match(script, /git push --force origin refs\/tags\/v1:refs\/tags\/v1/);
  assert.doesNotMatch(text + script, credentialedGitHubTokenUser);
  assert.doesNotMatch(text + script, /https:\/\/[^\n]*\$\{\{\s*secrets\./);
});

test("release authorization stays a reviewed human merge decision", () => {
  const workflowText = fs.readFileSync(workflowPath, "utf8");
  const script = fs.readFileSync(authorizationScriptPath, "utf8");

  assert.match(script, /^set -euo pipefail$/m);
  assert.match(script, /RELEASE_VERSION="\$\{RELEASE_VERSION:-\}"/);
  assert.match(script, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/releases\?per_page=30"/);
  assert.match(script, /draft == false and \.prerelease == false/);
  assert.match(script, /split\("\."\) \| map\(tonumber\)/);
  assert.match(script, /Could not list published releases for authorization discovery\./);
  assert.match(script, /refusing to claim all releases are authorized/);
  assert.match(script, /Every published release is already authorized\./);
  assert.match(script, /git fetch --force origin "refs\/tags\/v\$\{RELEASE_VERSION\}:/);
  assert.match(script, /git rev-parse "v\$\{RELEASE_VERSION\}\^\{commit\}"/);
  assert.match(script, /\^\[a-f0-9\]\{40\}\$/m);
  assert.match(script, /approvedLockShas/);
  assert.match(script, /approvedReturnShas/);
  assert.match(script, /is already authorized/);
  assert.match(script, /git checkout -B "\$\{branch\}" origin\/main/);
  assert.match(script, /before any file mutation/);
  assert.match(script, /git commit -m "chore: authorize v\$\{RELEASE_VERSION\} adoption"/);
  assert.match(script, /gh pr create/);
  assert.match(script, /gh workflow run "Build lock CI" --ref "\$\{branch\}"/);
  assert.match(script, /merge = the authorization decision/);
  assert.match(script, /credential-bearing return path/);
  assert.match(workflowText, /Open release authorization pull request/);
  assert.doesNotMatch(script, /gh pr merge/);
  assert.doesNotMatch(script, credentialedGitHubTokenUser);
  assert.doesNotMatch(script, /https:\/\/[^\n]*\$\{\{\s*secrets\./);
  const rawTokenUse = script.match(/^\s*(?:(?!GH_TOKEN).)*token/gim) || [];
  assert.deepEqual(rawTokenUse, []);
  const checkoutLine = script.match(/git checkout -B "\$\{branch\}".*/)[0];
  const mutationLine = script.indexOf("Release SHA is not a full lowercase commit SHA.");
  assert.notEqual(mutationLine, -1);
  assert.ok(script.indexOf(checkoutLine) < mutationLine, "branch checkout must precede policy mutation");
});

test("authorization opens on every run so a failed attempt is retried", () => {
  const workflowText = fs.readFileSync(workflowPath, "utf8");
  const stepStart = workflowText.indexOf("Open release authorization pull request");
  const stepEnd = workflowText.indexOf("run: bash tools/workflows/open-release-authorization-pr.sh");
  assert.notEqual(stepStart, -1);
  assert.notEqual(stepEnd, -1);
  const stepHeader = workflowText.slice(stepStart, stepEnd);
  assert.doesNotMatch(stepHeader, /^\s*if:/m);
  assert.doesNotMatch(stepHeader, /new_release_published/);
});

test("semantic-release publishes without claiming referenced issues are resolved", () => {
  const config = JSON.parse(fs.readFileSync(releaseConfigPath, "utf8"));

  assert.deepEqual(config.plugins, [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/github",
      {
        successComment:
          "This <%= issue.pull_request ? 'pull request' : 'issue' %> is associated with a pull request or commit included in version <%= nextRelease.version %>.\n\n" +
          "This automated notice records release linkage only; it does not establish that the <%= issue.pull_request ? 'pull request' : 'issue' %> is resolved. Use its current state and acceptance evidence as the authority.",
        releasedLabels: false
      }
    ]
  ]);
});
