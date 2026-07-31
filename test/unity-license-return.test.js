"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const {
  editorEnvironment,
  editorPath,
  executeReturn,
  MAX_EVIDENCE_BYTES,
  redactedEvidence,
  requiredInputs,
  run,
  systemPowerShell,
  terminateProcess,
  verifyUnityEditor,
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

test("editor path matches the established CI-managed u6-v3 install root", () => {
  const toolCache = path.join(path.parse(process.cwd()).root, "actions-runner", "_tool");
  assert.equal(
    editorPath(toolCache, "6000.5.2f1"),
    path.join(toolCache, "u6-v3", "6000.5.2f1", "Editor", "Unity.exe")
  );
});

test("editor path selects only the reviewed CI-managed alternate layout", () => {
  const toolCache = path.join(path.parse(process.cwd()).root, "actions-runner", "_tool");
  assert.equal(
    editorPath(toolCache, "6000.5.2f1", "ci-managed-alternate"),
    path.join(
      toolCache,
      "u6-v3",
      "_ci-managed-editors",
      "6000.5.2f1",
      "Editor",
      "Unity.exe"
    )
  );
});

test("central return executes the selected CI-managed alternate editor", async (t) => {
  const item = fixture(t, "#!/bin/sh\nexit 0\n");
  const canonical = editorPath(
    item.env["INPUT_TOOL-CACHE"],
    item.env["INPUT_UNITY-VERSION"]
  );
  const alternate = editorPath(
    item.env["INPUT_TOOL-CACHE"],
    item.env["INPUT_UNITY-VERSION"],
    "ci-managed-alternate"
  );
  fs.mkdirSync(path.dirname(alternate), { recursive: true });
  fs.renameSync(canonical, alternate);
  item.env["INPUT_EDITOR-LAYOUT"] = "ci-managed-alternate";

  const result = await run({
    env: item.env,
    platform: "linux",
    verifyEditor: async (executable) => assert.equal(executable, alternate)
  });
  assert.equal(result.exitCode, 0);
});

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
      `return-log-digest=${digest}`,
      "evidence-capture-complete=true",
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

test("digest output is committed before capture completion", async (t) => {
  const item = fixture(t, "#!/bin/sh\nprintf 'return complete\\n'\nexit 0\n");
  const writes = [];
  await assert.rejects(executeReturn({
    appendFile(_file, value) {
      if (value.startsWith("return-log-digest=")) {
        throw new Error("injected output failure");
      }
      writes.push(value);
    },
    env: item.env,
    platform: "linux",
    verifyEditor: async () => {}
  }), /injected output failure/);
  assert.ok(writes.includes("evidence-capture-complete=false\n"));
  assert.ok(!writes.includes("evidence-capture-complete=true\n"));
});

for (const [name, email, password] of [
  ["email is a password prefix", "abc", "abcSECRET"],
  ["password is an email prefix", "abcSECRET", "abc"]
]) {
test(`credential redaction is complete when ${name}`, () => {
    const evidence = redactedEvidence(
      [Buffer.from(`${email}|${password}\n`)],
      [email, password]
    );
    assert.equal(evidence.toString("utf8"), "[REDACTED]|[REDACTED]\n");
  });
}

test("return evidence redacts Unity serials that were not action inputs", () => {
  const evidence = redactedEvidence(
    [Buffer.from("Returned serial SC-ABCD-EFGH-IJKL-MNOP-QRST\n")],
    ["account@example.invalid", "private-password"]
  );
  assert.equal(evidence.toString("utf8"), "Returned serial [REDACTED]\n");
  assert.ok(!evidence.includes(Buffer.from("SC-")));
});

test("invalid caller-controlled resolution inputs fail closed", () => {
  const base = {
    "INPUT_EVIDENCE-SUFFIX": "default",
    "INPUT_TOOL-CACHE": path.resolve("cache"),
    "INPUT_UNITY-EMAIL": "account@example.invalid",
    "INPUT_UNITY-PASSWORD": "private",
    "INPUT_UNITY-VERSION": "6000.5.2f1"
  };
  assert.equal(requiredInputs(base).editorLayout, "canonical");
  for (const mutation of [
    { "INPUT_TOOL-CACHE": "relative" },
    { "INPUT_UNITY-VERSION": "../Unity.exe" },
    { "INPUT_EDITOR-LAYOUT": "consumer/path" },
    { "INPUT_EDITOR-LAYOUT": "${{ env.EDITOR_LAYOUT }}" },
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
    SystemDrive: "C:",
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\runner-temp",
    TMP: "C:\\runner-temp",
    windir: "C:\\Windows"
  });
});

