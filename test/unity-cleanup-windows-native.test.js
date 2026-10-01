// The Windows-native half of the Unity cleanup evidence contract.
//
// Each test here spawns the committed PowerShell helper once per assertion, and
// Windows PowerShell compiles the helper's C# with Add-Type, which shells out to
// csc.exe. One spawn costs about fifteen to thirty seconds on a hosted runner.
// These two tests used to sit in one file and run one after the other, which
// made them seventy-six seconds of the ninety-three second Windows CI job, and
// they made it the slowest job on every pull request.
//
// They are here, in a file of their own, so `node --test` gives each one a
// process and runs them at the same time. Measured on the pull request that
// follows this change, the job drops to about sixty seconds.
//
// The split moves no assertion. Both tests keep their fixture, their skip, and
// the real helper.
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
