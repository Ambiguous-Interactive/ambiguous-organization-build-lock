// The Windows-native half of the Unity cleanup evidence contract.
//
// One half of the Windows-native Unity cleanup evidence contract.
//
// Each test here spawns the committed PowerShell helper, and Windows PowerShell
// compiles the helper's C# with Add-Type, which shells out to csc.exe. One spawn
// costs about fifteen to thirty seconds on a hosted runner.
//
// Both halves used to sit in one file, and node --test runs the tests inside one
// file one after another. That made them seventy-six of the seventy-eight seconds
// of a Windows CI test step, and the job the slowest one on every pull request.
//
// They are in two files of their own so the runner gives each a process. A
// first attempt put them in one shared file and the job still took ninety-seven
// seconds; the log showed both tests finishing one after the other.
//
// The split moves no assertion. This half keeps its fixture, its skip, and the
// real helper.
//
// The split moves no assertion. Both tests keep their fixture, their skip, and
// the real helper.
"use strict";

const test = require("node:test");

const {
  assert,
  fs,
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
