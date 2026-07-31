"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const runtimePath = path.join(
  __dirname,
  "..",
  ".github",
  "dist",
  "classify-unity-cleanup-evidence.js"
);
const {
  MAX_EVIDENCE_FILES,
  MAX_EVIDENCE_TOTAL_BYTES,
  MAX_VISITED_ENTRIES,
  claimConsumedReturnEvidence,
  classifyEvidence,
  collectEvidence,
  deleteClaimedReturnEvidence,
  environmentInputs,
  identityBoundDeleteWindows,
  inspectReturnEvidenceTarget,
  parseInputs,
  resolveReturnEvidenceTarget,
  run
} = require(runtimePath);

const ENTITLEMENT = "[Licensing::Module] Successfully returned the entitlement license";
const ULF = "[Licensing::Client] Successfully returned ULF license with serial number : SC-REDACTED";
const PROOF = `${ENTITLEMENT}\n${ULF}\n`;
const SKIP = "[Licensing::Module] Error: Serial number unavailable for ULF return; skipping operation";

function centralEvidenceFixture(t, prefix = "unity-cleanup-action-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runnerTemp = path.join(root, "runner-temp");
  const evidenceDirectory = path.join(runnerTemp, "unity-return-12345-2-qora");
  const returnLog = path.join(evidenceDirectory, "return-license.log");
  const outputPath = path.join(root, "output.txt");
  const environment = {
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_RUN_ID: "12345",
    RUNNER_TEMP: runnerTemp
  };
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  fs.writeFileSync(returnLog, PROOF);
  return { environment, evidenceDirectory, outputPath, returnLog, root, runnerTemp };
}

function centralInputs(item) {
  return {
    "return-log-path": item.returnLog,
    "return-command-completed": "true",
    "return-exit-code": "0",
    "evidence-capture-complete": "true",
    "return-log-digest": crypto
      .createHash("sha256")
      .update(fs.readFileSync(item.returnLog))
      .digest("hex"),
    "supplemental-evidence-paths": ""
  };
}

function centralEvidenceRemains(item) {
  if (fs.existsSync(item.returnLog)) {
    return true;
  }
  return fs.readdirSync(item.runnerTemp).some((name) =>
    name.startsWith(`${path.basename(item.evidenceDirectory)}.consuming-`)
    && fs.existsSync(path.join(item.runnerTemp, name, "return-license.log"))
  );
}

function modelIdentityDelete(claimedTarget, claimedIdentity, io = fs, pathImpl = path) {
  const observed = inspectReturnEvidenceTarget(claimedTarget, io, pathImpl);
  for (const name of ["evidenceDirectoryStat", "returnLogStat"]) {
    assert.equal(observed[name].dev, claimedIdentity[name].dev);
    assert.equal(observed[name].ino, claimedIdentity[name].ino);
    assert.equal(observed[name].birthtimeNs, claimedIdentity[name].birthtimeNs);
  }
  io.unlinkSync(claimedTarget.returnLogPath);
  io.rmdirSync(claimedTarget.evidenceDirectory);
}

function runClassifier(options) {
  const io = options.io || fs;
  const pathImpl = options.pathImpl || path;
  return run({
    ...options,
    deleteByIdentity: options.deleteByIdentity || (
      (claimedTarget, claimedIdentity) =>
        modelIdentityDelete(claimedTarget, claimedIdentity, io, pathImpl)
    )
  });
}

function restoreWindowsFileTimes(filePath, stat) {
  const toFileTime = (nanoseconds) =>
    (nanoseconds / 100n + 116444736000000000n).toString();
  const source = [
    "using System;",
    "using System.ComponentModel;",
    "using System.Runtime.InteropServices;",
    "using Microsoft.Win32.SafeHandles;",
    "public static class RestoreBasicFileInformation {",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  private struct Basic {",
    "    public long CreationTime;",
    "    public long LastAccessTime;",
    "    public long LastWriteTime;",
    "    public long ChangeTime;",
    "    public uint Attributes;",
    "  }",
    "  [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)]",
    "  private static extern SafeFileHandle CreateFile(string p, uint a, uint s, IntPtr x, uint d, uint f, IntPtr t);",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)]",
    "  [return: MarshalAs(UnmanagedType.Bool)]",
    "  private static extern bool SetFileInformationByHandle(SafeFileHandle h, int c, ref Basic i, uint n);",
    "  public static void Restore(string path, long creation, long access, long write, long change) {",
    "    using (SafeFileHandle h = CreateFile(path, 0x100, 7, IntPtr.Zero, 3, 0x200000, IntPtr.Zero)) {",
    "      if (h.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());",
    "      Basic i = new Basic { CreationTime=creation, LastAccessTime=access, LastWriteTime=write, ChangeTime=change, Attributes=0 };",
    "      if (!SetFileInformationByHandle(h, 0, ref i, (uint)Marshal.SizeOf(typeof(Basic))))",
    "        throw new Win32Exception(Marshal.GetLastWin32Error());",
    "    }",
    "  }",
    "}"
  ].join("\n");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition $env:RESTORE_SOURCE -Language CSharp",
    "[RestoreBasicFileInformation]::Restore(",
    "  $env:TARGET_PATH,",
    "  [long]$env:TARGET_BIRTHTIME,",
    "  [long]$env:TARGET_ATIME,",
    "  [long]$env:TARGET_MTIME,",
    "  [long]$env:TARGET_CTIME",
    ")"
  ].join("\n");
  childProcess.execFileSync(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: {
        RESTORE_SOURCE: source,
        SystemRoot: "C:\\Windows",
        TARGET_ATIME: toFileTime(stat.atimeNs),
        TARGET_BIRTHTIME: toFileTime(stat.birthtimeNs),
        TARGET_CTIME: toFileTime(stat.ctimeNs),
        TARGET_MTIME: toFileTime(stat.mtimeNs),
        TARGET_PATH: filePath
      },
      stdio: "ignore",
      windowsHide: true
    }
  );
}

