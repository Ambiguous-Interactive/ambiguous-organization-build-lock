const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflowsRoot = path.join(__dirname, "..", ".github", "workflows");

function readWorkflow(name) {
  return fs.readFileSync(path.join(workflowsRoot, name), "utf8");
}

function listWorkflows() {
  return fs
    .readdirSync(workflowsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.name);
}

function actionsPermissionFromBlock(text, indent) {
  const pattern = new RegExp(`^ {${indent}}permissions:\\s*\\n((?: {${indent + 2},}[^\\n]*\\n?)*)`, "m");
  const match = pattern.exec(text);
  if (!match) {
    return null;
  }
  const permission = /^\s*actions:\s*(read|write)\s*$/m.exec(match[1]);
  return permission ? permission[1] : "";
}

function jobSections(text) {
  const jobsStart = /^jobs:\s*$/m.exec(text);
  if (!jobsStart) {
    return [];
  }

  const jobsText = text.slice(jobsStart.index + jobsStart[0].length);
  const starts = [...jobsText.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)].map((match) => ({
    name: match[1],
    index: match.index
  }));

  return starts.map((start, index) => {
    const next = starts[index + 1];
    return {
      name: start.name,
      text: jobsText.slice(start.index, next ? next.index : undefined)
    };
  });
}

test("workflows that query Actions REST APIs declare actions read permission", () => {
  for (const workflow of listWorkflows()) {
    const text = readWorkflow(workflow);
    const topLevelActions = actionsPermissionFromBlock(text, 0);

    for (const job of jobSections(text)) {
      if (!/gh api[\s\S]*\/actions\/(?:runs|workflows)\b/.test(job.text)) {
        continue;
      }

      const jobActions = actionsPermissionFromBlock(job.text, 4);
      assert.ok(
        jobActions || (jobActions === null && topLevelActions),
        `${workflow} job ${job.name} must grant actions: read/write in its effective permissions`
      );
    }
  }
});

test("Dependabot auto-merge handles successful CI reruns", () => {
  const text = readWorkflow("dependabot-auto-merge.yml");

  assert.match(text, /^\s*workflow_run:\s*$/m);
  assert.match(text, /^\s*workflows:\s*\[Build lock CI\]\s*$/m);
  assert.match(text, /^\s*types:\s*\[completed\]\s*$/m);
  assert.match(text, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(text, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
});

test("Dependabot auto-merge CI gate is exact-head and workflow-filtered", () => {
  const text = readWorkflow("dependabot-auto-merge.yml");

  assert.match(text, /gh api -X GET "repos\/\$\{REPOSITORY\}\/actions\/runs"/);
  assert.match(text, /-f head_sha="\$\{PR_HEAD_SHA\}"/);
  assert.match(text, /map\(select\(\.workflow_id == \$\{ci_workflow_id\} and \.event == \\"pull_request\\"\)\)/);
  assert.match(text, /run_conclusion="\$\(jq -r '\.conclusion'/);
  assert.doesNotMatch(text, /actions\/workflows\/\$\{CI_WORKFLOW_FILE\}\/runs/);
  assert.doesNotMatch(text, /gh api[^\n]*\|\|\s*true/);
  assert.doesNotMatch(text, /@\s*tsv/);
});

test("Dependabot auto-merge revalidates PR identity before merging", () => {
  const text = readWorkflow("dependabot-auto-merge.yml");

  assert.match(text, /pr_author="\$\(jq -r '\.user\.login'/);
  assert.match(text, /\$\{pr_author\}" != "dependabot\[bot\]"/);
  assert.match(text, /pr_draft="\$\(jq -r '\.draft'/);
  assert.match(text, /current_head_sha="\$\(jq -r '\.head\.sha'/);
  assert.match(text, /\$\{current_head_sha\}" != "\$\{PR_HEAD_SHA\}"/);
  assert.match(text, /auto_merge_enabled="\$\(jq -r '\.auto_merge != null'/);
});

test("privileged Dependabot auto-merge workflow does not check out PR code", () => {
  const text = readWorkflow("dependabot-auto-merge.yml");

  assert.match(text, /^\s*pull_request_target:\s*$/m);
  assert.doesNotMatch(text, /uses:\s*actions\/checkout@/);
});
