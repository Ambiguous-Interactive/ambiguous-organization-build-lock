#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");

const INDEPENDENT_PREFIXES = [
  ".github/ISSUE_TEMPLATE/",
  ".llm/",
  "progress/"
];
/*
 * Exact files that cannot change what any licensed Unity job executes. Each one is an input to a
 * central analyzer, no workflow step reads it, and the attestation contract makes consumers update
 * it through reviewed pull requests. Without this entry, every ruleset change forced a licensed
 * runner cycle on every carrying consumer to publish a JSON no Unity step reads.
 */
const INDEPENDENT_PATHS = new Set([
  ".cursorrules",
  ".github/copilot-instructions.md",
  ".github/dependency-ownership.md",
  ".github/merge-policy-attestation.json"
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
    throw new TypeError("pull request or merge group revisions must be full commit SHAs");
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

/*
 * INCREMENTAL VALIDATION. The base-to-head diff answers "does this pull request touch Unity?".
 * It cannot answer "did the last push touch Unity?", so every follow-up push that changes a
 * document re-runs the licensed job over a tree the previous run already validated. A
 * push-to-main run has no diff at all: a squash merge writes a tree a pull request run may
 * already hold.
 *
 * The record of the previous validation is the repository's own run history, read through the
 * Actions API; a pull request cannot write it. The newest successful run of THIS workflow on
 * THIS branch that is not this run is the record. A successful run of a workflow that carries
 * the central aggregate proves one of two things about its head tree: the licensed job passed,
 * or the trusted classifier proved the tree needed no licensed job. Both make the tree a
 * validated baseline. A run in progress, a failed run, and a run of another workflow prove
 * nothing and are skipped.
 *
 * The comparison is the API's own base-to-head file list, so the runtime keeps its single
 * tree-only git call. Every uncertain answer -- no record, a diverged branch, a truncated file
 * list, a failed request -- keeps Unity required. The mode only ever REMOVES a run it can
 * justify; it cannot make a run appear.
 */
const MAX_COMPARED_FILES = 300;
const RECORD_RUN_LIMIT = 20;
const PUSH_RECORD_RUN_LIMIT = 20;

function failClosed(reason) {
  return new TypeError(`incremental validation unavailable: ${reason}`);
}

async function requestJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28"
    },
    // A slow lookup must not hold a hosted classifier job open for its whole timeout.
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    throw new Error(`GitHub API responded ${response.status}`);
  }
  return response.json();
}

/*
 * GITHUB_WORKFLOW_REF is `<owner>/<repository>/<path>@<ref>`, so the file name is the last
 * segment of the path and the repository prefix must be THIS repository. A value that does not
 * parse would otherwise select runs of a workflow that never validated anything.
 */
function workflowFile(reference, repository) {
  const at = reference.lastIndexOf("@");
  const segments = (at === -1 ? reference : reference.slice(0, at)).split("/");
  const name = segments.length === 5 &&
    segments[0].toLowerCase() === repository.split("/")[0].toLowerCase() &&
    segments[1].toLowerCase() === repository.split("/")[1].toLowerCase() &&
    segments[2] === ".github" &&
    segments[3] === "workflows"
    ? segments[4]
    : "";
  if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(name)) {
    throw failClosed("the workflow reference is not a workflow in this repository");
  }
  return name;
}

function validationRecord(runs, { headBranch, runID }) {
  if (!Array.isArray(runs)) {
    throw failClosed("the run history is not a list");
  }
  const record = runs.slice(0, RECORD_RUN_LIMIT).find((run) =>
    run !== null && typeof run === "object" &&
    run.head_branch === headBranch &&
    String(run.id) !== runID &&
    typeof run.head_sha === "string" && /^[0-9a-f]{40}$/i.test(run.head_sha)
  );
  if (record === undefined) {
    throw failClosed("no completed successful run of this workflow and branch");
  }
  return record.head_sha.toLowerCase();
}

async function changedPathsBetween(repository, baseSHA, headSHA, request) {
  const comparison = await request(
    `/repos/${repository}/compare/${baseSHA}...${headSHA}?per_page=${MAX_COMPARED_FILES}`
  );
  if (comparison?.status === "identical") {
    return null;
  }
  if (comparison?.status !== "ahead" || !Array.isArray(comparison.files)) {
    throw failClosed(`the branch comparison is ${text(comparison?.status) || "unknown"}`);
  }
  if (comparison.files.length >= MAX_COMPARED_FILES) {
    throw failClosed("the branch comparison is truncated");
  }
  const paths = [];
  for (const file of comparison.files) {
    for (const candidate of [file?.filename, file?.previous_filename]) {
      if (typeof candidate === "string" && candidate !== "") {
        paths.push(candidate);
      }
    }
  }
  return paths;
}