function expected(status, health, reason) {
  return {
    resourceSafe: status === "confirmed",
    cleanupStatus: status,
    health,
    reason
  };
}

test("classification precedence is fail-closed and proof is return-log scoped", async (t) => {
  const fixtures = [
    ["exact proof", 0, PROOF, [], true, true, expected("confirmed", "healthy", "cleanup-confirmed")],
    ["nonzero exact proof", 1, PROOF, [], true, true, expected("confirmed", "healthy", "cleanup-confirmed")],
    ["entitlement only", 0, `${ENTITLEMENT}\n`, [], true, true, expected("unknown", "healthy", "return-missing-positive-evidence")],
    ["ULF only", 0, `${ULF}\n`, [], true, true, expected("unknown", "healthy", "return-missing-positive-evidence")],
    ["exit zero alone", 0, "Exiting batchmode successfully now!\n", [], true, true, expected("unknown", "healthy", "return-missing-positive-evidence")],
    ["command incomplete", null, PROOF, [], false, true, expected("unknown", "healthy", "return-missing-positive-evidence")],
    ["supplemental proof", 0, "", [Buffer.from(PROOF)], true, true, expected("unknown", "healthy", "return-missing-positive-evidence")],
    ["module skip", 0, `${PROOF}${SKIP}\n`, [], true, true, expected("unknown", "healthy", "return-ulf-skipped")],
    ["module skip before proof", 0, `${SKIP}\n${PROOF}`, [], true, true, expected("unknown", "healthy", "return-ulf-skipped")],
    ["bare skip", 0, `${PROOF}Serial number unavailable for ULF return\n`, [], true, true, expected("unknown", "healthy", "return-ulf-skipped")],
    ["bare skip with suffix", 0, `${PROOF}Serial number unavailable for ULF return; skipping operation\n`, [], true, true, expected("unknown", "healthy", "return-ulf-skipped")],
    ["incidental skip phrase", 0, `${PROOF}checking for ${SKIP}\n`, [], true, true, expected("confirmed", "healthy", "cleanup-confirmed")],
    ["supplemental skip", 0, PROOF, [Buffer.from(`${SKIP}\n`)], true, true, expected("confirmed", "healthy", "cleanup-confirmed")],
    ["400006 vetoes proof", 0, `${PROOF}400006\n`, [], true, true, expected("unknown", "healthy", "unity-return-400006")],
    ["supplemental 400006", 0, PROOF, [Buffer.from("code 400006\n")], true, true, expected("unknown", "healthy", "unity-return-400006")],
    ["20113", 0, `${PROOF}20113\n`, [], true, true, expected("unknown", "healthy", "unity-20113-unclassified")],
    ["supplemental 20113", 0, PROOF, [Buffer.from("code 20113\n")], true, true, expected("unknown", "healthy", "unity-20113-unclassified")],
    ["20111 beats proof", 0, `${PROOF}20111\n`, [], true, true, expected("unknown", "blocked", "unity-account-limit-20111")],
    ["supplemental 20111", 0, PROOF, [Buffer.from("code 20111\n")], true, true, expected("unknown", "blocked", "unity-account-limit-20111")],
    ["20111 beats incomplete capture", 0, "20111\n", [], true, false, expected("unknown", "blocked", "unity-account-limit-20111")],
    ["capture incomplete", 0, PROOF, [], true, false, expected("unknown", "healthy", "return-log-truncated")],
    ["timeout", 124, PROOF, [], true, true, expected("unknown", "healthy", "return-timeout")],
    ["numeric substring is not a code", 0, `${PROOF}x201110\n`, [], true, true, expected("confirmed", "healthy", "cleanup-confirmed")]
  ];
  for (const exitCode of [137, 143, -1073741510, -1073740791]) {
    fixtures.push([
      `termination ${exitCode}`,
      exitCode,
      PROOF,
      [],
      true,
      true,
      expected("unknown", "healthy", "return-terminated")
    ]);
  }

  for (const [name, exitCode, returnText, supplemental, completed, captureComplete, want] of fixtures) {
    await t.test(name, () => {
      assert.deepEqual(
        classifyEvidence({
          exitCode,
          returnLog: Buffer.from(returnText),
          supplemental,
          commandCompleted: completed,
          captureComplete
        }),
        want
      );
    });
  }
});

