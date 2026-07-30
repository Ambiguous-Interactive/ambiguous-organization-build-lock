"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  editorEnvironment,
  editorPath,
  executeReturn,
  requiredInputs,
  run,
  workflowCommandData
} = require("../.github/dist/return-unity-license.js");

function fixture(t, script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-return-action-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const toolCache = path.join(root, "tool-cache");
  const runnerTemp = path.join(root, "runner-temp");
  const output = path.join(root, "outputs.txt");
  const executable = editorPath(toolCache, "6000.5.2f1");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(runnerTemp);
  fs.writeFileSync(executable, script, { mode: 0o700 });
  return {
    env: {
      GITHUB_OUTPUT: output,
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "12345",
      "INPUT_EVIDENCE-SUFFIX": "qora",
      "INPUT_TOOL-CACHE": toolCache,
      "INPUT_UNITY-EMAIL": "account@example.invalid",
      "INPUT_UNITY-PASSWORD": "private-password",
      "INPUT_UNITY-VERSION": "6000.5.2f1",
      RUNNER_TEMP: runnerTemp
    },
    output,
    runnerTemp
  };
}

test("central return invokes only the CI-managed editor and emits bounded evidence", async (t) => {
  const item = fixture(t, "#!/bin/sh\nprintf 'returned:%s:%s\\n' \"$7\" \"$9\"\nexit 0\n");
  const result = await run({
    env: item.env,
    platform: "linux",
    verifyEditor: async () => {}
  });

  assert.equal(result.commandCompleted, true);
  assert.equal(result.captureComplete, true);
  assert.equal(result.exitCode, 0);
  assert.equal(
    result.returnLogPath,
    path.join(item.runnerTemp, "unity-return-12345-2-qora", "return-license.log")
  );
  assert.equal(
    fs.readFileSync(result.returnLogPath, "utf8"),
    "returned:[REDACTED]:[REDACTED]\n"
  );
  const digest = crypto
    .createHash("sha256")
    .update("returned:[REDACTED]:[REDACTED]\n")
    .digest("hex");
  assert.equal(result.returnLogDigest, digest);
  assert.equal(
    fs.readFileSync(item.output, "utf8"),
    [
      `return-log-path=${result.returnLogPath}`,
      "return-command-completed=false",
      "evidence-capture-complete=false",
      "return-command-completed=true",
      "return-exit-code=0",
      "evidence-capture-complete=true",
      `return-log-digest=${digest}`,
      ""
    ].join("\n")
  );
});

test("nonzero Unity exit preserves typed evidence and fails the action", async (t) => {
  const item = fixture(t, "#!/bin/sh\nprintf 'return failed\\n'\nexit 7\n");
  const result = await executeReturn({
    env: item.env,
    platform: "linux",
    verifyEditor: async () => {}
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.commandCompleted, true);
  assert.equal(result.captureComplete, true);
  await assert.rejects(run({
    env: item.env,
    platform: "linux",
    verifyEditor: async () => {}
  }), /did not complete/);
});

test("invalid caller-controlled resolution inputs fail closed", () => {
  const base = {
    "INPUT_EVIDENCE-SUFFIX": "default",
    "INPUT_TOOL-CACHE": path.resolve("cache"),
    "INPUT_UNITY-EMAIL": "account@example.invalid",
    "INPUT_UNITY-PASSWORD": "private",
    "INPUT_UNITY-VERSION": "6000.5.2f1"
  };
  for (const mutation of [
    { "INPUT_TOOL-CACHE": "relative" },
    { "INPUT_UNITY-VERSION": "../Unity.exe" },
    { "INPUT_EVIDENCE-SUFFIX": "../escape" },
    { "INPUT_UNITY-EMAIL": "" },
    { "INPUT_UNITY-PASSWORD": "" }
  ]) {
    assert.throws(() => requiredInputs({ ...base, ...mutation }));
  }
});

test("Unity child environment excludes action inputs and workflow execution controls", () => {
  const result = editorEnvironment({
    APPDATA: "appdata",
    GITHUB_TOKEN: "github-token",
    "INPUT_UNITY-PASSWORD": "private",
    NODE_OPTIONS: "--require=./consumer.js",
    SystemRoot: "C:\\Windows"
  }, "C:\\runner-temp");
  assert.deepEqual(result, {
    APPDATA: "appdata",
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\runner-temp",
    TMP: "C:\\runner-temp"
  });
});

test("top-level action diagnostics escape workflow commands", () => {
  assert.equal(workflowCommandData("bad%\r\n::warning::value"), "bad%25%0D%0A::warning::value");
});

test("symlinked editor is rejected without exposing credentials", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink setup requires elevated Windows privileges");
    return;
  }
  const item = fixture(t, "#!/bin/sh\nexit 0\n");
  const executable = editorPath(item.env["INPUT_TOOL-CACHE"], item.env["INPUT_UNITY-VERSION"]);
  const target = `${executable}.target`;
  fs.renameSync(executable, target);
  fs.symlinkSync(target, executable);
  await assert.rejects(executeReturn({ env: item.env }), /not a regular file/);
  const outputs = fs.readFileSync(item.output, "utf8");
  assert.match(outputs, /return-command-completed=false/);
  assert.ok(!outputs.includes(item.env["INPUT_UNITY-EMAIL"]));
  assert.ok(!outputs.includes(item.env["INPUT_UNITY-PASSWORD"]));
});

test("a reparse point in the editor ancestry is rejected", async (t) => {
  if (process.platform === "win32") {
    t.skip("junction setup requires a Windows-specific fixture");
    return;
  }
  const item = fixture(t, "#!/bin/sh\nexit 0\n");
  const executable = editorPath(item.env["INPUT_TOOL-CACHE"], item.env["INPUT_UNITY-VERSION"]);
  const editorDirectory = path.dirname(executable);
  const targetDirectory = `${editorDirectory}.target`;
  fs.renameSync(editorDirectory, targetDirectory);
  fs.symlinkSync(targetDirectory, editorDirectory, "dir");
  await assert.rejects(executeReturn({
    env: item.env,
    platform: "linux",
    verifyEditor: async () => {}
  }), /reparse point/);
});