async function commitTree(repository, sha, request) {
  const commit = await request(`/repos/${repository}/git/commits/${sha}`);
  const tree = text(commit?.tree?.sha).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(tree)) {
    throw failClosed("the validated commit tree is unreadable");
  }
  return tree;
}

/*
 * A PUSH HAS NO PULL REQUEST DIFF. A squash merge writes the pull request head tree to the
 * branch, so a push whose tree is identical to a tree a successful pull request run already
 * holds repeats work that run proved unnecessary. The record is still the repository's own run
 * history: any successful pull request run of this workflow validates its head tree, because a
 * successful run either passed the licensed job or proved the tree needed none. Tree equality is
 * exact, so no base or delta reasoning is needed; a different tree, no record, or any failed
 * lookup keeps Unity required.
 */
async function pushIncrementalDecision({ repository, workflowRef, headSHA, runID, request, log }) {
  if (!/^[0-9a-f]{40}$/i.test(headSHA)) {
    throw failClosed("the pushed revision is not a full commit SHA");
  }
  const name = workflowFile(workflowRef, repository);
  const pushedTree = await commitTree(repository, headSHA, request);
  const history = await request(
    `/repos/${repository}/actions/workflows/${encodeURIComponent(name)}/runs`
    + `?event=pull_request&status=success&per_page=${PUSH_RECORD_RUN_LIMIT}`
  );
  if (!Array.isArray(history?.workflow_runs)) {
    throw failClosed("the run history is not a list");
  }
  for (const record of history.workflow_runs.slice(0, PUSH_RECORD_RUN_LIMIT)) {
    if (record === null || typeof record !== "object" || String(record.id) === runID) {
      continue;
    }
    const sha = typeof record.head_sha === "string" ? record.head_sha.toLowerCase() : "";
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      continue;
    }
    let tree;
    try {
      tree = await commitTree(repository, sha, request);
    } catch (error) {
      /*
         An unreadable record proves nothing, so it cannot justify a skip. A later record that
         does match still can, so one deleted or unreachable commit does not disable the mode.
      */
      log(`Unity validation required: the record at ${sha} could not be read.`);
      continue;
    }
    if (tree === pushedTree) {
      log(`Unity validation skipped: the validated run at ${sha} holds the pushed tree.`);
      return false;
    }
  }
  log("Unity validation required: no successful run holds the pushed tree.");
  return true;
}

async function incrementalDecision({
  repository,
  workflowRef,
  headBranch,
  runID,
  baseSHA,
  headSHA,
  declaredPrefixes,
  request,
  log
}) {
  const name = workflowFile(workflowRef, repository);
  /*
     `status=success` is the only filter this needs: a run that is queued, in progress,
     cancelled, or failed is not a record, and the API excludes each of those.
  */
  const history = await request(
    `/repos/${repository}/actions/workflows/${encodeURIComponent(name)}/runs`
    + `?branch=${encodeURIComponent(headBranch)}&event=pull_request&status=success`
    + `&per_page=${RECORD_RUN_LIMIT}`
  );
  const recordSHA = validationRecord(history?.workflow_runs, { headBranch, runID });
  /*
     The record must be at or after the CURRENT base. If the base moved past it -- a retarget,
     a rebase onto a newer main, or a force push -- the commits between the two bases are not
     part of the recorded tree and are not part of the delta either, so a Unity change they
     carry would be invisible here. A plain file comparison cannot see that, so the ancestry is
     read instead and anything but "the record is ahead of this base" keeps Unity required.
  */
  const baseRelation = await request(
    `/repos/${repository}/compare/${baseSHA}...${recordSHA}?per_page=1`
  );
  if (baseRelation?.status !== "ahead" && baseRelation?.status !== "identical") {
    throw failClosed("the validated run is not ahead of the current base");
  }
  const changedPaths = await changedPathsBetween(repository, recordSHA, headSHA, request);
  if (changedPaths === null) {
    log(`Unity validation skipped: the validated run at ${recordSHA} already holds this tree.`);
    return false;
  }
  if (!classifyUnityChanges(changedPaths, declaredPrefixes)) {
    log(
      `Unity validation skipped: ${changedPaths.length} independent path(s) changed since the`
      + ` validated run at ${recordSHA}.`
    );
    return false;
  }
  log(`Unity validation required: ${changedPaths.length} path(s) changed since ${recordSHA}.`);
  return true;
}