test("bounded collection rejects unsafe evidence shapes and produces a stable digest", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-cleanup-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const returnLog = path.join(root, "return.log");
  const supplemental = path.join(root, "supplemental");
  fs.mkdirSync(supplemental);
  fs.writeFileSync(returnLog, `\uFEFF${ENTITLEMENT}\r\n${ULF}\r\n`);
  fs.writeFileSync(path.join(supplemental, "activation.log"), "activation complete\n");

  const first = collectEvidence({
    returnLogPath: returnLog,
    supplementalPaths: [supplemental],
    captureAttested: true
  });
  const second = collectEvidence({
    returnLogPath: returnLog,
    supplementalPaths: [supplemental],
    captureAttested: true
  });
  assert.equal(first.captureComplete, true);
  assert.equal(first.digest, second.digest);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    classifyEvidence({
      exitCode: 0,
      returnLog: first.returnLog,
      supplemental: first.supplemental,
      commandCompleted: true,
      captureComplete: first.captureComplete
    }),
    expected("confirmed", "healthy", "cleanup-confirmed")
  );

  await t.test("missing return log", () => {
    const result = collectEvidence({
      returnLogPath: path.join(root, "missing.log"),
      supplementalPaths: [],
      captureAttested: true
    });
    assert.equal(result.captureComplete, false);
  });

  await t.test("return directory", () => {
    const result = collectEvidence({
      returnLogPath: supplemental,
      supplementalPaths: [],
      captureAttested: true
    });
    assert.equal(result.captureComplete, false);
  });

  await t.test("symlink", { skip: process.platform === "win32" }, () => {
    const link = path.join(root, "linked.log");
    fs.symlinkSync(returnLog, link);
    const result = collectEvidence({
      returnLogPath: link,
      supplementalPaths: [],
      captureAttested: true
    });
    assert.equal(result.captureComplete, false);
  });

  await t.test("oversized return log", () => {
    const large = path.join(root, "large.log");
    fs.writeFileSync(large, Buffer.alloc(MAX_EVIDENCE_TOTAL_BYTES + 1, 65));
    const result = collectEvidence({
      returnLogPath: large,
      supplementalPaths: [],
      captureAttested: true
    });
    assert.equal(result.captureComplete, false);
    assert.equal(result.returnLog.length, 0);
  });

  await t.test("over-count supplemental files", () => {
    const many = path.join(root, "many");
    fs.mkdirSync(many);
    for (let index = 0; index < MAX_EVIDENCE_FILES; index += 1) {
      fs.writeFileSync(path.join(many, `${String(index).padStart(3, "0")}.log`), "x");
    }
    const result = collectEvidence({
      returnLogPath: returnLog,
      supplementalPaths: [many],
      captureAttested: true
    });
    assert.equal(result.captureComplete, false);
    assert.equal(result.supplemental.length, MAX_EVIDENCE_FILES - 1);
  });

  await t.test("invalid UTF-8", () => {
    const invalid = path.join(root, "invalid.log");
    fs.writeFileSync(invalid, Buffer.from([0xc3, 0x28]));
    const result = collectEvidence({
      returnLogPath: invalid,
      supplementalPaths: [],
      captureAttested: true
    });
    assert.equal(result.captureComplete, false);
  });

  await t.test("unreadable during read", () => {
    const io = {
      ...fs,
      openSync(candidate, flags) {
        if (candidate === returnLog) {
          throw new Error("simulated read failure");
        }
        return fs.openSync(candidate, flags);
      }
    };
    const result = collectEvidence({
      returnLogPath: returnLog,
      supplementalPaths: [],
      captureAttested: true,
      io
    });
    assert.equal(result.captureComplete, false);
    assert.equal(result.returnLog.length, 0);
  });

  await t.test("file identity changes during read", () => {
    let returnStats = 0;
    const io = {
      ...fs,
      lstatSync(candidate, options) {
        const stat = fs.lstatSync(candidate, options);
        if (candidate === returnLog && returnStats++ > 0) {
          return { ...stat, mtimeNs: stat.mtimeNs + 1n };
        }
        return stat;
      }
    };
    const result = collectEvidence({
      returnLogPath: returnLog,
      supplementalPaths: [],
      captureAttested: true,
      io
    });
    assert.equal(result.captureComplete, false);
    assert.equal(result.returnLog.length, 0);
  });

  await t.test("post-stat growth never expands the allocated read", () => {
    const tiny = path.join(root, "tiny.log");
    fs.writeFileSync(tiny, "x");
    let largestRequestedRead = 0;
    const io = {
      ...fs,
      readSync(descriptor, storage, offset, length) {
        largestRequestedRead = Math.max(largestRequestedRead, length);
        storage.fill(120, offset, offset + length);
        return length;
      },
      fstatSync(descriptor, options) {
        const stat = fs.fstatSync(descriptor, options);
        if (largestRequestedRead > 0) {
          return { ...stat, size: stat.size + 8_388_608n };
        }
        return stat;
      }
    };
    const result = collectEvidence({
      returnLogPath: tiny,
      supplementalPaths: [],
      captureAttested: true,
      maxFileBytes: 1,
      maxTotalBytes: 1,
      io
    });
    assert.equal(result.captureComplete, false);
    assert.ok(largestRequestedRead <= 1);
    assert.equal(result.returnLog.length, 0);
  });

  await t.test("nested directory enumeration shares one iterative global budget", () => {
    const source = path.join(root, "virtual-many");
    fs.mkdirSync(source);
    const directoryStat = fs.lstatSync(source, { bigint: true });
    const fileStat = {
      ...directoryStat,
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false
    };
    let directoryReads = 0;
    let inspectedEntries = 0;
    const io = {
      ...fs,
      lstatSync(candidate, options) {
        if (candidate === source || candidate === returnLog) {
          return fs.lstatSync(candidate, options);
        }
        inspectedEntries += 1;
        const depth = path.relative(source, candidate).split(path.sep).length;
        return depth === 1 ? directoryStat : fileStat;
      },
      opendirSync(candidate) {
        const entryLimit = 2_000;
        const rootDirectory = candidate === source;
        let localReads = 0;
        return {
          readSync() {
            directoryReads += 1;
            if (localReads >= entryLimit) {
              return null;
            }
            localReads += 1;
            return { name: rootDirectory ? `dir-${localReads}` : `${localReads}.bin` };
          },
          closeSync() {}
        };
      }
    };
    const result = collectEvidence({
      returnLogPath: returnLog,
      supplementalPaths: [source],
      captureAttested: true,
      io
    });
    assert.equal(result.captureComplete, false);
    assert.ok(directoryReads <= MAX_VISITED_ENTRIES);
    assert.ok(inspectedEntries <= MAX_VISITED_ENTRIES);
    assert.ok(result.discoveredEntries <= MAX_VISITED_ENTRIES);
    assert.ok(result.directoryReadOperations <= MAX_VISITED_ENTRIES);
    assert.ok(result.maximumBufferedEntries <= MAX_VISITED_ENTRIES);
    assert.ok(result.maximumTraversalDepth <= MAX_VISITED_ENTRIES);
    assert.equal(result.supplemental.length, 0);
  });

  await t.test("non-ASCII filenames use locale-independent digest ordering", () => {
    const orderedRoot = path.join(root, "ordered");
    const orderedReturn = path.join(root, "ordered-return.log");
    fs.mkdirSync(orderedRoot);
    fs.writeFileSync(orderedReturn, "return\n");
    fs.writeFileSync(path.join(orderedRoot, "z.log"), "ascii-z\n");
    fs.writeFileSync(path.join(orderedRoot, "ä.log"), "non-ascii\n");
    const result = collectEvidence({
      returnLogPath: orderedReturn,
      supplementalPaths: [orderedRoot],
      captureAttested: true
    });
    assert.equal(result.captureComplete, true);
    assert.deepEqual(
      result.supplemental.map((payload) => payload.toString("utf8")),
      ["ascii-z\n", "non-ascii\n"]
    );
    assert.equal(
      result.digest,
      "48f0d9dc5935053db94d4ec3f421ecc8fce510749ff70edbdfc79fe48a8f5625"
    );
  });
});

