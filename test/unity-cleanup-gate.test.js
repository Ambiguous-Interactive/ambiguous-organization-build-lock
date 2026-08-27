"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  environmentValues,
  evaluateCleanupGate,
  formatDiagnostic
} = require("../.github/dist/require-confirmed-unity-cleanup.js");

const gateRuntimePath = path.join(
  __dirname,
  "..",
  ".github",
  "dist",
  "require-confirmed-unity-cleanup.js"
);

const safeCooldown = {
  acquired: "true",
  classificationComplete: "true",
  cleanupStatus: "confirmed",
  cleanupHealth: "healthy",
  cleanupReason: "cleanup-confirmed",
  releaseOutcome: "success",
  cleanupResult: "cooldown-started",
  released: "true",
  releaseHealth: "healthy",
  releaseReason: "cleanup-confirmed",
  reservationState: "cooldown",
  reservationId: "reservation-abc",
  incidentId: ""
};
const activeIncidentId = "incident-0123456789abcdef01234567";

test("gate accepts only coherent confirmed cleanup releases", async (t) => {
  await t.test("explicitly not acquired", () => {
    assert.deepEqual(evaluateCleanupGate({
      ...Object.fromEntries(Object.keys(safeCooldown).map((key) => [key, "missing"])),
      acquired: "false"
    }), { safe: true, failures: [] });
  });
  await t.test("safe cooldown", () => {
    assert.deepEqual(evaluateCleanupGate(safeCooldown), { safe: true, failures: [] });
  });
  await t.test("safe direct release", () => {
    assert.deepEqual(evaluateCleanupGate({
      ...safeCooldown,
      cleanupResult: "released",
      reservationState: "",
      reservationId: ""
    }), { safe: true, failures: [] });
  });
  await t.test("safe local cooldown while a global incident blocks new admission", () => {
    assert.deepEqual(evaluateCleanupGate({
      ...safeCooldown,
      cleanupResult: "global-quarantined",
      incidentId: activeIncidentId
    }), { safe: true, failures: [] });
  });
  await t.test("safe local direct release while a global incident blocks new admission", () => {
    assert.deepEqual(evaluateCleanupGate({
      ...safeCooldown,
      cleanupResult: "global-quarantined",
      reservationState: "",
      reservationId: "",
      incidentId: activeIncidentId
    }), { safe: true, failures: [] });
  });

  const failures = [
    ["classification incomplete", { classificationComplete: "false" }],
    ["unknown cleanup", { cleanupStatus: "unknown", cleanupReason: "return-timeout" }],
    ["blocked account", { cleanupStatus: "unknown", cleanupHealth: "blocked", cleanupReason: "unity-account-limit-20111" }],
    ["release failed", { releaseOutcome: "failure" }],
    ["quarantine", { cleanupResult: "quarantined", released: "true", reservationState: "quarantine" }],
    ["global quarantine without incident identity", { cleanupResult: "global-quarantined" }],
    ["global quarantine with blocked local release", {
      cleanupResult: "global-quarantined",
      releaseHealth: "blocked",
      releaseReason: "unity-account-limit-20111",
      incidentId: activeIncidentId
    }],
    ["queue clean only", { cleanupResult: "queue-cleaned", released: "false" }],
    ["noop", { cleanupResult: "noop", released: "false" }],
    ["holder not removed", { released: "false" }],
    ["release health mismatch", { releaseHealth: "blocked" }],
    ["release reason mismatch", { releaseReason: "return-log-truncated" }],
    ["incident present without global result", { incidentId: activeIncidentId }],
    ["global quarantine with malformed incident identity", {
      cleanupResult: "global-quarantined",
      incidentId: "incident-abc"
    }],
    ["global quarantine with contradictory reservation", {
      cleanupResult: "global-quarantined",
      reservationState: "quarantine",
      incidentId: activeIncidentId
    }],
    ["cooldown state missing", { reservationState: "", reservationId: "" }],
    ["cooldown id missing", { reservationId: "" }],
    ["direct release has reservation", { cleanupResult: "released" }],
    ["unrecorded release", {
      releaseOutcome: "failure",
      cleanupResult: "lock-release-unreachable",
      released: "false",
      reservationState: "",
      reservationId: ""
    }],
    ["missing outputs", Object.fromEntries(Object.keys(safeCooldown).map((key) => [key, ""]))]
  ];

  for (const [name, patch] of failures) {
    await t.test(name, () => {
      const result = evaluateCleanupGate({ ...safeCooldown, ...patch });
      assert.equal(result.safe, false);
      assert.ok(result.failures.length > 0);
    });
  }
});

test("gate fails ambiguous acquisition state without misdiagnosing cleanup", () => {
  for (const acquired of ["", "missing", "unexpected"]) {
    const values = {
      ...Object.fromEntries(Object.keys(safeCooldown).map((key) => [key, "missing"])),
      acquired
    };
    const result = evaluateCleanupGate(values);
    assert.deepEqual(result, {
      safe: false,
      failures: ["the organization Unity lock acquisition state is missing or invalid"]
    });
    const diagnostic = formatDiagnostic(values, result.failures);
    assert.match(diagnostic, /lock acquisition state is missing or invalid/);
    assert.doesNotMatch(diagnostic, /cleanup was not confirmed/);
  }
});

