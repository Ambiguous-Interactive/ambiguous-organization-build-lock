"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");

const {
  DARWIN_CODESIGN_PATH,
  darwinDesignatedRequirement,
  editorEnvironment,
  editorPath,
  executeReturn,
  MAX_EVIDENCE_BYTES,
  redactedEvidence,
  requiredInputs,
  run,
  systemPowerShell,
  terminateProcess,
  UNITY_DARWIN_TEAM_IDS,
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
  const verification = verifyUnityEditor("E:\\tool cache\\Unity.exe", {
    environment: {},
    platform: "win32",
    spawnImpl: () => verifier,
    timeoutMs: 1
  });
  let outcome = null;
  verification.then(
    () => {
      outcome = "resolved";
    },
    (error) => {
      outcome = error;
    }
  );
  // The verification timeout timer does not keep the loop alive. This ref'd delay does.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(String(outcome), /timed out/);
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

/*
  Darwin trusted return (#153). Every case below is the Windows control's
  counterpart, so a reviewer can read the two halves side by side, and each one
  is red against a specific way the Darwin path could be wrong rather than
  against "it does not work".
*/

const REVIEWED_TEAM = new Set(["ABCDE12345"]);

test("darwin editor path resolves the Mach-O inside the reviewed bundle", () => {
  assert.equal(
    editorPath("/opt/tool-cache", "6000.5.2f1", "canonical", "darwin"),
    "/opt/tool-cache/u6-v3/6000.5.2f1/Editor/Unity.app/Contents/MacOS/Unity"
  );
  assert.equal(
    editorPath("/opt/tool-cache", "6000.5.2f1", "ci-managed-alternate", "darwin"),
    "/opt/tool-cache/u6-v3/_ci-managed-editors/6000.5.2f1/Editor/Unity.app/Contents/MacOS/Unity"
  );
});

test("the darwin requirement pins the anchor, the Developer ID chain and the team", () => {
  const requirement = darwinDesignatedRequirement(REVIEWED_TEAM);
  assert.match(requirement, /^anchor apple generic and /);
  assert.match(requirement, /certificate 1\[field\.1\.2\.840\.113635\.100\.6\.2\.6\] exists/);
  assert.match(requirement, /certificate leaf\[field\.1\.2\.840\.113635\.100\.6\.1\.13\] exists/);
  assert.match(requirement, /certificate leaf\[subject\.OU\] = "ABCDE12345"/);
});

test("an unpinned or malformed darwin identity fails closed rather than verifying", () => {
  assert.throws(
    () => darwinDesignatedRequirement(new Set()),
    /No reviewed Unity Developer ID team is configured/
  );
  for (const malformed of ["abcde12345", "ABCDE1234", "ABCDE123456", "ABCDE-1234", ""]) {
    assert.throws(
      () => darwinDesignatedRequirement(new Set([malformed])),
      /malformed/,
      `expected ${JSON.stringify(malformed)} to be refused`
    );
  }
});

test("the shipped darwin team is the one measured off Unity's signed editor package", () => {
  /*
    Read from the signing chain in the xar table of contents of
    MacEditorInstaller/Unity.pkg at revision eb73d3b415a1: OU, UID and the common
    name all carry 9QW8UQUTAA for Unity Technologies SF, issued under Apple's
    Developer ID Certification Authority. Pinned as one value, so a second team
    appearing here is a review decision rather than a drift.
  */
  assert.deepEqual([...UNITY_DARWIN_TEAM_IDS], ["9QW8UQUTAA"]);
  assert.match(
    darwinDesignatedRequirement(UNITY_DARWIN_TEAM_IDS),
    /certificate leaf\[subject\.OU\] = "9QW8UQUTAA"/
  );
});

test("darwin verification runs absolute codesign against the designated requirement", async () => {
  const calls = [];
  const spawnImpl = (command, argumentsList, options) => {
    calls.push({ command, argumentsList, options });
    const child = new EventEmitter();
    process.nextTick(() => child.emit("close", 0));
    return child;
  };
  await verifyUnityEditor("/opt/tool-cache/Unity.app/Contents/MacOS/Unity", {
    allowedTeamIDs: REVIEWED_TEAM,
    environment: { PATH: "/usr/bin:/bin", TMPDIR: "/runner/temp" },
    platform: "darwin",
    spawnImpl
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/codesign");
  assert.equal(calls[0].command, DARWIN_CODESIGN_PATH);
  assert.ok(path.isAbsolute(calls[0].command));
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.env, { PATH: "/usr/bin:/bin", TMPDIR: "/runner/temp" });
  assert.ok(calls[0].argumentsList.includes("--verify"));
  assert.ok(calls[0].argumentsList.includes("--strict"));
  // `--` before the path, so an executable whose name begins with a dash is an
  // operand rather than a flag.
  const separator = calls[0].argumentsList.indexOf("--");
  assert.ok(separator >= 0);
  assert.equal(
    calls[0].argumentsList[separator + 1],
    "/opt/tool-cache/Unity.app/Contents/MacOS/Unity"
  );
  assert.match(calls[0].argumentsList.join(" "), /=anchor apple generic and /);
  assert.match(calls[0].argumentsList.join(" "), /subject\.OU\] = "ABCDE12345"/);
});

test("a codesign identity mismatch fails the darwin return", async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    // codesign exits nonzero when the signature does not satisfy -R, which is
    // the image-substitution case: correctly signed, wrong team.
    process.nextTick(() => child.emit("close", 3));
    return child;
  };
  await assert.rejects(
    verifyUnityEditor("/opt/tool-cache/Unity.app/Contents/MacOS/Unity", {
      allowedTeamIDs: REVIEWED_TEAM,
      platform: "darwin",
      spawnImpl
    }),
    /signature verification failed/
  );
});

