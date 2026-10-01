// Shared fixtures for the Unity cleanup evidence contract.
//
// The two Windows-native tests live in their own file so they run in a separate
// process from each other. Each one spawns Windows PowerShell, whose Add-Type
// call compiles C# with csc.exe and costs about fifteen seconds per spawn, so
// running them one after the other made the Windows CI job ninety-three seconds
// long while the rest of the job took sixteen. Measured on run 36904676960:
// seventy-six of the seventy-eight seconds of that job's test step were these
// two tests.
//
// Nothing here is a test. The helpers are shared so the split moves no
// assertion and no fixture.
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const runtimePath = path.join(
  __dirname,
  "..",
  ".github",
  "dist",
  "classify-unity-cleanup-evidence.js"
);
const runtime = require(runtimePath);
const { inspectReturnEvidenceTarget, run } = runtime;

const ENTITLEMENT = "[Licensing::Module] Successfully returned the entitlement license";
const ULF = "[Licensing::Client] Successfully returned ULF license with serial number : SC-REDACTED";
const PROOF = `${ENTITLEMENT}\n${ULF}\n`;

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


// The two native tests below both need the real runtime entry points, so they
// are re-exported rather than reached through the classifier helper.
// The runtime is re-exported whole, so a test that reaches for a symbol keeps
// reaching the same module it always did.
module.exports = {
  ...runtime,
  assert,
  centralEvidenceFixture,
  centralEvidenceRemains,
  centralInputs,
  childProcess,
  crypto,
  ENTITLEMENT,
  fs,
  modelIdentityDelete,
  os,
  path,
  PROOF,
  restoreWindowsFileTimes,
  runtimePath,
  runClassifier,
  ULF
};
