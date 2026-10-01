// Windows-native deletion of real claimed central evidence.
"use strict";

const test = require("node:test");

const {
  assert,
  fs,
  run,
  centralEvidenceFixture,
  centralInputs
} = require("./unity-cleanup-evidence-support.js");

// Windows PowerShell compiles the committed helper's C# with Add-Type, which
// shells out to csc.exe, so one spawn costs about fifteen to thirty seconds on
// a hosted runner. This test spawns it once.
//
// `node --test` runs the tests inside one file one after another, so this test
// and its sibling used to run in sequence and take seventy-six of the
// seventy-eight seconds of the Windows CI test step. They are in files of their
// own so each gets a process.
//
// The split moves no assertion. This half keeps its fixture, its skip, and the
// real helper.

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