test("input parsing rejects contradictions and malformed typed values", () => {
  assert.deepEqual(parseInputs({
    "return-log-path": "/tmp/return.log",
    "return-command-completed": "false",
    "return-exit-code": "",
    "evidence-capture-complete": "true",
    "return-log-digest": "a".repeat(64),
    "supplemental-evidence-paths": " /tmp/a.log \n\n/tmp/b.log\n"
  }), {
    returnLogPath: "/tmp/return.log",
    commandCompleted: false,
    exitCode: null,
    captureAttested: true,
    supplementalPaths: ["/tmp/a.log", "/tmp/b.log"],
    returnLogDigest: "a".repeat(64)
  });
  assert.throws(() => parseInputs({
    "return-log-path": "/tmp/return.log",
    "return-command-completed": "true",
    "return-exit-code": "",
    "evidence-capture-complete": "true"
  }), /return-exit-code/);
  assert.throws(() => parseInputs({
    "return-log-path": "/tmp/return.log",
    "return-command-completed": "no",
    "return-exit-code": "0",
    "evidence-capture-complete": "true"
  }), /literal true or false/);
  assert.throws(() => parseInputs({
    "return-log-path": "/tmp/return.log",
    "return-command-completed": "false",
    "return-exit-code": "0",
    "evidence-capture-complete": "true"
  }), /must be absent/);
});

test("GitHub action input environment preserves hyphenated input names", () => {
  assert.deepEqual(environmentInputs({
    "INPUT_RETURN-LOG-PATH": "/tmp/return.log",
    "INPUT_RETURN-COMMAND-COMPLETED": "true",
    "INPUT_RETURN-EXIT-CODE": "0",
    "INPUT_EVIDENCE-CAPTURE-COMPLETE": "true",
    "INPUT_RETURN-LOG-DIGEST": "a".repeat(64),
    "INPUT_SUPPLEMENTAL-EVIDENCE-PATHS": "/tmp/evidence.log"
  }), {
    "return-log-path": "/tmp/return.log",
    "return-command-completed": "true",
    "return-exit-code": "0",
    "evidence-capture-complete": "true",
    "return-log-digest": "a".repeat(64),
    "supplemental-evidence-paths": "/tmp/evidence.log"
  });
});

test("run-scoped return path resolution is exact on POSIX and Windows models", () => {
  const posixEnvironment = {
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_RUN_ID: "12345",
    RUNNER_TEMP: "/runner/_temp"
  };
  assert.deepEqual(
    resolveReturnEvidenceTarget(
      posixEnvironment,
      "/runner/_temp/unity-return-12345-2-qora/return-license.log",
      path.posix
    ),
    {
      evidenceDirectory: "/runner/_temp/unity-return-12345-2-qora",
      returnLogPath: "/runner/_temp/unity-return-12345-2-qora/return-license.log",
      runAttempt: "2",
      runID: "12345",
      runnerTemp: "/runner/_temp"
    }
  );
  const windowsEnvironment = {
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_RUN_ID: "12345",
    RUNNER_TEMP: "D:\\actions\\_temp"
  };
  assert.equal(
    resolveReturnEvidenceTarget(
      windowsEnvironment,
      "D:\\actions\\_temp\\unity-return-12345-2-qora\\return-license.log",
      path.win32
    ).evidenceDirectory,
    "D:\\actions\\_temp\\unity-return-12345-2-qora"
  );

  for (const candidate of [
    "/runner/_temp/return-license.log",
    "/runner/_temp/unity-return-999-2-qora/return-license.log",
    "/runner/_temp/unity-return-12345-2-../return-license.log",
    "/runner/_temp/unity-return-12345-2-qora/other.log",
    "/runner/_temp/unity-return-12345-2-qora/nested/return-license.log",
    "/outside/unity-return-12345-2-qora/return-license.log"
  ]) {
    assert.throws(
      () => resolveReturnEvidenceTarget(posixEnvironment, candidate, path.posix),
      /exact run-scoped central return path/
    );
  }
});

