#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const ALLOWED = {
  boolean: new Set(["true", "false"]),
  jobResult: new Set(["success", "failure", "cancelled", "skipped"]),
  fallbackCleanupResult: new Set([
    "",
    "missing",
    "none",
    "cooldown-started",
    "quarantined",
    "global-quarantined",
    "released",
    "queue-cleaned",
    "noop"
  ])
};

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function observedValues(values) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, text(value)])
  );
}

function unsafe(reason) {
  return { safe: false, reason };
}

function evaluateValidationGate(values) {
  const observed = observedValues(values);
  if (observed.staticValidationResult !== "success") {
    return unsafe("static validation did not succeed");
  }
  if (observed.classifierResult !== "success") {
    return unsafe("Unity change classification did not succeed");
  }
  if (!ALLOWED.boolean.has(observed.unityRequired)) {
    return unsafe("Unity change classification emitted an invalid requirement");
  }
  if (!ALLOWED.boolean.has(observed.trustedRevision)) {
    return unsafe("the revision trust decision is missing or invalid");
  }

  if (observed.trustedRevision === "false") {
    if (
      observed.preflightResult === "skipped"
      && observed.unityResult === "skipped"
      && observed.fallbackResult === "skipped"
      && observed.fallbackCleanupResult === ""
    ) {
      return { safe: true, reason: "untrusted revision skip" };
    }
    return unsafe("an untrusted revision did not skip every credential-bearing Unity job");
  }

  if (observed.preflightResult !== "success") {
    return unsafe("Unity runner preflight did not succeed");
  }
  if (observed.unityRequired === "false") {
    if (
      observed.unityResult === "skipped"
      && observed.fallbackResult === "skipped"
      && observed.fallbackCleanupResult === ""
    ) {
      return { safe: true, reason: "audited non-Unity skip" };
    }
    return unsafe("a non-Unity revision did not skip licensed work and fallback cleanup");
  }
  if (observed.unityResult !== "success") {
    return unsafe("licensed Unity validation did not succeed");
  }
  if (observed.fallbackResult !== "success") {
    return unsafe("hosted fallback cleanup did not succeed");
  }
  if (observed.fallbackCleanupResult !== "noop") {
    return unsafe("a green Unity job left central lock state requiring fallback cleanup");
  }
  return { safe: true, reason: "licensed success" };
}

function allowedValue(value, allowed) {
  const normalized = text(value);
  return allowed.has(normalized) ? (normalized || "missing") : "invalid";
}

function formatDiagnostic(values, reason) {
  return [
    reason,
    `static-validation=${allowedValue(values.staticValidationResult, ALLOWED.jobResult)}`,
    `classifier=${allowedValue(values.classifierResult, ALLOWED.jobResult)}`,
    `unity-required=${allowedValue(values.unityRequired, ALLOWED.boolean)}`,
    `trusted=${allowedValue(values.trustedRevision, ALLOWED.boolean)}`,
    `preflight=${allowedValue(values.preflightResult, ALLOWED.jobResult)}`,
    `unity=${allowedValue(values.unityResult, ALLOWED.jobResult)}`,
    `fallback=${allowedValue(values.fallbackResult, ALLOWED.jobResult)}`,
    `fallback-cleanup=${allowedValue(
      values.fallbackCleanupResult,
      ALLOWED.fallbackCleanupResult
    )}`
  ].join(" ");
}

function appendOutput(outputPath, safe) {
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required.");
  }
  fs.appendFileSync(outputPath, `validation-safe=${safe ? "true" : "false"}\n`, "utf8");
}

function run({ values, outputPath, log = console.log, error = console.error }) {
  appendOutput(outputPath, false);
  const result = evaluateValidationGate(values);
  const diagnostic = formatDiagnostic(values, result.reason);
  if (!result.safe) {
    error(`::error title=Unity validation is incomplete::${diagnostic}`);
    return result;
  }
  appendOutput(outputPath, true);
  log(`Unity validation is complete. ${diagnostic}`);
  return result;
}

function input(name, environment = process.env) {
  return (environment[`INPUT_${name.toUpperCase()}`] || "").trim();
}

function environmentValues(environment = process.env) {
  return {
    staticValidationResult: input("static-validation-result", environment),
    classifierResult: input("classifier-result", environment),
    unityRequired: input("unity-required", environment),
    trustedRevision: input("trusted-revision", environment),
    preflightResult: input("preflight-result", environment),
    unityResult: input("unity-result", environment),
    fallbackResult: input("fallback-result", environment),
    fallbackCleanupResult: input("fallback-cleanup-result", environment)
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
    console.error("::error title=Unity validation is incomplete::Gate failed closed.");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  environmentValues,
  evaluateValidationGate,
  formatDiagnostic,
  run
};
