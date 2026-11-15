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
  parseDeclaredIndependentPaths,
  run
} = require("../.github/dist/classify-unity-changes.js");

test("central classifier skips only audited independent paths", () => {
  for (const changedPath of [
    "README.md",
    "CONTRIBUTING.md",
    ".cursorrules",
    ".github/copilot-instructions.md",
    ".github/dependency-ownership.md",
    ".github/merge-policy-attestation.json",
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
    ".github/merge-policy-attestation.copy.json",
    ".github/merge-policy-attestation.json.bak",
    "Assets/Game.cs",
    "Packages/manifest.json",
    "progressive/code.cs"
  ]) {
    assert.equal(isUnityIndependent(changedPath), false, changedPath);
  }
  assert.equal(classifyUnityChanges([]), true);
  assert.equal(classifyUnityChanges([".github/merge-policy-attestation.json"]), false);
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

/*
 * The enrollment policy allows the classifier checkout to run a blobless
 * clone (`filter: blob:none`) with `persist-credentials: false`. That shape is
 * only safe because the runtime never reads file contents: `--name-only` skips
 * patch bodies, and `--no-ext-diff` plus `--no-textconv` skip the external
 * filters that would read blobs. Pin the runtime against the committed source
 * so a future edit that adds any second git call or a blob-reading flag fails
 * here instead of failing closed in a consumer's uncredentialed clone. Both
 * the quoted and the absolute spelling of the binary resolve to the same tool
 * under the sanitized PATH, so the count covers both.
 */
test("committed classifier runtime makes exactly one tree-only git call", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", ".github", "dist", "classify-unity-changes.js"),
    "utf8"
  );
  assert.equal(
    (source.match(/\/usr\/bin\/git/g) || []).length +
      (source.match(/"git"/g) || []).length,
    1,
    "the classifier must make exactly one git call"
  );
  assert.match(
    source,
    /"diff",\s*"--name-only",\s*"--no-renames",\s*"--no-ext-diff",\s*"--no-textconv"/
  );
});