test("Windows path model deletes only the exact owned return file and directory", () => {
  const environment = {
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_RUN_ID: "12345",
    RUNNER_TEMP: "D:\\actions\\_temp"
  };
  const returnLog = "D:\\actions\\_temp\\unity-return-12345-2-qora\\return-license.log";
  const target = resolveReturnEvidenceTarget(environment, returnLog, path.win32);
  const directories = new Set([
    "D:\\",
    "D:\\actions",
    "D:\\actions\\_temp",
    target.evidenceDirectory
  ]);
  const files = new Set([target.returnLogPath]);
  let nextInode = 1n;
  const identities = new Map(
    [...directories, ...files].map((candidate) => [candidate.toLowerCase(), nextInode++])
  );
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const io = {
    lstatSync(candidate) {
      const normalized = path.win32.resolve(candidate);
      const key = normalized.toLowerCase();
      if (!directories.has(normalized) && !files.has(normalized)) {
        throw missing();
      }
      const isDirectory = directories.has(normalized);
      return {
        birthtimeNs: 1n,
        ctimeNs: 1n,
        dev: 1n,
        ino: identities.get(key),
        mode: isDirectory ? 16877n : 33188n,
        mtimeNs: 1n,
        nlink: 1n,
        size: isDirectory ? 0n : BigInt(PROOF.length),
        isDirectory: () => isDirectory,
        isFile: () => !isDirectory,
        isSymbolicLink: () => false
      };
    },
    openSync(candidate) {
      const normalized = path.win32.resolve(candidate);
      if (!files.has(normalized)) {
        throw missing();
      }
      return { candidate: normalized };
    },
    fstatSync(descriptor) {
      return {
        birthtimeNs: 1n,
        ctimeNs: 1n,
        dev: 1n,
        ino: identities.get(descriptor.candidate.toLowerCase()),
        mode: 33188n,
        mtimeNs: 1n,
        nlink: files.has(descriptor.candidate) ? 1n : 0n,
        size: BigInt(PROOF.length),
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false
      };
    },
    closeSync() {},
    readdirSync(candidate, options) {
      if (!directories.has(candidate)) {
        throw missing();
      }
      const candidateFile = path.win32.join(candidate, "return-license.log");
      if (!files.has(candidateFile)) {
        return [];
      }
      if (options && options.withFileTypes) {
        return [{
          name: "return-license.log",
          isFile: () => true,
          isSymbolicLink: () => false
        }];
      }
      return ["return-license.log"];
    },
    rmdirSync(candidate) {
      if (!directories.delete(candidate)) {
        throw missing();
      }
    },
    renameSync(source, destination) {
      if (!directories.delete(source)) {
        throw missing();
      }
      directories.add(destination);
      identities.set(
        destination.toLowerCase(),
        identities.get(source.toLowerCase())
      );
      const sourceFile = path.win32.join(source, "return-license.log");
      const destinationFile = path.win32.join(destination, "return-license.log");
      if (files.delete(sourceFile)) {
        files.add(destinationFile);
        identities.set(
          destinationFile.toLowerCase(),
          identities.get(sourceFile.toLowerCase())
        );
      }
    },
    unlinkSync(candidate) {
      if (!files.delete(candidate)) {
        throw missing();
      }
    }
  };
  const identity = inspectReturnEvidenceTarget(target, io, path.win32);
  const { claimedIdentity, claimedTarget } = claimConsumedReturnEvidence(
    target,
    identity,
    io,
    path.win32,
    () => Buffer.alloc(16, 0xab)
  );
  deleteClaimedReturnEvidence(
    claimedTarget,
    claimedIdentity,
    target,
    io,
    path.win32,
    (candidate) => {
      files.delete(candidate.returnLogPath);
      directories.delete(candidate.evidenceDirectory);
    }
  );
  assert.equal(files.size, 0);
  assert.equal(directories.has(target.evidenceDirectory), false);
  assert.equal(directories.has(target.runnerTemp), true);
});

