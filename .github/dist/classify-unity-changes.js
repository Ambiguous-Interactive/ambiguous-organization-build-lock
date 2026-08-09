#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");

const INDEPENDENT_PREFIXES = [
  ".github/ISSUE_TEMPLATE/",
  ".llm/",
  "progress/"
];
const INDEPENDENT_PATHS = new Set([
  ".cursorrules",
  ".github/copilot-instructions.md",
  ".github/dependency-ownership.md"
]);

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function isUnityIndependent(changedPath) {
  if (typeof changedPath !== "string" || changedPath === "") {
    return false;
  }
  if (!changedPath.includes("/") && changedPath.endsWith(".md")) {
    return true;
  }
  if (INDEPENDENT_PATHS.has(changedPath)) {
    return true;
  }
  return INDEPENDENT_PREFIXES.some((prefix) => changedPath.startsWith(prefix));
}

function classifyUnityChanges(changedPaths) {
  if (!Array.isArray(changedPaths) ||
      changedPaths.some((changedPath) => typeof changedPath !== "string" || changedPath === "")) {
    throw new TypeError("changed paths must be a list of non-empty strings");
  }
  return changedPaths.length === 0 ||
    changedPaths.some((changedPath) => !isUnityIndependent(changedPath));
}

function requireSHA(value) {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new TypeError("pull request revisions must be full commit SHAs");
  }
}

function findChangedPaths(baseSHA, headSHA, execute = childProcess.execFileSync) {
  requireSHA(baseSHA);
  requireSHA(headSHA);
  const output = execute(
    "/usr/bin/git",
    [
      "--no-replace-objects",
      "diff",
      "--name-only",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "-z",
      baseSHA,
      headSHA,
      "--"
    ],
    {
      encoding: "utf8",
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        HOME: "/tmp",
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin"
      },
      maxBuffer: 16 * 1024 * 1024
    }
  );
  return output.split("\0").filter((changedPath) => changedPath !== "");
}

function appendOutput(outputPath, unityRequired) {
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required");
  }
  fs.appendFileSync(
    outputPath,
    `unity-required=${unityRequired ? "true" : "false"}\n`,
    "utf8"
  );
}

function run({
  eventName,
  baseSHA,
  headSHA,
  outputPath,
  execute = childProcess.execFileSync,
  log = console.log
}) {
  // A partial action failure must never leave a skip decision behind.
  appendOutput(outputPath, true);
  if (text(eventName) !== "pull_request") {
    log("Unity validation required: event is not a pull request.");
    return true;
  }
  const changedPaths = findChangedPaths(text(baseSHA), text(headSHA), execute);
  const unityRequired = classifyUnityChanges(changedPaths);
  appendOutput(outputPath, unityRequired);
  log(
    unityRequired
      ? "Unity validation required: relevant or unclassified paths changed."
      : `Unity validation skipped: ${changedPaths.length} centrally audited independent path(s) changed.`
  );
  return unityRequired;
}

/*
 * The runner uppercases an input name and replaces SPACES, never hyphens, so `event-name` arrives
 * as INPUT_EVENT-NAME. The underscored spelling is indistinguishable from an absent input, and an
 * absent event name classifies as "not a pull request" -- so every pull request this action has
 * ever seen required Unity over an unread diff. check-unity-runners.js already spells it this way,
 * and action-manifests.test.js now refuses the underscored form across every committed runtime.
 */
function input(environment, name) {
  return text(environment[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`]);
}

function main(environment = process.env) {
  try {
    run({
      eventName: input(environment, "event-name"),
      baseSHA: input(environment, "base-sha"),
      headSHA: input(environment, "head-sha"),
      outputPath: environment.GITHUB_OUTPUT || ""
    });
  } catch {
    console.error("::error title=Unity change classification failed::Classification failed closed.");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  classifyUnityChanges,
  findChangedPaths,
  input,
  isUnityIndependent,
  run
};
