"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  classifyUnityChanges,
  findChangedPaths,
  isUnityIndependent,
  run
} = require("../.github/dist/classify-unity-changes.js");

test("central classifier skips only audited independent paths", () => {
  for (const changedPath of [
    "README.md",
    "CONTRIBUTING.md",
    ".cursorrules",
    ".github/copilot-instructions.md",
    ".github/dependency-ownership.md",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".llm/context.md",
    "progress/session.md"
  ]) {
    assert.equal(isUnityIndependent(changedPath), true, changedPath);
  }
  for (const changedPath of [
    "",
    "docs/README.md",
    ".github/workflows/unity.yml",
    ".github/actions/example/action.yml",
    "Assets/Game.cs",
    "Packages/manifest.json",
    "progressive/code.cs"
  ]) {
    assert.equal(isUnityIndependent(changedPath), false, changedPath);
  }
  assert.equal(classifyUnityChanges([]), true);
  assert.equal(classifyUnityChanges(["README.md", ".llm/context.md"]), false);
  assert.equal(classifyUnityChanges(["README.md", "Assets/Game.cs"]), true);
  assert.throws(() => classifyUnityChanges([""]), /non-empty/);
});

test("changed path discovery uses bounded literal git diff arguments", () => {
  const baseSHA = "a".repeat(40);
  const headSHA = "b".repeat(40);
  let observed;
  const paths = findChangedPaths(baseSHA, headSHA, (command, args, options) => {
    observed = { command, args, options };
    return "README.md\0Assets/Game.cs\0";
  });
  assert.deepEqual(paths, ["README.md", "Assets/Game.cs"]);
  assert.deepEqual(observed, {
    command: "/usr/bin/git",
    args: [
      "--no-replace-objects",
      "diff",
      "--name-only",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "-z",
      baseSHA,
      headSHA,
      "--"
    ],
    options: {
      encoding: "utf8",
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        HOME: "/tmp",
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin"
      },
      maxBuffer: 16 * 1024 * 1024
    }
  });
  assert.throws(() => findChangedPaths("main", headSHA, () => ""), /full commit SHAs/);
});

test("classifier defaults output true before any fallible pull request work", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-change-classifier-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputPath = path.join(root, "output.txt");
  assert.throws(() => run({
    eventName: "pull_request",
    baseSHA: "a".repeat(40),
    headSHA: "b".repeat(40),
    outputPath,
    execute: () => {
      throw new Error("git unavailable");
    },
    log: () => {}
  }), /git unavailable/);
  assert.equal(fs.readFileSync(outputPath, "utf8"), "unity-required=true\n");
});

test("committed classifier runtime requires Unity on non-pull-request events", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-change-classifier-runtime-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputPath = path.join(root, "output.txt");
  const result = childProcess.spawnSync(
    process.execPath,
    [path.join(__dirname, "..", ".github", "dist", "classify-unity-changes.js")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        INPUT_EVENT_NAME: "push"
      }
    }
  );
  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(outputPath, "utf8").trim(), "unity-required=true");
});