test("Windows identity deletion invokes the private handle-based helper with exact identities", () => {
  const helperSource = fs.readFileSync(
    path.join(path.dirname(runtimePath), "delete-unity-return-evidence.ps1"),
    "utf8"
  );
  assert.match(helperSource, /CreateFile/);
  assert.match(helperSource, /ReadFile/);
  assert.match(helperSource, /SHA256/);
  assert.match(helperSource, /SetFileInformationByHandle/);
  assert.doesNotMatch(helperSource, /\b(?:Remove-Item|unlink|rmdir)\b/i);
  const stat = (ino, size) => ({
    birthtimeNs: 1700000000000000000n,
    ctimeNs: 1700000000500000000n,
    dev: 42n,
    ino,
    mtimeNs: 1700000001000000000n,
    nlink: 1n,
    size
  });
  const claimedTarget = {
    evidenceDirectory: "D:\\actions\\_temp\\unity-return-123-1-qora.consuming-abcd",
    returnLogPath:
      "D:\\actions\\_temp\\unity-return-123-1-qora.consuming-abcd\\return-license.log"
  };
  let invocation;
  identityBoundDeleteWindows(
    claimedTarget,
    {
      evidenceDirectoryStat: stat(100n, 0n),
      returnLogStat: stat(101n, 123n)
    },
    "a".repeat(64),
    {
      platform: "win32",
      systemRoot: "C:\\Windows",
      spawnSync(command, args, options) {
        invocation = { command, args, options };
        return { status: 0, signal: null };
      }
    }
  );
  assert.equal(
    invocation.command,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  );
  assert.deepEqual(invocation.args.slice(0, 6), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File"
  ]);
  assert.match(invocation.args[6], /delete-unity-return-evidence\.ps1$/);
  assert.equal(invocation.options.env.UNITY_DELETE_DIRECTORY_PATH, claimedTarget.evidenceDirectory);
  assert.equal(invocation.options.env.UNITY_DELETE_FILE_PATH, claimedTarget.returnLogPath);
  assert.equal(invocation.options.env.UNITY_DELETE_FILE_INO, "101");
  assert.equal(invocation.options.env.UNITY_DELETE_FILE_SIZE, "123");
  assert.equal(invocation.options.env.UNITY_DELETE_EXPECTED_DIGEST, "a".repeat(64));
  assert.equal(
    invocation.options.env.UNITY_DELETE_FILE_CTIME_NS,
    "1700000000500000000"
  );
  assert.equal(invocation.options.stdio, "ignore");
  assert.equal(invocation.options.timeout, 30000);
  assert.equal(
    invocation.args.some((argument) => argument.includes(claimedTarget.evidenceDirectory)),
    false
  );
  assert.throws(
    () => identityBoundDeleteWindows(
      claimedTarget,
      {
        evidenceDirectoryStat: stat(100n, 0n),
        returnLogStat: stat(101n, 123n)
      },
      "a".repeat(64),
      { platform: "linux" }
    ),
    /requires Windows/
  );
});

test(
  "Windows helper deletes real claimed central evidence by native handle",
  { skip: process.platform !== "win32" },
  (t) => {
    const item = centralEvidenceFixture(t, "unity-cleanup-windows-native-");
    const result = run({
      inputs: centralInputs(item),
      outputPath: item.outputPath,
      environment: item.environment,
      log: () => {}
    });
    assert.equal(result.classificationComplete, true);
    assert.equal(fs.existsSync(item.returnLog), false);
    assert.equal(fs.existsSync(item.evidenceDirectory), false);
  }
);

test(
  "Windows helper rejects a same-size rewrite with all metadata restored",
  { skip: process.platform !== "win32" },
  (t) => {
    const item = centralEvidenceFixture(t, "unity-cleanup-windows-change-time-");
    const inputs = centralInputs(item);
    let mutatedPath;
    assert.throws(() => run({
      inputs,
      outputPath: item.outputPath,
      environment: item.environment,
      deleteByIdentity(claimedTarget, claimedIdentity) {
        mutatedPath = claimedTarget.returnLogPath;
        const expected = claimedIdentity.returnLogStat;
        fs.writeFileSync(mutatedPath, Buffer.alloc(Number(expected.size), 88));
        restoreWindowsFileTimes(mutatedPath, expected);
        const restored = fs.lstatSync(mutatedPath, { bigint: true });
        assert.equal(restored.dev, expected.dev);
        assert.equal(restored.ino, expected.ino);
        assert.equal(restored.size, expected.size);
        assert.equal(restored.birthtimeNs, expected.birthtimeNs);
        assert.equal(restored.mtimeNs, expected.mtimeNs);
        assert.equal(restored.ctimeNs, expected.ctimeNs);
        identityBoundDeleteWindows(
          claimedTarget,
          claimedIdentity,
          inputs["return-log-digest"]
        );
      },
      log: () => {}
    }), /Identity-bound return evidence deletion failed/);
    assert.equal(fs.existsSync(mutatedPath), true);
    const outputs = fs.readFileSync(item.outputPath, "utf8");
    assert.match(outputs, /^classification-complete=false$/m);
    assert.doesNotMatch(outputs, /^classification-complete=true$/m);
  }
);