test("darwin verification is bounded and terminates a hung codesign", async () => {
  const terminated = [];
  const verifier = new EventEmitter();
  verifier.pid = 4321;
  verifier.exitCode = null;
  verifier.kill = () => {
    terminated.push("direct");
    return true;
  };
  /*
    The action's bound is unref'd on purpose -- a verification timer must never
    be the reason a runner stays alive -- so it only fires while something else
    holds the loop open. `delay` is that something, and awaiting it before the
    assertion makes the outcome settled rather than raced: at 50 ms the 5 ms
    bound has fired, so the check below reads a decided verdict.
  */
  const verification = verifyUnityEditor("/opt/tool-cache/Unity.app/Contents/MacOS/Unity", {
    allowedTeamIDs: REVIEWED_TEAM,
    killImpl: (pid, signal) => {
      terminated.push(`${pid}:${signal}`);
    },
    platform: "darwin",
    spawnImpl: () => verifier,
    timeoutMs: 5
  });
  const outcome = verification.then(
    () => new Error("a hung codesign must not verify the editor."),
    (error) => error
  );
  await delay(50);
  assert.match((await outcome).message, /signature verification timed out/);
  // The group, so a codesign that forked is not left behind on the runner.
  assert.deepEqual(terminated, ["-4321:SIGTERM"]);
});

test("a codesign that cannot start fails the darwin return closed", async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    process.nextTick(() => child.emit("error", new Error("ENOENT")));
    return child;
  };
  await assert.rejects(
    verifyUnityEditor("/opt/tool-cache/Unity.app/Contents/MacOS/Unity", {
      allowedTeamIDs: REVIEWED_TEAM,
      platform: "darwin",
      spawnImpl
    }),
    /could not start/
  );
});

test("darwin termination signals the whole process group, not the editor alone", () => {
  const signals = [];
  const child = new EventEmitter();
  child.pid = 5150;
  child.exitCode = null;
  child.kill = () => {
    signals.push("direct");
    return true;
  };
  terminateProcess(child, "darwin", () => {
    throw new Error("darwin termination must not spawn a helper.");
  }, {}, (pid, signal) => {
    signals.push(`${pid}:${signal}`);
  });
  // A negative pid is the process group, which is what reaches descendants the
  // editor left behind after its parent exited.
  assert.deepEqual(signals, ["-5150:SIGTERM"]);
});

test("a darwin group signal that fails falls back to the direct child kill", () => {
  const signals = [];
  const child = new EventEmitter();
  child.pid = 5150;
  child.exitCode = null;
  child.kill = () => {
    signals.push("direct");
    return true;
  };
  terminateProcess(child, "darwin", () => {
    throw new Error("darwin termination must not spawn a helper.");
  }, {}, () => {
    throw new Error("ESRCH");
  });
  assert.deepEqual(signals, ["direct"]);
});

