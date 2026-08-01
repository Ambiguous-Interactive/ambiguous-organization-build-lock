"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  environmentValues,
  evaluateValidationGate,
  formatDiagnostic
} = require("../.github/dist/require-unity-validation.js");

const gateRuntimePath = path.join(
  __dirname,
  "..",
  ".github",
  "dist",
  "require-unity-validation.js"
);

const licensedSuccess = {
  staticValidationResult: "success",
  classifierResult: "success",
  unityRequired: "true",
  trustedRevision: "true",
  preflightResult: "success",
  unityResult: "success",
  fallbackResult: "success",
  fallbackCleanupResult: "noop"
};

test("validation gate accepts only explicit safe execution matrices", async (t) => {
  const accepted = [
    ["licensed success", licensedSuccess],
    ["audited non-Unity skip", {
      ...licensedSuccess,
      unityRequired: "false",
      unityResult: "skipped",
      fallbackResult: "skipped",
      fallbackCleanupResult: ""
    }],
    ["untrusted revision skip", {
      ...licensedSuccess,
      trustedRevision: "false",
      preflightResult: "skipped",
      unityResult: "skipped",
      fallbackResult: "skipped",
      fallbackCleanupResult: ""
    }]
  ];
  for (const [name, values] of accepted) {
    await t.test(name, () => {
      assert.deepEqual(evaluateValidationGate(values), {
        safe: true,
        reason: name
      });
    });
  }

  const rejected = [
    ["classifier failure", { classifierResult: "failure" }],
    ["missing classifier result", { classifierResult: "" }],
    ["invalid Unity requirement", { unityRequired: "maybe" }],
    ["invalid trust decision", { trustedRevision: "maybe" }],
    ["untrusted preflight ran", { trustedRevision: "false" }],
    ["untrusted Unity ran", {
      trustedRevision: "false",
      preflightResult: "skipped",
      unityResult: "success",
      fallbackResult: "skipped",
      fallbackCleanupResult: ""
    }],
    ["non-Unity work ran", {
      unityRequired: "false",
      unityResult: "success",
      fallbackResult: "skipped",
      fallbackCleanupResult: ""
    }],
    ["non-Unity fallback ran", {
      unityRequired: "false",
      unityResult: "skipped",
      fallbackResult: "success",
      fallbackCleanupResult: "noop"
    }],
    ["preflight failure", { preflightResult: "failure" }],
    ["licensed failure", { unityResult: "failure" }],
    ["fallback failure", { fallbackResult: "failure" }],
    ["fallback cleaned residue", { fallbackCleanupResult: "queue-cleaned" }],
    ["fallback quarantined residue", { fallbackCleanupResult: "quarantined" }],
    ["missing fallback cleanup result", { fallbackCleanupResult: "" }]
  ];
  for (const [name, patch] of rejected) {
    await t.test(name, () => {
      assert.equal(evaluateValidationGate({ ...licensedSuccess, ...patch }).safe, false);
    });
  }
});

test("validation diagnostic exposes only allowlisted typed values", () => {
  const malicious = {
    ...licensedSuccess,
    unityResult: "failure\n::warning::DO-NOT-ECHO",
    fallbackCleanupResult: "quarantined\r\n%spoof"
  };
  const result = evaluateValidationGate(malicious);
  assert.equal(result.safe, false);
  const diagnostic = formatDiagnostic(malicious, result.reason);
  assert.doesNotMatch(diagnostic, /DO-NOT-ECHO|spoof|\r|\n/);
  assert.match(diagnostic, /unity=invalid/);
  assert.match(diagnostic, /fallback-cleanup=invalid/);
});

test("GitHub action input environment preserves validation input names", () => {
  assert.deepEqual(environmentValues({
    "INPUT_STATIC-VALIDATION-RESULT": "success",
    "INPUT_CLASSIFIER-RESULT": "success",
    "INPUT_UNITY-REQUIRED": "true",
    "INPUT_TRUSTED-REVISION": "true",
    "INPUT_PREFLIGHT-RESULT": "success",
    "INPUT_UNITY-RESULT": "success",
    "INPUT_FALLBACK-RESULT": "success",
    "INPUT_FALLBACK-CLEANUP-RESULT": "noop"
  }), licensedSuccess);
});

test("committed validation runtime exits zero only for a safe matrix", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-validation-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  function execute(values, outputName) {
    const outputPath = path.join(root, outputName);
    const environment = { ...process.env, GITHUB_OUTPUT: outputPath };
    for (const [name, value] of Object.entries(values)) {
      const inputName = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      environment[`INPUT_${inputName.toUpperCase()}`] = value;
    }
    const processResult = childProcess.spawnSync(process.execPath, [gateRuntimePath], {
      encoding: "utf8",
      env: environment
    });
    return {
      ...processResult,
      outputs: fs.readFileSync(outputPath, "utf8").trim().split(/\r?\n/)
    };
  }

  const unsafe = execute({
    ...licensedSuccess,
    fallbackCleanupResult: "quarantined\n::warning::DO-NOT-ECHO"
  }, "unsafe.txt");
  assert.equal(unsafe.status, 1);
  assert.equal(unsafe.outputs.at(-1), "validation-safe=false");
  assert.doesNotMatch(`${unsafe.stdout}\n${unsafe.stderr}`, /DO-NOT-ECHO/);

  const safe = execute(licensedSuccess, "safe.txt");
  assert.equal(safe.status, 0);
  assert.equal(safe.outputs.at(-1), "validation-safe=true");
});