test("unsafe deletion shapes fail closed before completed outputs", async (t) => {
  await t.test("symbolic-link ancestry", { skip: process.platform === "win32" }, () => {
    const item = centralEvidenceFixture(t, "unity-cleanup-link-");
    const linkedRunnerTemp = path.join(item.root, "linked-runner-temp");
    fs.symlinkSync(item.runnerTemp, linkedRunnerTemp, "dir");
    const linkedReturnLog = path.join(
      linkedRunnerTemp,
      path.basename(item.evidenceDirectory),
      "return-license.log"
    );
    assert.throws(() => runClassifier({
      inputs: { ...centralInputs(item), "return-log-path": linkedReturnLog },
      outputPath: item.outputPath,
      environment: { ...item.environment, RUNNER_TEMP: linkedRunnerTemp },
      log: () => {}
    }), /symbolic link or reparse point/);
    assert.equal(fs.existsSync(item.returnLog), true);
  });

  await t.test("multiply linked return file", { skip: process.platform === "win32" }, () => {
    const item = centralEvidenceFixture(t, "unity-cleanup-hardlink-");
    fs.linkSync(item.returnLog, path.join(item.root, "other-name.log"));
    assert.throws(() => runClassifier({
      inputs: centralInputs(item),
      outputPath: item.outputPath,
      environment: item.environment,
      log: () => {}
    }), /singly linked regular file/);
    assert.equal(fs.existsSync(item.returnLog), true);
  });

  await t.test("unexpected sibling", () => {
    const item = centralEvidenceFixture(t, "unity-cleanup-sibling-");
    fs.writeFileSync(path.join(item.evidenceDirectory, "unowned.log"), "leave me\n");
    assert.throws(() => runClassifier({
      inputs: centralInputs(item),
      outputPath: item.outputPath,
      environment: item.environment,
      log: () => {}
    }), /unexpected entry/);
    assert.equal(centralEvidenceRemains(item), true);
  });

  await t.test("same-inode mutation during atomic claim", () => {
    const item = centralEvidenceFixture(t, "unity-cleanup-identity-");
    const io = {
      ...fs,
      renameSync(source, destination) {
        fs.renameSync(source, destination);
        fs.appendFileSync(path.join(destination, "return-license.log"), "mutation\n");
      }
    };
    assert.throws(() => runClassifier({
      inputs: centralInputs(item),
      outputPath: item.outputPath,
      environment: item.environment,
      io,
      log: () => {}
    }), /identity changed/);
    assert.equal(centralEvidenceRemains(item), true);
  });

  await t.test("different-inode swap immediately before atomic directory claim", () => {
    const item = centralEvidenceFixture(t, "unity-cleanup-claim-swap-");
    const originalDirectory = `${item.evidenceDirectory}.original`;
    let unlinkCalled = false;
    const io = {
      ...fs,
      renameSync(source, destination) {
        fs.renameSync(source, originalDirectory);
        fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, "return-license.log"), "substitution\n");
        fs.renameSync(source, destination);
      },
      unlinkSync(candidate) {
        unlinkCalled = true;
        fs.unlinkSync(candidate);
      }
    };
    assert.throws(() => runClassifier({
      inputs: centralInputs(item),
      outputPath: item.outputPath,
      environment: item.environment,
      io,
      log: () => {}
    }), /identity changed during deletion/);
    assert.equal(unlinkCalled, false);
    assert.equal(fs.existsSync(path.join(originalDirectory, "return-license.log")), true);
    assert.equal(centralEvidenceRemains(item), true);
  });

  await t.test("identity-bound file deletion preserves a pathname substitute", () => {
    const item = centralEvidenceFixture(t, "unity-cleanup-unlink-swap-");
    const savedEvidence = path.join(item.root, "saved-return-license.log");
    assert.throws(() => runClassifier({
      inputs: centralInputs(item),
      outputPath: item.outputPath,
      environment: item.environment,
      deleteByIdentity(claimedTarget) {
        fs.renameSync(claimedTarget.returnLogPath, savedEvidence);
        fs.writeFileSync(claimedTarget.returnLogPath, "substitution\n");
        fs.unlinkSync(savedEvidence);
        fs.rmdirSync(claimedTarget.evidenceDirectory);
      },
      log: () => {}
    }), /directory not empty|ENOTEMPTY/);
    const consumingDirectory = fs.readdirSync(item.runnerTemp)
      .find((name) => name.includes(".consuming-"));
    assert.equal(
      fs.readFileSync(
        path.join(item.runnerTemp, consumingDirectory, "return-license.log"),
        "utf8"
      ),
      "substitution\n"
    );
    assert.equal(fs.existsSync(savedEvidence), false);
    const outputs = fs.readFileSync(item.outputPath, "utf8");
    assert.match(outputs, /^classification-complete=false$/m);
    assert.doesNotMatch(outputs, /^classification-complete=true$/m);
  });

  await t.test("identity-bound directory deletion preserves a pathname substitute", () => {
    const item = centralEvidenceFixture(t, "unity-cleanup-directory-swap-");
    let savedDirectory;
    assert.throws(() => runClassifier({
      inputs: centralInputs(item),
      outputPath: item.outputPath,
      environment: item.environment,
      deleteByIdentity(claimedTarget) {
        savedDirectory = `${claimedTarget.evidenceDirectory}.saved`;
        fs.renameSync(claimedTarget.evidenceDirectory, savedDirectory);
        fs.mkdirSync(claimedTarget.evidenceDirectory);
        fs.writeFileSync(
          path.join(claimedTarget.evidenceDirectory, "substitute.txt"),
          "substitution\n"
        );
        fs.unlinkSync(path.join(savedDirectory, "return-license.log"));
        fs.rmdirSync(savedDirectory);
      },
      log: () => {}
    }), /remains after deletion/);
    assert.equal(fs.existsSync(savedDirectory), false);
    const consumingDirectory = fs.readdirSync(item.runnerTemp)
      .find((name) => name.includes(".consuming-"));
    assert.equal(
      fs.readFileSync(path.join(item.runnerTemp, consumingDirectory, "substitute.txt"), "utf8"),
      "substitution\n"
    );
    const outputs = fs.readFileSync(item.outputPath, "utf8");
    assert.match(outputs, /^classification-complete=false$/m);
    assert.doesNotMatch(outputs, /^classification-complete=true$/m);
  });

  for (const [name, deleteByIdentity, message] of [
    [
      "deletion failure",
      () => { throw new Error("simulated identity deletion failure"); },
      /identity deletion failure/
    ],
    ["post-delete presence", () => {}, /remains after deletion/]
  ]) {
    await t.test(name, () => {
      const item = centralEvidenceFixture(t, `unity-cleanup-${name.replaceAll(" ", "-")}-`);
      assert.throws(() => runClassifier({
        inputs: centralInputs(item),
        outputPath: item.outputPath,
        environment: item.environment,
        deleteByIdentity,
        log: () => {}
      }), message);
      assert.equal(centralEvidenceRemains(item), true);
      const outputs = fs.readFileSync(item.outputPath, "utf8");
      assert.match(outputs, /^classification-complete=false$/m);
      assert.doesNotMatch(outputs, /^classification-complete=true$/m);
    });
  }
});

