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
  const result = classifierRuntime({
    GITHUB_OUTPUT: outputPath,
    "INPUT_EVENT-NAME": "push"
  });
  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(outputPath, "utf8").trim(), "unity-required=true");
});

/*
 * Actions expose `event-name` as INPUT_EVENT-NAME: the runner uppercases the input name and
 * replaces spaces, never hyphens. Reading INPUT_EVENT_NAME instead is indistinguishable from an
 * absent input, so the runtime answered "not a pull request" for every pull request this action
 * has ever classified while every unit test of run() -- which is handed its arguments -- passed.
 * These two spawn the committed runtime through the env names the runner actually sets.
 */
test("committed classifier runtime classifies a pull request diff through runner input names", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-change-classifier-diff-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = fixtureRepository(root, [".llm/context.md", "progress/session.md"]);
  const outputPath = path.join(root, "output.txt");
  const result = classifierRuntime({
    GITHUB_OUTPUT: outputPath,
    "INPUT_EVENT-NAME": "pull_request",
    "INPUT_BASE-SHA": workspace.baseSHA,
    "INPUT_HEAD-SHA": workspace.headSHA
  }, workspace.directory);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(outputPath, "utf8").trim().split("\n").pop(), "unity-required=false");
});

test("committed classifier runtime requires Unity for a pull request touching Unity paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-change-classifier-unity-diff-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = fixtureRepository(root, [".llm/context.md", "Assets/Game.cs"]);
  const outputPath = path.join(root, "output.txt");
  const result = classifierRuntime({
    GITHUB_OUTPUT: outputPath,
    "INPUT_EVENT-NAME": "pull_request",
    "INPUT_BASE-SHA": workspace.baseSHA,
    "INPUT_HEAD-SHA": workspace.headSHA
  }, workspace.directory);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(outputPath, "utf8").trim().split("\n").pop(), "unity-required=true");
});

function classifierRuntime(env, cwd = undefined) {
  return childProcess.spawnSync(
    process.execPath,
    [path.join(__dirname, "..", ".github", "dist", "classify-unity-changes.js")],
    { cwd, encoding: "utf8", env: { ...process.env, ...env } }
  );
}

function fixtureRepository(root, changedPaths) {
  const directory = path.join(root, "workspace");
  const git = (...args) => childProcess.execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com"
    }
  });
  fs.mkdirSync(directory, { recursive: true });
  git("init", "--quiet", "--initial-branch", "main");
  fs.writeFileSync(path.join(directory, "README.md"), "base\n", "utf8");
  git("add", "--all");
  git("commit", "--quiet", "--message", "base");
  const baseSHA = git("rev-parse", "HEAD").trim();
  for (const changedPath of changedPaths) {
    const destination = path.join(directory, changedPath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, "head\n", "utf8");
  }
  git("add", "--all");
  git("commit", "--quiet", "--message", "head");
  return { baseSHA, directory, headSHA: git("rev-parse", "HEAD").trim() };
}