async function run({
  eventName,
  baseSHA,
  headSHA,
  independentPaths,
  outputPath,
  incrementalValidation = "",
  githubToken = "",
  repository = "",
  workflowRef = "",
  headBranch = "",
  runID = "",
  githubSHA = "",
  request = (path) => requestJson(`https://api.github.com${path}`, githubToken, fetch),
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
  /*
     A merge group has no pull request payload. GitHub builds a temporary queue branch and
     reports its base and head commits, so the same base/head diff answers the same question:
     which paths does this queue entry change? A push has no revision pair to diff either, so it
     reads its own tree against the run records instead. Every other event fails closed, because
     this action has no comparable revision pair to read.
  */
  const event = text(eventName);
  if (!["pull_request", "merge_group", "push"].includes(event)) {
    log("Unity validation required: event is not a pull request, merge group, or push.");
    return true;
  }
  if (event === "push") {
    /*
       The push tree is the pushed commit itself. A caller supplies no head revision on a push,
       so the runner's own GITHUB_SHA answers; a value that is not a full commit SHA fails closed
       before any lookup.
    */
    if (text(incrementalValidation) !== "true") {
      log("Unity validation required: a push has no pull request diff to classify.");
      return true;
    }
    try {
      const unityRequired = await pushIncrementalDecision({
        repository: text(repository),
        workflowRef: text(workflowRef),
        headSHA: text(headSHA) || text(githubSHA),
        runID: text(runID),
        request,
        log
      });
      if (!unityRequired) {
        appendOutput(outputPath, false);
      }
      return unityRequired;
    } catch (error) {
      log(
        "Unity validation required: "
        + (text(error?.message).replace(/\s+/g, " ") || "the push lookup failed")
        + "."
      );
      return true;
    }
  }
  const changedPaths = findChangedPaths(text(baseSHA), text(headSHA), execute);
  if (!classifyUnityChanges(changedPaths, declaredPrefixes)) {
    appendOutput(outputPath, false);
    log(
      `Unity validation skipped: ${changedPaths.length} independent path(s) changed`
      + ` (central allowlist${declaredPrefixes.length === 0 ? "" : `, plus declared ${declaredPrefixes.join(", ")}`}).`
    );
    return false;
  }
  /*
     The incremental record is a pull request only shape: it names runs of this branch, and only
     a pull request has one. A merge group keeps the whole-diff answer. A lookup that fails in
     any way leaves the `true` written above in place, so this cannot turn an unknown into a
     skip.
  */
  if (text(incrementalValidation) !== "true" || text(eventName) !== "pull_request") {
    log("Unity validation required: relevant or unclassified paths changed.");
    return true;
  }
  try {
    const unityRequired = await incrementalDecision({
      repository: text(repository),
      workflowRef: text(workflowRef),
      headBranch: text(headBranch),
      runID: text(runID),
      baseSHA: text(baseSHA),
      headSHA: text(headSHA),
      declaredPrefixes,
      request,
      log
    });
    if (!unityRequired) {
      appendOutput(outputPath, false);
    }
    return unityRequired;
  } catch (error) {
    log(
      "Unity validation required: "
      + (text(error?.message).replace(/\s+/g, " ") || "the incremental lookup failed")
      + "."
    );
    return true;
  }
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
  return run({
    eventName: input(environment, "event-name"),
    baseSHA: input(environment, "base-sha"),
    headSHA: input(environment, "head-sha"),
    independentPaths: input(environment, "independent-paths"),
    incrementalValidation: input(environment, "incremental-validation"),
    githubToken: input(environment, "github-token"),
    repository: text(environment.GITHUB_REPOSITORY),
    workflowRef: text(environment.GITHUB_WORKFLOW_REF),
    headBranch: text(environment.GITHUB_HEAD_REF),
    runID: text(environment.GITHUB_RUN_ID),
    githubSHA: text(environment.GITHUB_SHA),
    outputPath: environment.GITHUB_OUTPUT || ""
  }).catch(() => {
    console.error("::error title=Unity change classification failed::Classification failed closed.");
    process.exitCode = 1;
  });
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
  run,
  workflowFile
};
