// Windows-native refusal of a same-size rewrite with restored metadata.
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

// Windows PowerShell compiles the committed helper's C# with Add-Type, which
// shells out to csc.exe. This test spawns it twice: once to restore the
// rewritten file's metadata, and once for the production helper that must
// refuse it. It is the slower of the pair.
//
// `node --test` runs the tests inside one file one after another. This test and
// its sibling used to share a file with the rest of the suite and run in
// sequence. They are in files of their own so each gets a process.
//
// The split moves no assertion. This half keeps its fixture, its skip, and the
// real helper.

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
