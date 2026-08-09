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

/*
 * Prefixes no caller may declare independent, whatever it believes about them.
 *
 * The first three are what Unity compiles. The fourth is the workflow directory: a caller that
 * declared it independent would skip Unity on the pull request that edits the workflow GATING
 * Unity, which is the one change that must always fail open. Both classes are refused BY NAME
 * rather than left to a reviewer, because a declaration is only dangerous in these two ways and a
 * rule a reviewer has to remember is a rule that eventually is not applied.
 */
const NEVER_INDEPENDENT_PREFIXES = [
  "Assets/",
  "Packages/",
  "ProjectSettings/",
  ".github/workflows/"
];

/*
 * Inertness beyond documentation is CALLER-RELATIVE and cannot live in one shared list:
 * `Benchmarks/**` is inert to one consumer's Unity build and would not be to another. So a caller
 * may widen its own allowlist, under a grammar chosen to be auditable rather than expressive.
 *
 * ONLY `<dir>/**` IS ACCEPTED. This is a security gate's trusted input, editable by whoever can
 * edit the calling workflow, so the reviewable question has to be "is this directory really inert
 * to that repository's Unity build" and never "what does this pattern match". A general glob needs
 * a matcher a reviewer must reason about; a directory prefix does not. Everything else -- a bare
 * name, a single-level `*`, a leading `**`, an absolute or escaping path -- THROWS, and the caller
 * fails closed to requiring Unity.
 *
 * The three prefixes Unity compiles are refused BY NAME rather than left to review, because
 * declaring one is the only way this input could turn a real Unity change into a skip.
 */
function parseDeclaredIndependentPaths(declaration) {
  const lines = text(declaration).split("\n").map((line) => line.trim()).filter(Boolean);
  const prefixes = [];
  for (const line of lines) {
    if (!/^(?:[A-Za-z0-9._-]+\/)+\*\*$/.test(line)) {
      throw new TypeError(
        `declared independent path must be a directory prefix of the form "dir/**": ${line}`
      );
    }
    const prefix = line.slice(0, -2);
    if (prefix.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new TypeError(`declared independent path must not traverse: ${line}`);
    }
    const reserved = NEVER_INDEPENDENT_PREFIXES.find(
      (never) => prefix.startsWith(never) || never.startsWith(prefix)
    );
    if (reserved !== undefined) {
      throw new TypeError(
        `declared independent path overlaps a reserved prefix (${reserved}): ${line}`
      );
    }
    if (!prefixes.includes(prefix)) {
      prefixes.push(prefix);
    }
  }

  return prefixes;
}

function isUnityIndependent(changedPath, declaredPrefixes = []) {
  if (typeof changedPath !== "string" || changedPath === "") {
    return false;
  }
  if (!changedPath.includes("/") && changedPath.endsWith(".md")) {
    return true;
  }
  if (INDEPENDENT_PATHS.has(changedPath)) {
    return true;
  }
  if (INDEPENDENT_PREFIXES.some((prefix) => changedPath.startsWith(prefix))) {
    return true;
  }
  /*
     A declaration only ever UNIONS with the central floor above, so it can widen what a caller
     skips on and can never narrow what every caller already skips on.
  */
  return declaredPrefixes.some((prefix) => changedPath.startsWith(prefix));
}

function classifyUnityChanges(changedPaths, declaredPrefixes = []) {
  if (!Array.isArray(changedPaths) ||
      changedPaths.some((changedPath) => typeof changedPath !== "string" || changedPath === "")) {
    throw new TypeError("changed paths must be a list of non-empty strings");
  }
  return changedPaths.length === 0 ||
    changedPaths.some((changedPath) => !isUnityIndependent(changedPath, declaredPrefixes));
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
  independentPaths,
  outputPath,
  execute = childProcess.execFileSync,
  log = console.log
}) {
  // A partial action failure must never leave a skip decision behind.
  appendOutput(outputPath, true);
  /*
     Parsed BEFORE the event check, so a malformed declaration is reported on every event rather
     than lying dormant until the first pull request -- a workflow that cannot express what it
     means should fail on the push that introduced it.
  */
  const declaredPrefixes = parseDeclaredIndependentPaths(independentPaths);
  if (text(eventName) !== "pull_request") {
    log("Unity validation required: event is not a pull request.");
    return true;
  }
  const changedPaths = findChangedPaths(text(baseSHA), text(headSHA), execute);
  const unityRequired = classifyUnityChanges(changedPaths, declaredPrefixes);
  appendOutput(outputPath, unityRequired);
  log(
    unityRequired
      ? "Unity validation required: relevant or unclassified paths changed."
      : `Unity validation skipped: ${changedPaths.length} independent path(s) changed`
        + ` (central allowlist${declaredPrefixes.length === 0 ? "" : `, plus declared ${declaredPrefixes.join(", ")}`}).`
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
      independentPaths: input(environment, "independent-paths"),
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
  parseDeclaredIndependentPaths,
  run
};