test("the darwin child environment is an allowlist that drops workflow control", () => {
  const environment = editorEnvironment(
    {
      DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      GITHUB_TOKEN: "secret",
      HOME: "/Users/runner",
      "INPUT_UNITY-PASSWORD": "private-password",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/attacker/temp",
      USER: "runner"
    },
    "/runner/temp",
    "darwin"
  );
  assert.deepEqual(environment, {
    HOME: "/Users/runner",
    PATH: "/usr/bin:/bin",
    TMPDIR: "/runner/temp",
    USER: "runner"
  });
  // The loader-injection variable is the macOS counterpart of a hijacked
  // SystemRoot, and neither reaches the editor.
  assert.equal(environment.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(environment["INPUT_UNITY-PASSWORD"], undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
});

test("an unsupported platform is refused rather than verified by another platform's rule", async () => {
  for (const platform of ["linux", "aix", "freebsd"]) {
    await assert.rejects(
      verifyUnityEditor("/opt/tool-cache/Unity", {
        allowedTeamIDs: REVIEWED_TEAM,
        platform,
        spawnImpl: () => {
          throw new Error("no verifier may run on an unsupported platform.");
        }
      }),
      /supports Windows and Darwin only/
    );
  }
});

/*
  The three cases below run the real macOS requirement compiler, so they are the
  only ones here whose verdict is not computed from an injected spawn.

  They exist because `verifyDarwinUnityEditor` maps every non-zero `codesign`
  exit to one message: "signature verification failed". A syntax error in the
  requirement text therefore reads exactly like a signature that did not match,
  and the gate would refuse every Darwin return forever while looking like it
  was doing its job. Nothing above can catch that -- each of those cases asserts
  the argv the action builds, and an argv is not a proof that the string inside
  it means anything to `csreq(5)`.

  #229's canary is the thing that settles whether `9QW8UQUTAA` is the identity on
  the Developer ID *Application* certificate. These do not settle that and do not
  try to. What they settle is the half of that answer a hosted runner can reach
  with no seat, no credential and no Unity install: that the requirement compiles,
  that it is not vacuous, and that a refusal by it is a refusal by the identity
  clause rather than by a typo.
*/

const { execFileSync } = require("node:child_process");

function darwinOnly(t) {
  if (process.platform !== "darwin") {
    t.skip("the macOS requirement compiler is only present on Darwin");
    return false;
  }
  return true;
}

test("the shipped darwin requirement compiles as a code signing requirement", (t) => {
  if (!darwinOnly(t)) {
    return;
  }
  const requirement = darwinDesignatedRequirement(UNITY_DARWIN_TEAM_IDS);
  const compiled = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "unity-return-csreq-")),
    "requirement.bin"
  );
  execFileSync("/usr/bin/csreq", ["-r", `=${requirement}`, "-b", compiled], {
    stdio: "ignore"
  });
  assert.ok(fs.statSync(compiled).size > 0, "csreq wrote no compiled requirement");

  // The red half: without it, a csreq that accepted anything would pass above.
  assert.throws(
    () => execFileSync(
      "/usr/bin/csreq",
      ["-r", "=anchor apple generic and certificate leaf[subject.OU] ==== \"X\"", "-b", `${compiled}.bad`],
      { stdio: "ignore" }
    )
  );
});

test("an apple-signed binary that is not Unity is refused by the requirement", (t) => {
  if (!darwinOnly(t)) {
    return;
  }
  const requirement = darwinDesignatedRequirement(UNITY_DARWIN_TEAM_IDS);

  // /bin/ls is Apple-signed, so `--verify --strict` alone passes. That is what
  // makes the refusal below attributable to the identity clause: the same binary,
  // the same flags, one added `-R`.
  execFileSync(DARWIN_CODESIGN_PATH, ["--verify", "--strict", "--", "/bin/ls"], {
    stdio: "ignore"
  });
  assert.throws(
    () => execFileSync(
      DARWIN_CODESIGN_PATH,
      ["--verify", "--strict", "-R", `=${requirement}`, "--", "/bin/ls"],
      { stdio: "ignore" }
    ),
    "an Apple-anchored binary carrying no Developer ID team satisfied the Unity requirement"
  );
});

test("the compiler keeps the reviewed team rather than dropping the clause", (t) => {
  if (!darwinOnly(t)) {
    return;
  }
  /*
    The risk this case is red against is a clause `csreq` accepts and discards.
    `/bin/ls` cannot expose it: it is a platform binary with no Developer ID
    chain, so `certificate 1[...6.2.6] exists` refuses it before the identity is
    ever consulted, and the case above would read the same whether the team
    survived compilation or not.

    So ask the compiler instead. Compile the requirement, decompile it, and read
    back what it holds -- `csreq -r <file> -t` prints the canonical text of what
    was actually stored.
  */
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "unity-return-csreq-team-"));
  const compile = (requirement, name) => {
    const target = path.join(directory, name);
    execFileSync("/usr/bin/csreq", ["-r", `=${requirement}`, "-b", target], { stdio: "ignore" });
    return target;
  };

  const [reviewedTeam] = [...UNITY_DARWIN_TEAM_IDS];
  const shipped = compile(darwinDesignatedRequirement(UNITY_DARWIN_TEAM_IDS), "shipped.bin");
  const decompiled = execFileSync("/usr/bin/csreq", ["-r", shipped, "-t"], { encoding: "utf8" });
  assert.match(
    decompiled,
    new RegExp(reviewedTeam),
    `the compiled requirement does not hold ${reviewedTeam}, so the identity clause was dropped`
  );

  // And a different team compiles to different bytes, which is what makes the
  // match above a reading of this team rather than of any team.
  const other = compile(darwinDesignatedRequirement(new Set(["AAAAAAAAAA"])), "other.bin");
  assert.notEqual(
    fs.readFileSync(shipped).toString("hex"),
    fs.readFileSync(other).toString("hex"),
    "two different reviewed teams compiled to the same requirement"
  );
});
