// The second half of the Windows-native Unity cleanup evidence contract.
//
// Each test here spawns the committed PowerShell helper, and Windows PowerShell
// compiles the helper's C# with Add-Type, which shells out to csc.exe. One spawn
// costs about fifteen to thirty seconds on a hosted runner.
//
// Both halves used to sit in one file, and node --test runs the tests inside one
// file one after another. That made them seventy-six of the seventy-eight seconds
// of a Windows CI test step, and the job the slowest one on every pull request.
// They are in two files of their own so the runner gives each a process.
//
// This half restores a rewritten file's metadata and then proves the production
// helper refuses it, which is why it is the slower of the two.
//
// The split moves no assertion. This half keeps its fixture, its skip, and the
// real helper.
"use strict";

const test = require("node:test");

const {
  assert,
  fs,
  identityBoundDeleteWindows,
  restoreWindowsFileTimes,
  run,
  centralEvidenceFixture,
  centralInputs
} = require("./unity-cleanup-evidence-support.js");

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
