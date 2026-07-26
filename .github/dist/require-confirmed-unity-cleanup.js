#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const ABSENT_VALUES = new Set(["", "missing", "none"]);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ALLOWED = {
  boolean: new Set(["true", "false"]),
  cleanupStatus: new Set(["confirmed", "unknown"]),
  health: new Set(["healthy", "blocked"]),
  reason: new Set([
    "cleanup-confirmed",
    "cleanup-evidence-unknown",
    "unity-account-limit-20111",
    "unity-20113-unclassified",
    "unity-return-400006",
    "return-timeout",
    "return-log-truncated",
    "return-terminated",
    "return-missing-positive-evidence",
    "return-ulf-skipped",
    "activation-timeout",
    "activation-terminated"
  ]),
  releaseOutcome: new Set(["success", "failure", "cancelled", "skipped"]),
  cleanupResult: new Set([
    "cooldown-started",
    "quarantined",
    "global-quarantined",
    "released",
    "queue-cleaned",
    "noop"
  ]),
  reservationState: new Set(["", "none", "missing", "cooldown", "quarantine"])
};

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function present(value) {
  return !ABSENT_VALUES.has(text(value));
}

function safeOpaque(value) {
  const normalized = text(value);
  return !present(normalized) || OPAQUE_ID_PATTERN.test(normalized);
}

function evaluateCleanupGate(values) {
  const observed = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, text(value)])
  );
  const failures = [];
  if (observed.acquired !== "true") {
    failures.push("the organization Unity lock was not acquired");
  }
  if (observed.classificationComplete !== "true") {
    failures.push("Unity cleanup classification did not complete");
  }
  if (observed.cleanupStatus !== "confirmed") {
    failures.push("Unity cleanup was not confirmed");
  }
  if (observed.cleanupHealth !== "healthy") {
    failures.push("Unity cleanup did not report healthy account state");
  }
  if (observed.cleanupReason !== "cleanup-confirmed") {
    failures.push("Unity cleanup did not emit the exact confirmed-cleanup reason");
  }
  if (observed.releaseOutcome !== "success") {
    failures.push("the central release step did not succeed");
  }
  if (!new Set(["cooldown-started", "released"]).has(observed.cleanupResult)) {
    failures.push("the central release did not report a safe holder-release result");
  }
  if (observed.released !== "true") {
    failures.push("the central release did not confirm holder ownership removal");
  }
  if (observed.releaseHealth !== "healthy") {
    failures.push("the central release did not report healthy resource state");
  }
  if (observed.releaseReason !== "cleanup-confirmed") {
    failures.push("the central release did not preserve the confirmed-cleanup reason");
  }
  if (!safeOpaque(observed.incidentId)) {
    failures.push("the central release emitted an invalid incident identifier");
  } else if (present(observed.incidentId)) {
    failures.push("the central release reported an active account incident");
  }
  if (!safeOpaque(observed.reservationId)) {
    failures.push("the central release emitted an invalid reservation identifier");
  }
  if (observed.cleanupResult === "cooldown-started") {
    if (observed.reservationState !== "cooldown" || !present(observed.reservationId)) {
      failures.push("the central release did not identify its cooldown reservation");
    }
  } else if (
    observed.cleanupResult === "released"
    && (present(observed.reservationState) || present(observed.reservationId))
  ) {
    failures.push("a direct release reported a contradictory lifecycle reservation");
  }
  return { safe: failures.length === 0, failures };
}

function allowedValue(value, allowed) {
  const normalized = text(value);
  return allowed.has(normalized) ? (normalized || "missing") : "invalid";
}

function formatDiagnostic(values, failures) {
  return [
    failures.join("; "),
    `acquired=${allowedValue(values.acquired, ALLOWED.boolean)}`,
    `classification=${allowedValue(values.classificationComplete, ALLOWED.boolean)}`,
    `cleanup=${allowedValue(values.cleanupStatus, ALLOWED.cleanupStatus)}/${allowedValue(values.cleanupHealth, ALLOWED.health)}`,
    `cleanup-reason=${allowedValue(values.cleanupReason, ALLOWED.reason)}`,
    `release=${allowedValue(values.releaseOutcome, ALLOWED.releaseOutcome)}/${allowedValue(values.cleanupResult, ALLOWED.cleanupResult)}`,
    `released=${allowedValue(values.released, ALLOWED.boolean)}`,
    `release-health=${allowedValue(values.releaseHealth, ALLOWED.health)}`,
    `release-reason=${allowedValue(values.releaseReason, ALLOWED.reason)}`,
    `reservation=${allowedValue(values.reservationState, ALLOWED.reservationState)}/${present(values.reservationId) ? "present" : "none"}`,
    `incident=${present(values.incidentId) ? "present" : "none"}`
  ].join(" ");
}

function appendOutput(outputPath, safe) {
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required.");
  }
  fs.appendFileSync(outputPath, `cleanup-safe=${safe ? "true" : "false"}\n`, "utf8");
}

function run({ values, outputPath, log = console.log, error = console.error }) {
  appendOutput(outputPath, false);
  const result = evaluateCleanupGate(values);
  const diagnostic = formatDiagnostic(values, result.failures);
  if (!result.safe) {
    error(`::error title=Licensed Unity cleanup is not safe::${diagnostic}`);
    return result;
  }
  appendOutput(outputPath, true);
  log(`Licensed Unity cleanup is confirmed. ${diagnostic}`);
  return result;
}

function input(name, environment = process.env) {
  return (environment[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] || "").trim();
}

function environmentValues(environment = process.env) {
  return {
    acquired: input("acquired", environment),
    classificationComplete: input("classification-complete", environment),
    cleanupStatus: input("cleanup-status", environment),
    cleanupHealth: input("cleanup-health", environment),
    cleanupReason: input("cleanup-reason", environment),
    releaseOutcome: input("release-outcome", environment),
    cleanupResult: input("cleanup-result", environment),
    released: input("released", environment),
    releaseHealth: input("release-health", environment),
    releaseReason: input("release-reason", environment),
    reservationState: input("reservation-state", environment),
    reservationId: input("reservation-id", environment),
    incidentId: input("incident-id", environment)
  };
}

function main() {
  try {
    const result = run({
      values: environmentValues(),
      outputPath: process.env.GITHUB_OUTPUT || ""
    });
    if (!result.safe) {
      process.exitCode = 1;
    }
  } catch {
    console.error("::error title=Licensed Unity cleanup is not safe::Gate failed closed.");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  environmentValues,
  evaluateCleanupGate,
  formatDiagnostic,
  run
};
