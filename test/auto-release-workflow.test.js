const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflowPath = path.join(__dirname, "..", ".github", "workflows", "auto-release.yml");
const releaseConfigPath = path.join(__dirname, "..", ".releaserc.json");
const credentialedGitHubTokenUser = new RegExp("x-access-" + "token", "i");

test("auto release workflow is scheduled and uses semantic-release", () => {
  const text = fs.readFileSync(workflowPath, "utf8");

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
  assert.match(text, /new_release_published\s*==\s*'true'/);
  assert.match(text, /new_release_major_version\s*==\s*'1'/);
  assert.match(text, /git config user\.name "github-actions\[bot\]"/);
  assert.match(text, /git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"/);
  assert.match(text, /git tag -fa v1/m);
  assert.match(text, /git push --force origin refs\/tags\/v1:refs\/tags\/v1/);
  assert.doesNotMatch(text, credentialedGitHubTokenUser);
  assert.doesNotMatch(text, /https:\/\/[^\n]*\$\{\{\s*secrets\./);
});

test("semantic-release is configured without npm publishing", () => {
  const config = JSON.parse(fs.readFileSync(releaseConfigPath, "utf8"));

  assert.deepEqual(config.plugins, [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/github"
  ]);
});