test("failed authoritative return-log reads never delete or complete", async (t) => {
  const emptyDigest = crypto.createHash("sha256").update("").digest("hex");
  const cases = [
    {
      name: "invalid UTF-8",
      prepare(item) {
        fs.writeFileSync(item.returnLog, Buffer.from([0xc3, 0x28]));
        return fs;
      }
    },
    {
      name: "oversized",
      prepare(item) {
        fs.writeFileSync(item.returnLog, Buffer.alloc(MAX_EVIDENCE_TOTAL_BYTES + 1, 65));
        return fs;
      }
    },
    {
      name: "read failure",
      prepare() {
        return {
          ...fs,
          openSync(candidate, flags) {
            if (candidate.includes(".consuming-")) {
              throw new Error("simulated read failure");
            }
            return fs.openSync(candidate, flags);
          }
        };
      }
    }
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const item = centralEvidenceFixture(t, `unity-cleanup-read-${fixture.name.replaceAll(" ", "-")}-`);
      const io = fixture.prepare(item);
      assert.throws(() => runClassifier({
        inputs: {
          ...centralInputs(item),
          "return-log-digest": emptyDigest
        },
        outputPath: item.outputPath,
        environment: item.environment,
        io,
        log: () => {}
      }), /could not be read and validated/);
      assert.equal(centralEvidenceRemains(item), true);
      const outputs = fs.readFileSync(item.outputPath, "utf8");
      assert.match(outputs, /^classification-complete=false$/m);
      assert.doesNotMatch(outputs, /^classification-complete=true$/m);
    });
  }
});

test("action run emits only typed outputs and never prints evidence", (t) => {
  const item = centralEvidenceFixture(t, "unity-cleanup-run-");
  const {
    environment,
    evidenceDirectory,
    outputPath,
    returnLog
  } = item;
  const secretMarker = "SC-DO-NOT-PRINT";
  fs.writeFileSync(returnLog, `${ENTITLEMENT}\n[Licensing::Client] Successfully returned ULF license with serial number : ${secretMarker}\n`);
  const messages = [];
  const result = runClassifier({
    inputs: {
      "return-log-path": returnLog,
      "return-command-completed": "true",
      "return-exit-code": "0",
      "evidence-capture-complete": "true",
      "return-log-digest": centralInputs(item)["return-log-digest"],
      "supplemental-evidence-paths": ""
    },
    outputPath,
    environment,
    log: (message) => messages.push(message)
  });
  assert.equal(result.reason, "cleanup-confirmed");
  assert.equal(fs.existsSync(evidenceDirectory), false);
  const outputs = fs.readFileSync(outputPath, "utf8");
  assert.match(outputs, /^resource-safe=true$/m);
  assert.match(outputs, /^classification-complete=true$/m);
  assert.doesNotMatch(outputs, new RegExp(secretMarker));
  assert.doesNotMatch(messages.join("\n"), new RegExp(secretMarker));
});

test("successful classification leaves supplemental evidence untouched", (t) => {
  const item = centralEvidenceFixture(t, "unity-cleanup-supplemental-");
  const supplemental = path.join(item.root, "supplemental.log");
  fs.writeFileSync(supplemental, "account-health observation\n");
  const result = runClassifier({
    inputs: {
      ...centralInputs(item),
      "supplemental-evidence-paths": supplemental
    },
    outputPath: item.outputPath,
    environment: item.environment,
    log: () => {}
  });
  assert.equal(result.classificationComplete, true);
  assert.equal(fs.existsSync(item.evidenceDirectory), false);
  assert.equal(fs.readFileSync(supplemental, "utf8"), "account-health observation\n");
});

test("missing central digest fails closed and preserves return evidence", (t) => {
  const item = centralEvidenceFixture(t, "unity-cleanup-missing-digest-");
  assert.throws(() => runClassifier({
      inputs: {
        "return-log-path": item.returnLog,
        "return-command-completed": "true",
        "return-exit-code": "0",
        "evidence-capture-complete": "true",
        "supplemental-evidence-paths": ""
      },
      outputPath: item.outputPath,
      environment: item.environment,
      log: () => {}
    }), /return-log-digest is required/);
  assert.equal(centralEvidenceRemains(item), true);
  assert.match(fs.readFileSync(item.outputPath, "utf8"), /classification-complete=false/);
  assert.doesNotMatch(fs.readFileSync(item.outputPath, "utf8"), /classification-complete=true/);
});

test("classifier rejects return-log replacement against the linked digest", (t) => {
  const item = centralEvidenceFixture(t, "unity-cleanup-digest-");
  const digest = crypto.createHash("sha256").update(PROOF).digest("hex");
  fs.writeFileSync(item.returnLog, `${PROOF}replacement\n`);
  assert.throws(() => runClassifier({
      inputs: {
        "return-log-path": item.returnLog,
        "return-command-completed": "true",
        "return-exit-code": "0",
        "evidence-capture-complete": "true",
        "return-log-digest": digest,
        "supplemental-evidence-paths": ""
      },
      outputPath: item.outputPath,
      environment: item.environment,
      log: () => {}
  }), /digest does not match/);
  assert.equal(centralEvidenceRemains(item), true);
  assert.match(fs.readFileSync(item.outputPath, "utf8"), /classification-complete=false/);
});
