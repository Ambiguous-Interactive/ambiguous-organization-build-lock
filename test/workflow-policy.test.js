const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");
const workflowsRoot = path.join(repoRoot, ".github", "workflows");
const policyTextExtensions = new Set([".js", ".json", ".md", ".yml", ".yaml"]);

function readWorkflow(name) {
  return fs.readFileSync(path.join(workflowsRoot, name), "utf8");
}

function listWorkflows() {
  return fs
    .readdirSync(workflowsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.name);
}

function listPolicyTextFiles(root = repoRoot) {
  return childProcess
    .execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((file) => policyTextExtensions.has(path.extname(file).toLowerCase()))
    .map((file) => path.join(root, file));
}

function stripYamlComment(value) {
  return value.replace(/(?:^|[ \t]+)#.*$/, "").trim();
}

function permissionsFromFlowMap(value) {
  if (!/^\{.*\}$/.test(value)) {
    return null;
  }

  const permissions = new Map();
  const entries = value.slice(1, -1).trim();
  if (!entries) {
    return permissions;
  }

  for (const part of entries.split(",")) {
    const entry = /^\s*([A-Za-z-]+):\s*(read|write|none)\s*$/.exec(part);
    if (!entry) {
      return new Map();
    }
    permissions.set(entry[1], entry[2]);
  }
  return permissions;
}

function permissionsFromBlock(text, indent) {
  const declarationPattern = new RegExp(`^ {${indent}}permissions:[ \\t]*([^\\n]*)$`, "m");
  const declaration = declarationPattern.exec(text);
  if (!declaration) {
    return null;
  }

  const value = stripYamlComment(declaration[1]);
  if (value) {
    if (value === "write-all") {
      return new Map([["*", "write"]]);
    }
    if (value === "read-all") {
      return new Map([["*", "read"]]);
    }

    const flowMap = permissionsFromFlowMap(value);
    return flowMap || new Map();
  }

  const blockPattern = new RegExp(`^ {${indent}}permissions:[ \\t]*(?:#.*)?\\r?\\n((?: {${indent + 2},}[^\\n]*\\n?)*)`, "m");
  const block = blockPattern.exec(text);
  if (!block) {
    return new Map();
  }

  const permissions = new Map();
  for (const line of block[1].split(/\r?\n/)) {
    const entry = new RegExp(`^ {${indent + 2}}([A-Za-z-]+):[ \\t]*(read|write|none)[ \\t]*(?:#.*)?$`).exec(line);
    if (entry) {
      permissions.set(entry[1], entry[2]);
    }
  }
  return permissions;
}

function hasPermission(permissions, name, required) {
  if (!permissions) {
    return false;
  }
  const level = permissions.get(name) || permissions.get("*") || "none";
  return level === required || (required === "read" && level === "write");
}

function hasEffectivePermission(workflowText, jobText, name, required) {
  const jobPermissions = permissionsFromBlock(jobText, 4);
  if (jobPermissions) {
    return hasPermission(jobPermissions, name, required);
  }
  return hasPermission(permissionsFromBlock(workflowText, 0), name, required);
}

function jobSections(text) {
  const jobsStart = /^jobs:[ \t]*(?:#.*)?$/m.exec(text);
  if (!jobsStart) {
    return [];
  }

  const jobsText = text.slice(jobsStart.index + jobsStart[0].length);
  const starts = [...jobsText.matchAll(/^  (?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z0-9_-]+)):[ \t]*(?:#.*)?$/gm)].map((match) => ({
    name: match[1] || match[2] || match[3],
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

function runScriptSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];

  for (let index = 0; index < lines.length; index += 1) {
    const run = /^(\s*)(-\s*)?run:\s*(.*)$/.exec(lines[index]);
    if (!run) {
      continue;
    }

    const indent = run[1].length + (run[2] ? run[2].length : 0);
    const value = run[3].trim();
    if (!/^[|>](?:(?:[+-]?[1-9])|(?:[1-9][+-]?)|[+-])?\s*(?:#.*)?$/.test(value)) {
      sections.push({ line: index + 1, text: value });
      continue;
    }

    const script = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const lineIndent = /^ */.exec(lines[next])[0].length;
      if (lines[next] && lineIndent <= indent) {
        break;
      }
      script.push(lines[next]);
    }
    sections.push({ line: index + 1, text: script.join("\n") });
  }

  return sections;
}

function isGithubReleasePlugin(plugin) {
  return plugin === "@semantic-release/github" || (Array.isArray(plugin) && plugin[0] === "@semantic-release/github");
}

test("workflows that query Actions REST APIs declare actions read permission", () => {
  for (const workflow of listWorkflows()) {
    const text = readWorkflow(workflow);

    for (const job of jobSections(text)) {
      if (!/gh api[\s\S]*\/actions\/(?:runs|workflows)\b/.test(job.text)) {
        continue;
      }

      assert.ok(
        hasEffectivePermission(text, job.text, "actions", "read"),
        `${workflow} job ${job.name} must grant actions: read/write in its effective permissions`
      );
    }
  }
});

test("permission parser handles flow maps and fails closed on narrowed job overrides", () => {
  const workflow = `
permissions:
  contents: write
  issues: write
  pull-requests: write
jobs: # workflow jobs
  "release": # publish
    permissions: { contents: write }
    steps:
      - uses: cycjimmy/semantic-release-action@v5
  complete:
    permissions: { contents: write, issues: write, pull-requests: write }
    steps:
      - uses: cycjimmy/semantic-release-action@v5
  unparsed:
    permissions: maybe
    steps:
      - uses: cycjimmy/semantic-release-action@v5
  commented:
    permissions: # valid block map with a trailing declaration comment
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: cycjimmy/semantic-release-action@v5
`;
  const jobs = Object.fromEntries(jobSections(workflow).map((job) => [job.name, job]));

  assert.equal(hasEffectivePermission(workflow, jobs.release.text, "contents", "write"), true);
  assert.equal(hasEffectivePermission(workflow, jobs.release.text, "issues", "write"), false);
  assert.equal(hasEffectivePermission(workflow, jobs.release.text, "pull-requests", "write"), false);
  assert.equal(hasEffectivePermission(workflow, jobs.complete.text, "contents", "write"), true);
  assert.equal(hasEffectivePermission(workflow, jobs.complete.text, "issues", "write"), true);
  assert.equal(hasEffectivePermission(workflow, jobs.complete.text, "pull-requests", "write"), true);
  assert.equal(hasEffectivePermission(workflow, jobs.unparsed.text, "contents", "write"), false);
  assert.equal(hasEffectivePermission(workflow, jobs.commented.text, "contents", "write"), true);
  assert.equal(hasEffectivePermission(workflow, jobs.commented.text, "issues", "write"), true);
  assert.equal(hasEffectivePermission(workflow, jobs.commented.text, "pull-requests", "write"), true);
});

test("workflow run scripts pass secrets through env instead of expression interpolation", () => {
  const tokenExpression = /\$\{\{\s*(?:secrets\.[A-Za-z0-9_]+|github\.token)\s*\}\}/i;

  for (const workflow of listWorkflows()) {
    const text = readWorkflow(workflow);
    for (const section of runScriptSections(text)) {
      assert.doesNotMatch(
        section.text,
        tokenExpression,
        `${workflow}:${section.line} must not interpolate GitHub token contexts directly into a run script; pass them through env instead`
      );
    }
  }
});

test("workflow run script parser handles chomped block scalars", () => {
  const sections = runScriptSections(`
jobs:
  example:
    steps:
      - run: |- # keep policy coverage when YAML comments follow the block header
          echo one
      - run: >2+
          echo two
      - run: |2
          echo indented
      - run: echo three
`);

  assert.deepEqual(
    sections.map((section) => section.text.trim()),
    ["echo one", "echo two", "echo indented", "echo three"]
  );
});

test("repository text files do not contain token-bearing GitHub HTTPS URLs", () => {
  const tokenExpression = /\$\{\{\s*(?:secrets\.[A-Za-z0-9_]+|github\.token)\s*\}\}/i;
  const credentialedGitHubTokenUser = new RegExp("x-access-" + "token", "i");
  const credentialedGithubUrl = /\bhttps:\/\/[^/\s"'`]+@github\.com(?:\b|[/:])/i;

  for (const file of listPolicyTextFiles()) {
    const relativeFile = path.relative(repoRoot, file);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const location = `${relativeFile}:${index + 1}`;
      assert.doesNotMatch(
        line,
        credentialedGitHubTokenUser,
        `${location} must not use credentialed GitHub token usernames; use checkout's authenticated origin or env-based auth instead`
      );
      assert.ok(
        !(/\bhttps?:\/\//i.test(line) && tokenExpression.test(line)),
        `${location} must not interpolate GitHub token contexts into URLs`
      );
      assert.doesNotMatch(
        line,
        credentialedGithubUrl,
        `${location} must not embed credentials in GitHub HTTPS URLs`
      );
    }
  }
});

test("semantic-release GitHub workflows declare required token permissions", () => {
  const releaseConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".releaserc.json"), "utf8"));
  const plugins = Array.isArray(releaseConfig.plugins) ? releaseConfig.plugins : [];
  const usesGithubPlugin = plugins.some(isGithubReleasePlugin);

  if (!usesGithubPlugin) {
    return;
  }

  for (const workflow of listWorkflows()) {
    const text = readWorkflow(workflow);
    for (const job of jobSections(text)) {
      if (!/semantic-release/.test(job.text)) {
        continue;
      }

      assert.ok(
        hasEffectivePermission(text, job.text, "contents", "write"),
        `${workflow} job ${job.name} must grant contents: write so @semantic-release/github can publish releases and tags`
      );
      assert.ok(
        hasEffectivePermission(text, job.text, "issues", "write"),
        `${workflow} job ${job.name} must grant issues: write for @semantic-release/github issue updates`
      );
      assert.ok(
        hasEffectivePermission(text, job.text, "pull-requests", "write"),
        `${workflow} job ${job.name} must grant pull-requests: write for @semantic-release/github PR updates`
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