test("classifier defaults output true before any fallible pull request work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-change-classifier-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputPath = path.join(root, "output.txt");
  await assert.rejects(run({
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
  // Unreadable revisions prove the event gate runs before any diff: a push never reports on
  // a revision pair, so the runtime must not try to read one.
  const result = classifierRuntime({
    GITHUB_OUTPUT: outputPath,
    "INPUT_EVENT-NAME": "push",
    "INPUT_BASE-SHA": "main",
    "INPUT_HEAD-SHA": "main"
  });
  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(outputPath, "utf8").trim(), "unity-required=true");
});

/*
 * Actions expose `event-name` as INPUT_EVENT-NAME: the runner uppercases the input name and
 * replaces spaces, never hyphens. Reading INPUT_EVENT_NAME instead is indistinguishable from an
 * absent input, so the runtime answered "not a pull request" for every pull request this action
 * has ever classified while every unit test of run() -- which is handed its arguments -- passed.
 *
 * A merge group has no pull request payload. GitHub reports the queue branch's base and head
 * revisions, and the same base-to-head diff answers the same question. The cases run through the
 * runner input names on both events: an independent diff skips Unity and one Unity path requires
 * it.
 */
test("committed classifier runtime reads the diff for a pull request and a merge group", () => {
  for (const eventName of ["pull_request", "merge_group"]) {
    for (const { changedPaths, expected } of [
      { changedPaths: [".llm/context.md", "progress/session.md"], expected: "unity-required=false" },
      { changedPaths: [".llm/context.md", "Assets/Game.cs"], expected: "unity-required=true" }
    ]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-change-classifier-diff-"));
      try {
        const workspace = fixtureRepository(root, changedPaths);
        const outputPath = path.join(root, "output.txt");
        const result = classifierRuntime({
          GITHUB_OUTPUT: outputPath,
          "INPUT_EVENT-NAME": eventName,
          "INPUT_BASE-SHA": workspace.baseSHA,
          "INPUT_HEAD-SHA": workspace.headSHA
        }, workspace.directory);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
          fs.readFileSync(outputPath, "utf8").trim().split("\n").pop(),
          expected,
          `${eventName}: ${changedPaths.join(", ")}`
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test("committed classifier runtime fails closed on an incomplete merge group revision", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-change-classifier-merge-group-sha-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputPath = path.join(root, "output.txt");
  const result = classifierRuntime({
    GITHUB_OUTPUT: outputPath,
    "INPUT_EVENT-NAME": "merge_group",
    "INPUT-BASE-SHA": "main",
    "INPUT-HEAD-SHA": "main"
  });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(outputPath, "utf8"), "unity-required=true\n");
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

/*
 * CALLER-DECLARED INDEPENDENT PATHS. Inertness beyond documentation is caller-relative and cannot
 * live in one shared list: `Benchmarks/**` is inert to DoxReloaded's Unity build and would not be
 * for another repository. The built-in allowlist stays exactly as it is and the declaration is
 * UNIONED with it, so a declaration can only widen what a caller skips on and never narrows the
 * central floor.
 */
test("declared independent prefixes widen the allowlist without touching the central floor", () => {
  const declared = parseDeclaredIndependentPaths("Benchmarks/**\nscripts/**");
  assert.deepEqual(declared, ["Benchmarks/", "scripts/"]);

  assert.equal(isUnityIndependent("Benchmarks/Baselines/x.json", declared), true);
  assert.equal(isUnityIndependent("scripts/lint.py", declared), true);
  assert.equal(isUnityIndependent("Assets/Game.cs", declared), true === false);
  assert.equal(isUnityIndependent("Packages/manifest.json", declared), false);
  assert.equal(isUnityIndependent(".github/workflows/build-deploy.yml", declared), false);

  // The central floor is unchanged with or without a declaration.
  assert.equal(isUnityIndependent(".llm/context.md", declared), true);
  assert.equal(isUnityIndependent(".llm/context.md", []), true);
  assert.equal(isUnityIndependent("Benchmarks/Baselines/x.json", []), false);

  assert.equal(classifyUnityChanges(["Benchmarks/a.json", ".llm/b.md"], declared), false);
  assert.equal(classifyUnityChanges(["Benchmarks/a.json", "Assets/Game.cs"], declared), true);
});

/*
 * ONLY `<prefix>/**` IS ACCEPTED, AND ANYTHING ELSE FAILS CLOSED. This input is a security gate's
 * trusted input and it is editable by whoever can edit the calling workflow, so the grammar is the
 * smallest one that expresses the need and can be audited by reading it. A general glob would need
 * a matcher a reviewer has to reason about; a prefix does not.
 */
test("a declaration that is not an auditable directory prefix is refused rather than guessed", () => {
  for (const bad of [
    "Benchmarks",            // no /** suffix -- a bare name could be a file
    "Benchmarks/*",          // one level, and the matcher does not implement it
    "**",                    // would make everything independent
    "/**",                   // absolute
    "**/x/**",               // leading wildcard
    "../outside/**",         // escapes the repository
    "Assets/**",             // Unity compiles it: refused by name, not by review
    "Packages/**",
    "ProjectSettings/**",
    "Assets/Scripts/**",     // under a reserved prefix
    ".github/**",            // would cover the workflow that gates Unity
    ".github/workflows/**",
    "Bench marks/**"         // whitespace inside a segment
  ]) {
    assert.throws(() => parseDeclaredIndependentPaths(bad), /declared independent path/, bad);
  }

  assert.deepEqual(parseDeclaredIndependentPaths(""), []);
  assert.deepEqual(parseDeclaredIndependentPaths("  \n\n  "), []);
  assert.deepEqual(parseDeclaredIndependentPaths("a/b/**\n\n a/b/** \n"), ["a/b/"]);
  // A sibling of a reserved prefix is fine; only overlap is refused.
  assert.deepEqual(parseDeclaredIndependentPaths(".github/scripts/**"), [".github/scripts/"]);
});

/*
 * BOTH HALVES OF THE DECLARATION CONTRACT ARE PINNED END TO END: a diff of only declared or
 * centrally independent paths skips Unity, and ONE undeclared path flips the decision back to
 * required. The flip is exercised through the runner input name on purpose: the unit test of
 * classifyUnityChanges above already pins it in isolation, but a runtime that dropped the
 * declaration input entirely would still pass that unit test.
 */
test("committed classifier runtime honours a declaration through the runner input name", () => {
  for (const { changedPaths, expected } of [
    { changedPaths: ["Benchmarks/Baselines/x.json", "progress/s.md"], expected: "unity-required=false" },
    { changedPaths: ["Benchmarks/Baselines/x.json", "scripts/build.ps1"], expected: "unity-required=true" }
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-change-classifier-declared-"));
    test.after(() => fs.rmSync(root, { recursive: true, force: true }));
    try {
      const workspace = fixtureRepository(root, changedPaths);
      const outputPath = path.join(root, "output.txt");
      const result = classifierRuntime({
        GITHUB_OUTPUT: outputPath,
        "INPUT_EVENT-NAME": "pull_request",
        "INPUT_BASE-SHA": workspace.baseSHA,
        "INPUT_HEAD-SHA": workspace.headSHA,
        "INPUT_INDEPENDENT-PATHS": "Benchmarks/**"
      }, workspace.directory);
      const output = fs.readFileSync(outputPath, "utf8").trim().split("\n").pop();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(output, expected, changedPaths.join(", "));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("committed classifier runtime fails CLOSED on an unparseable declaration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-change-classifier-bad-decl-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = fixtureRepository(root, ["progress/s.md"]);
  const outputPath = path.join(root, "output.txt");
  const result = classifierRuntime({
    GITHUB_OUTPUT: outputPath,
    "INPUT_EVENT-NAME": "pull_request",
    "INPUT_BASE-SHA": workspace.baseSHA,
    "INPUT_HEAD-SHA": workspace.headSHA,
    "INPUT_INDEPENDENT-PATHS": "Assets/**"
  }, workspace.directory);
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(outputPath, "utf8").trim(), "unity-required=true");
});

/*
 * INCREMENTAL VALIDATION. A follow-up pull request push that changes no Unity path still runs the
 * licensed job today, because the classifier diffs the whole pull request. The record of the last
 * validated tree is the repository's run history: the newest successful run of this workflow on
 * this branch. The comparison is the API's own file list between that run's head and the current
 * head. Every uncertain answer keeps Unity required, and the recorded run must belong to this
 * workflow, this branch, and a finished successful run that is not the current one.
 */
const VALIDATED_SHA = "1".repeat(40);

async function classifyIncrementally(overrides = {}) {
  const requests = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-change-classifier-incremental-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputPath = path.join(root, "output.txt");
  const request = async (requestPath) => {
    requests.push(requestPath);
    if (overrides.requestError) {
      throw overrides.requestError;
    }
    if (requestPath.includes("/actions/workflows/")) {
      return overrides.history ?? {
        workflow_runs: [{
          id: 1,
          head_branch: "feature",
          head_sha: VALIDATED_SHA,
          conclusion: "success"
        }]
      };
    }
    if (requestPath.includes(`${VALIDATED_SHA}?per_page=1`)) {
      return overrides.baseRelation ?? { status: "ahead", files: [] };
    }
    return overrides.comparison ?? {
      status: "ahead",
      files: [{ filename: "progress/session-1.md" }]
    };
  };
  const unityRequired = await run({
    eventName: overrides.eventName ?? "pull_request",
    baseSHA: "a".repeat(40),
    headSHA: "b".repeat(40),
    outputPath,
    incrementalValidation: overrides.incrementalValidation ?? "true",
    githubToken: "token",
    repository: "Ambiguous-Interactive/consumer",
    workflowRef: overrides.workflowRef ?? "Ambiguous-Interactive/consumer/.github/workflows/build-deploy.yml@refs/heads/main",
    headBranch: "feature",
    runID: "2",
    execute: () => (overrides.changedPaths ?? ["Assets/Game.cs"]).map((changedPath) => `${changedPath}\0`).join(""),
    request,
    log: () => {}
  });
  return {
    unityRequired,
    requests,
    written: fs.readFileSync(outputPath, "utf8").trim().split("\n").pop()
  };
}

test("incremental validation skips only a delta the validated run already covers", async () => {
  for (const { name, overrides, expected } of [
    {
      name: "a document-only delta",
      overrides: { comparison: { status: "ahead", files: [{ filename: "progress/session-1.md" }] } },
      expected: false
    },
    {
      name: "a Unity path in the delta",
      overrides: { comparison: { status: "ahead", files: [{ filename: "Assets/Game.cs" }] } },
      expected: true
    },
    {
      name: "a rename out of a Unity path",
      overrides: {
        comparison: {
          status: "ahead",
          files: [{ filename: "README.md", previous_filename: "Assets/Game.cs" }]
        }
      },
      expected: true
    },
    {
      name: "an unchanged tree",
      overrides: { comparison: { status: "identical", files: [] } },
      expected: false
    },
    {
      name: "a rewritten history",
      overrides: { comparison: { status: "diverged", files: [] } },
      expected: true
    },
    {
      name: "a base that moved past the validated run",
      overrides: { baseRelation: { status: "diverged", files: [] } },
      expected: true
    },
    {
      name: "a base that equals the validated run",
      overrides: { baseRelation: { status: "identical", files: [] } },
      expected: false
    },
    {
      name: "a truncated file list",
      overrides: {
        comparison: {
          status: "ahead",
          files: Array.from({ length: 300 }, (unused, index) => ({ filename: `docs/${index}.md` }))
        }
      },
      expected: true
    },
    {
      name: "a comparison without files",
      overrides: { comparison: { status: "ahead" } },
      expected: true
    },
    {
      name: "no successful run of this workflow",
      overrides: { history: { workflow_runs: [] } },
      expected: true
    },
    {
      name: "a successful run of another branch",
      overrides: {
        history: {
          workflow_runs: [{ id: 1, head_branch: "other", head_sha: VALIDATED_SHA }]
        }
      },
      expected: true
    },
    {
      name: "the current run",
      overrides: {
        history: {
          workflow_runs: [{ id: 2, head_branch: "feature", head_sha: VALIDATED_SHA }]
        }
      },
      expected: true
    },
    {
      name: "a run record with no commit",
      overrides: {
        history: {
          workflow_runs: [{ id: 1, head_branch: "feature", head_sha: "main" }]
        }
      },
      expected: true
    },
    {
      name: "an unreadable history",
      overrides: { history: {} },
      expected: true
    },
    {
      name: "a failed lookup",
      overrides: { requestError: new Error("GitHub API responded 503") },
      expected: true
    }
  ]) {
    const { unityRequired, written } = await classifyIncrementally(overrides);
    assert.equal(unityRequired, expected, name);
    assert.equal(written, `unity-required=${expected}`, name);
  }
});

test("incremental validation reads this workflow and only under the pull request trigger", async () => {
  const pullRequest = await classifyIncrementally();
  assert.equal(pullRequest.requests.length, 3, "one run-history read, one base check, one comparison");
  assert.match(pullRequest.requests[0], /\/actions\/workflows\/build-deploy\.yml\/runs\?/);
  assert.match(pullRequest.requests[0], /branch=feature/);
  assert.match(pullRequest.requests[0], /event=pull_request/);
  assert.match(pullRequest.requests[0], /status=success/);
  assert.equal(pullRequest.requests[1], `/repos/Ambiguous-Interactive/consumer/compare/${"a".repeat(40)}...${VALIDATED_SHA}?per_page=1`);
  assert.equal(pullRequest.requests[2], `/repos/Ambiguous-Interactive/consumer/compare/${VALIDATED_SHA}...${"b".repeat(40)}?per_page=300`);

  // A merge group names no pull request branch, and the whole-diff answer stands.
  const mergeGroup = await classifyIncrementally({ eventName: "merge_group" });
  assert.equal(mergeGroup.unityRequired, true);
  assert.deepEqual(mergeGroup.requests, []);

  // The mode is opt-in: an absent flag keeps the whole-diff answer and reads nothing.
  const off = await classifyIncrementally({ incrementalValidation: "" });
  assert.equal(off.unityRequired, true);
  assert.deepEqual(off.requests, []);

  // A whole-diff skip needs no record at all.
  const independent = await classifyIncrementally({ changedPaths: ["progress/session.md"] });
  assert.equal(independent.unityRequired, false);
  assert.deepEqual(independent.requests, []);
});

test("incremental validation refuses a workflow reference that names another repository", async () => {
  for (const workflowRef of [
    "other/repository/.github/workflows/build-deploy.yml@refs/heads/main",
    "Ambiguous-Interactive/consumer/.github/workflows/../workflow.yml@refs/heads/main",
    "Ambiguous-Interactive/consumer/.github/actions/classify/action.yml@refs/heads/main",
    "",
    "build-deploy.yml"
  ]) {
    const { unityRequired } = await classifyIncrementally({ workflowRef });
    assert.equal(unityRequired, true, workflowRef);
  }
});

/*
 * The mode is read through the runner input name, like every other input. This runs the committed
 * runtime with an unparseable workflow reference, so no request leaves the runner: the case proves
 * the flag reached the action and that its first failure keeps Unity required.
 */
test("committed classifier runtime keeps Unity required when the record lookup cannot start", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-change-classifier-record-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = fixtureRepository(root, ["Assets/Game.cs"]);
  const outputPath = path.join(root, "output.txt");
  const result = classifierRuntime({
    GITHUB_OUTPUT: outputPath,
    GITHUB_REPOSITORY: "Ambiguous-Interactive/consumer",
    GITHUB_WORKFLOW_REF: "not-a-workflow-reference",
    GITHUB_HEAD_REF: "feature",
    GITHUB_RUN_ID: "2",
    "INPUT_EVENT-NAME": "pull_request",
    "INPUT_BASE-SHA": workspace.baseSHA,
    "INPUT_HEAD-SHA": workspace.headSHA,
    "INPUT_INCREMENTAL-VALIDATION": "true",
    "INPUT_GITHUB-TOKEN": "token"
  }, workspace.directory);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(outputPath, "utf8").trim(), "unity-required=true");
  assert.match(result.stdout, /incremental validation unavailable/);
});