// Issue #198: an unreachable lock-state write used to render as
// `release=failure/invalid released=invalid release-health=invalid`, which reads as
// a lock in an unknown state. The resource was returned; only the record was not.
test("gate names an unrecorded release instead of reporting an unknown lock state", () => {
  const values = {
    ...safeCooldown,
    releaseOutcome: "failure",
    cleanupResult: "lock-release-unreachable",
    released: "false",
    reservationState: "",
    reservationId: ""
  };
  const result = evaluateCleanupGate(values);

  assert.equal(result.safe, false);
  assert.deepEqual(result.failures, [
    "the central release step did not succeed",
    "the central release could not confirm holder removal because the lock-state file stayed unreachable " +
      "(the licensed resource was returned; if the removal did not land, the scheduled reaper quarantines the " +
      "stale holder entry and it keeps consuming lock capacity until it is reclaimed or recovered)"
  ]);

  const diagnostic = formatDiagnostic(values, result.failures);
  assert.match(diagnostic, /release=failure\/lock-release-unreachable/);
  assert.match(diagnostic, /released=false release-health=healthy release-reason=cleanup-confirmed/);
  assert.doesNotMatch(diagnostic, /invalid/);
});

test("gate diagnostic contains only allowlisted typed values and escapes commands", () => {
  const malicious = {
    ...safeCooldown,
    cleanupStatus: "unknown\n::warning::spoofed",
    cleanupReason: "return-timeout\r\n%spoof"
  };
  const result = evaluateCleanupGate(malicious);
  assert.equal(result.safe, false);
  const diagnostic = formatDiagnostic(malicious, result.failures);
  assert.doesNotMatch(diagnostic, /spoofed/);
  assert.doesNotMatch(diagnostic, /\r|\n/);
  assert.match(diagnostic, /invalid/);
});

test("gate diagnostic preserves the bounded return-command failure reason", () => {
  const values = {
    ...safeCooldown,
    cleanupStatus: "unknown",
    cleanupReason: "return-command-failed",
    cleanupResult: "quarantined",
    releaseReason: "return-command-failed",
    reservationState: "quarantine"
  };
  const result = evaluateCleanupGate(values);
  assert.equal(result.safe, false);
  const diagnostic = formatDiagnostic(values, result.failures);
  assert.match(diagnostic, /cleanup-reason=return-command-failed/);
  assert.match(diagnostic, /release-reason=return-command-failed/);
  assert.doesNotMatch(diagnostic, /invalid/);
});

test("GitHub action input environment preserves hyphenated input names", () => {
  assert.deepEqual(environmentValues({
    "INPUT_ACQUIRED": "true",
    "INPUT_CLASSIFICATION-COMPLETE": "true",
    "INPUT_CLEANUP-STATUS": "confirmed",
    "INPUT_CLEANUP-HEALTH": "healthy",
    "INPUT_CLEANUP-REASON": "cleanup-confirmed",
    "INPUT_RELEASE-OUTCOME": "success",
    "INPUT_CLEANUP-RESULT": "released",
    "INPUT_RELEASED": "true",
    "INPUT_RELEASE-HEALTH": "healthy",
    "INPUT_RELEASE-REASON": "cleanup-confirmed",
    "INPUT_RESERVATION-STATE": "",
    "INPUT_RESERVATION-ID": "",
    "INPUT_INCIDENT-ID": ""
  }), {
    acquired: "true",
    classificationComplete: "true",
    cleanupStatus: "confirmed",
    cleanupHealth: "healthy",
    cleanupReason: "cleanup-confirmed",
    releaseOutcome: "success",
    cleanupResult: "released",
    released: "true",
    releaseHealth: "healthy",
    releaseReason: "cleanup-confirmed",
    reservationState: "",
    reservationId: "",
    incidentId: ""
  });
});

test("committed gate runtime exits nonzero for unsafe cleanup and zero only for safe cleanup", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-cleanup-gate-runtime-"));
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

  const unsafeMarker = "DO-NOT-ECHO";
  const unsafe = execute({
    ...safeCooldown,
    cleanupStatus: `unknown\n::warning::${unsafeMarker}`,
    cleanupReason: "return-timeout",
    cleanupResult: "quarantined",
    reservationState: "quarantine"
  }, "unsafe.txt");
  assert.equal(unsafe.status, 1);
  assert.equal(unsafe.outputs.at(-1), "cleanup-safe=false");
  assert.doesNotMatch(`${unsafe.stdout}\n${unsafe.stderr}`, new RegExp(unsafeMarker));

  const safe = execute({
    ...safeCooldown,
    cleanupResult: "released",
    reservationState: "",
    reservationId: ""
  }, "safe.txt");
  assert.equal(safe.status, 0);
  assert.equal(safe.outputs.at(-1), "cleanup-safe=true");

  const safeDuringIncident = execute({
    ...safeCooldown,
    cleanupResult: "global-quarantined",
    incidentId: activeIncidentId
  }, "safe-during-incident.txt");
  assert.equal(safeDuringIncident.status, 0);
  assert.equal(safeDuringIncident.outputs.at(-1), "cleanup-safe=true");
  assert.match(safeDuringIncident.stdout, /::warning title=Global Unity account incident remains active::/);

  const notAcquired = execute({
    ...Object.fromEntries(Object.keys(safeCooldown).map((key) => [key, "missing"])),
    acquired: "false"
  }, "not-acquired.txt");
  assert.equal(notAcquired.status, 0);
  assert.equal(notAcquired.outputs.at(-1), "cleanup-safe=true");
  assert.match(notAcquired.stdout, /not required because the organization Unity lock was not acquired/);
});