test("top-level action diagnostics escape workflow commands", () => {
  assert.equal(workflowCommandData("bad%\r\n::warning::value"), "bad%25%0D%0A::warning::value");
});

test("Authenticode verification uses absolute system PowerShell and the central signer allowlist", async () => {
  const calls = [];
  const spawnImpl = (command, argumentsList, options) => {
    calls.push({ command, argumentsList, options });
    const child = new EventEmitter();
    process.nextTick(() => child.emit("close", 0));
    return child;
  };
  await verifyUnityEditor("E:\\tool-cache\\Unity.exe", {
    environment: { SystemRoot: "attacker-controlled", TEMP: "E:\\temp" },
    platform: "win32",
    spawnImpl
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].command,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  );
  assert.deepEqual(calls[0].options.env, {
    CENTRAL_UNITY_EDITOR_PATH: "E:\\tool-cache\\Unity.exe",
    SystemDrive: "C:",
    SystemRoot: "C:\\Windows",
    TEMP: "E:\\temp",
    windir: "C:\\Windows"
  });
  assert.equal(calls[0].options.cwd, "C:\\Windows\\System32");
  assert.ok(!calls[0].argumentsList.includes("E:\\tool-cache\\Unity.exe"));
  assert.match(calls[0].argumentsList.join(" "), /CENTRAL_UNITY_EDITOR_PATH/);
  assert.match(calls[0].argumentsList.join(" "), /228FB6411B0A144478C86AAA3CD9473C43A8ABA7/);
  assert.match(calls[0].argumentsList.join(" "), /BFFD800651947878FCD0DC749C16D57B0D5E397D/);
  assert.match(calls[0].argumentsList.join(" "), /1\.3\.6\.1\.5\.5\.7\.3\.3/);
  assert.equal(systemPowerShell(), calls[0].command);
});

test("Authenticode verification is bounded and terminates a hung verifier", async () => {
  let killed = 0;
  const verifier = new EventEmitter();
  verifier.exitCode = null;
  verifier.kill = () => {
    killed++;
  };
  await assert.rejects(verifyUnityEditor("E:\\tool cache\\Unity.exe", {
    environment: {},
    platform: "win32",
    spawnImpl: () => verifier,
    timeoutMs: 1
  }), /timed out/);
  assert.equal(killed, 1);
});

test("nonzero Windows tree termination falls back to the direct child kill", async () => {
  let killed = 0;
  const child = {
    exitCode: null,
    pid: 42,
    kill() {
      killed++;
    }
  };
  const terminator = new EventEmitter();
  terminator.unref = () => {};
  const calls = [];
  terminateProcess(child, "win32", (command, argumentsList, options) => {
    calls.push({ command, argumentsList, options });
    return terminator;
  }, { TEMP: "E:\\temp" });
  terminator.emit("close", 1);
  assert.equal(killed, 1);
  assert.equal(calls[0].command, "C:\\Windows\\System32\\taskkill.exe");
  assert.deepEqual(calls[0].options.env, { TEMP: "E:\\temp" });
});

test("evidence overflow requests process termination only once", async (t) => {
  const item = fixture(t, "#!/bin/sh\nexit 0\n");
  let killed = 0;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      killed++;
    };
    process.nextTick(() => {
      const oversized = Buffer.alloc(MAX_EVIDENCE_BYTES + 1);
      child.stdout.emit("data", oversized);
      child.stderr.emit("data", oversized);
      child.exitCode = 1;
      child.emit("close", 1, null);
    });
    return child;
  };
  const result = await executeReturn({
    env: item.env,
    platform: "linux",
    spawnImpl,
    verifyEditor: async () => {}
  });
  assert.equal(result.captureComplete, false);
  assert.equal(result.evidenceOverflow, true);
  assert.equal(killed, 1);
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
