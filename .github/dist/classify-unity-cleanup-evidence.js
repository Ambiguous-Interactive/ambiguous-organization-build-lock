#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const MAX_EVIDENCE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_EVIDENCE_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_EVIDENCE_FILES = 256;
const MAX_VISITED_ENTRIES = 4096;
const EVIDENCE_EXTENSIONS = new Set([".log", ".txt"]);
const TERMINATED_EXIT_CODES = new Set([137, 143, -1073741510, -1073740791]);
const ENTITLEMENT_LINES = new Set([
  "Successfully returned the entitlement license",
  "[Licensing::Module] Successfully returned the entitlement license"
]);
const ULF_RETURNED_PATTERN =
  /^\[Licensing::Client\] Successfully returned ULF license with serial number\s*:\s*\S+$/;
const ULF_SKIPPED_PATTERN =
  /^(?:\[Licensing::Module\] Error: )?Serial number unavailable for ULF return(?:; skipping operation)?$/;
const ACCOUNT_BLOCKED_PATTERN = /(?:^|[^0-9])20111(?:$|[^0-9])/;
const UNCLASSIFIED_20113_PATTERN = /(?:^|[^0-9])20113(?:$|[^0-9])/;
const RETURN_400006_PATTERN = /(?:^|[^0-9])400006(?:$|[^0-9])/;
const ZERO_DIGEST = "0".repeat(64);
const EVIDENCE_SUFFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WINDOWS_SYSTEM_ROOT = "C:\\Windows";

function parseBoolean(name, raw) {
  if (raw !== "true" && raw !== "false") {
    throw new Error(`${name} must be the literal true or false.`);
  }
  return raw === "true";
}

function parseInputs(inputs) {
  const returnLogPath = String(inputs["return-log-path"] || "").trim();
  if (!returnLogPath) {
    throw new Error("return-log-path is required.");
  }
  const commandCompleted = parseBoolean(
    "return-command-completed",
    String(inputs["return-command-completed"] || "").trim()
  );
  const captureAttested = parseBoolean(
    "evidence-capture-complete",
    String(inputs["evidence-capture-complete"] || "").trim()
  );
  const rawExitCode = String(inputs["return-exit-code"] || "").trim();
  let exitCode = null;
  if (commandCompleted) {
    if (!/^-?[0-9]+$/.test(rawExitCode)) {
      throw new Error("return-exit-code is required as a signed decimal integer.");
    }
    exitCode = Number(rawExitCode);
    if (!Number.isSafeInteger(exitCode)) {
      throw new Error("return-exit-code is outside the safe integer range.");
    }
  } else if (rawExitCode) {
    throw new Error("return-exit-code must be absent when return-command-completed=false.");
  }
  const supplementalPaths = String(inputs["supplemental-evidence-paths"] || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const returnLogDigest = String(inputs["return-log-digest"] || "").trim();
  if (!/^[a-f0-9]{64}$/.test(returnLogDigest)) {
    throw new Error("return-log-digest is required as a lowercase SHA-256 digest.");
  }
  return {
    returnLogPath,
    commandCompleted,
    exitCode,
    captureAttested,
    supplementalPaths,
    returnLogDigest
  };
}

function strictText(data) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let value = decoder.decode(data);
  if (value.startsWith("\uFEFF")) {
    value = value.slice(1);
  }
  if (value.includes("\0")) {
    throw new Error("Evidence contains unsupported binary data.");
  }
  return value;
}

function sameStat(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.size === after.size
    && before.birthtimeNs === after.birthtimeNs
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

function sameObjectStat(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.birthtimeNs === after.birthtimeNs;
}

function samePath(left, right, pathImpl) {
  const normalizedLeft = pathImpl.resolve(left);
  const normalizedRight = pathImpl.resolve(right);
  if (pathImpl === path.win32 || pathImpl.sep === "\\") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function resolveReturnEvidenceTarget(environment, returnLogPath, pathImpl = path) {
  const runID = String(environment.GITHUB_RUN_ID || "").trim();
  const runAttempt = String(environment.GITHUB_RUN_ATTEMPT || "").trim();
  const runnerTemp = String(environment.RUNNER_TEMP || "").trim();
  if (!/^[1-9][0-9]*$/.test(runID) || !/^[1-9][0-9]*$/.test(runAttempt)) {
    throw new Error("GitHub run identity is invalid.");
  }
  if (!pathImpl.isAbsolute(runnerTemp) || !pathImpl.isAbsolute(returnLogPath)) {
    throw new Error("Return evidence paths must be absolute.");
  }
  const resolvedRunnerTemp = pathImpl.resolve(runnerTemp);
  const resolvedReturnLog = pathImpl.resolve(returnLogPath);
  const evidenceDirectory = pathImpl.dirname(resolvedReturnLog);
  const directoryName = pathImpl.basename(evidenceDirectory);
  const expectedPrefix = `unity-return-${runID}-${runAttempt}-`;
  const suffix = directoryName.startsWith(expectedPrefix)
    ? directoryName.slice(expectedPrefix.length)
    : "";
  if (
    pathImpl.basename(resolvedReturnLog) !== "return-license.log"
    || !EVIDENCE_SUFFIX_PATTERN.test(suffix)
    || !samePath(pathImpl.dirname(evidenceDirectory), resolvedRunnerTemp, pathImpl)
    || !samePath(
      resolvedReturnLog,
      pathImpl.join(resolvedRunnerTemp, directoryName, "return-license.log"),
      pathImpl
    )
  ) {
    throw new Error("Return evidence path is not the exact run-scoped central return path.");
  }
  return {
    evidenceDirectory,
    returnLogPath: resolvedReturnLog,
    runAttempt,
    runID,
    runnerTemp: resolvedRunnerTemp
  };
}

function inspectReturnEvidenceTarget(target, io = fs, pathImpl = path) {
  const absolute = pathImpl.resolve(target.returnLogPath);
  const parsed = pathImpl.parse(absolute);
  let current = parsed.root;
  let runnerTempStat;
  let evidenceDirectoryStat;
  let returnLogStat;
  for (const component of absolute.slice(parsed.root.length).split(pathImpl.sep).filter(Boolean)) {
    current = pathImpl.join(current, component);
    const stat = io.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw new Error("Return evidence path contains a symbolic link or reparse point.");
    }
    if (samePath(current, target.returnLogPath, pathImpl)) {
      if (!stat.isFile() || Number(stat.nlink) !== 1) {
        throw new Error("Return evidence is not a singly linked regular file.");
      }
      returnLogStat = stat;
    } else if (!stat.isDirectory()) {
      throw new Error("Return evidence ancestry is not a directory.");
    }
    if (samePath(current, target.runnerTemp, pathImpl)) {
      runnerTempStat = stat;
    }
    if (samePath(current, target.evidenceDirectory, pathImpl)) {
      evidenceDirectoryStat = stat;
    }
  }
  if (!runnerTempStat || !evidenceDirectoryStat || !returnLogStat) {
    throw new Error("Return evidence path identity could not be established.");
  }
  return { evidenceDirectoryStat, returnLogStat, runnerTempStat };
}

function assertSameTargetIdentity(expected, observed) {
  for (const name of ["runnerTempStat", "evidenceDirectoryStat", "returnLogStat"]) {
    if (!sameStat(expected[name], observed[name])) {
      throw new Error("Return evidence identity changed before deletion.");
    }
  }
}

function assertClaimedTargetIdentity(expected, observed) {
  if (
    !sameObjectStat(expected.runnerTempStat, observed.runnerTempStat)
    || !sameObjectStat(expected.evidenceDirectoryStat, observed.evidenceDirectoryStat)
    || !sameStat(expected.returnLogStat, observed.returnLogStat)
  ) {
    throw new Error("Return evidence identity changed during deletion.");
  }
}

function assertPathAbsent(candidate, io = fs) {
  try {
    io.lstatSync(candidate, { bigint: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error("Consumed return evidence remains after deletion.");
}

function claimConsumedReturnEvidence(
  target,
  expectedIdentity,
  io = fs,
  pathImpl = path,
  randomBytes = crypto.randomBytes
) {
  assertSameTargetIdentity(
    expectedIdentity,
    inspectReturnEvidenceTarget(target, io, pathImpl)
  );
  const nonce = randomBytes(16).toString("hex");
  if (!/^[a-f0-9]{32}$/.test(nonce)) {
    throw new Error("Return evidence claim identity is invalid.");
  }
  const consumingDirectory = `${target.evidenceDirectory}.consuming-${nonce}`;
  const claimedTarget = {
    ...target,
    evidenceDirectory: consumingDirectory,
    returnLogPath: pathImpl.join(consumingDirectory, "return-license.log")
  };
  assertPathAbsent(consumingDirectory, io);
  io.renameSync(target.evidenceDirectory, consumingDirectory);
  assertPathAbsent(target.evidenceDirectory, io);
  const claimedIdentity = inspectReturnEvidenceTarget(claimedTarget, io, pathImpl);
  assertClaimedTargetIdentity(
    expectedIdentity,
    claimedIdentity
  );
  return { claimedIdentity, claimedTarget };
}

function statEnvironment(prefix, stat) {
  return {
    [`${prefix}_DEV`]: stat.dev.toString(),
    [`${prefix}_INO`]: stat.ino.toString(),
    [`${prefix}_SIZE`]: stat.size.toString(),
    [`${prefix}_NLINK`]: stat.nlink.toString(),
    [`${prefix}_BIRTHTIME_NS`]: stat.birthtimeNs.toString(),
    [`${prefix}_MTIME_NS`]: stat.mtimeNs.toString(),
    [`${prefix}_CTIME_NS`]: stat.ctimeNs.toString()
  };
}

function identityBoundDeleteWindows(
  claimedTarget,
  claimedIdentity,
  expectedDigest,
  {
    platform = process.platform,
    spawnSync = childProcess.spawnSync,
    systemRoot = WINDOWS_SYSTEM_ROOT
  } = {}
) {
  if (platform !== "win32") {
    throw new Error("Identity-bound return evidence deletion requires Windows.");
  }
  const powershell = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const script = path.join(__dirname, "delete-unity-return-evidence.ps1");
  const result = spawnSync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script
    ],
    {
      env: {
        SystemRoot: systemRoot,
        UNITY_DELETE_DIRECTORY_PATH: claimedTarget.evidenceDirectory,
        UNITY_DELETE_EXPECTED_DIGEST: expectedDigest,
        UNITY_DELETE_FILE_PATH: claimedTarget.returnLogPath,
        ...statEnvironment(
          "UNITY_DELETE_DIRECTORY",
          claimedIdentity.evidenceDirectoryStat
        ),
        ...statEnvironment("UNITY_DELETE_FILE", claimedIdentity.returnLogStat)
      },
      stdio: "ignore",
      timeout: 120000,
      windowsHide: true
    }
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("Identity-bound return evidence deletion failed.");
  }
}

function deleteClaimedReturnEvidence(
  claimedTarget,
  claimedIdentity,
  originalTarget,
  io = fs,
  pathImpl = path,
  deleteByIdentity = identityBoundDeleteWindows,
  expectedDigest
) {
  assertClaimedTargetIdentity(
    claimedIdentity,
    inspectReturnEvidenceTarget(claimedTarget, io, pathImpl)
  );
  const entries = io.readdirSync(claimedTarget.evidenceDirectory, { withFileTypes: true });
  if (
    entries.length !== 1
    || entries[0].name !== "return-license.log"
    || entries[0].isSymbolicLink()
    || !entries[0].isFile()
  ) {
    throw new Error("Return evidence directory contains an unexpected entry.");
  }
  deleteByIdentity(claimedTarget, claimedIdentity, expectedDigest);
  assertPathAbsent(claimedTarget.returnLogPath, io);
  assertPathAbsent(claimedTarget.evidenceDirectory, io);
  assertPathAbsent(originalTarget.evidenceDirectory, io);
  const runnerTempAfterDeletion = io.lstatSync(originalTarget.runnerTemp, { bigint: true });
  if (!sameObjectStat(claimedIdentity.runnerTempStat, runnerTempAfterDeletion)) {
    throw new Error("Runner temporary directory identity changed during deletion.");
  }
}

function boundedRead(filePath, expectedStat, maximumBytes, io = fs) {
  const expectedSize = Number(expectedStat.size);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maximumBytes) {
    throw new Error("Evidence exceeds its read bound.");
  }
  let descriptor;
  try {
    descriptor = io.openSync(filePath, "r");
    const openedStat = io.fstatSync(descriptor, { bigint: true });
    if (!sameStat(expectedStat, openedStat) || !openedStat.isFile()) {
      throw new Error("Evidence changed before it was read.");
    }
    const storage = Buffer.alloc(expectedSize);
    let bytesRead = 0;
    while (bytesRead < expectedSize) {
      const count = io.readSync(
        descriptor,
        storage,
        bytesRead,
        expectedSize - bytesRead,
        bytesRead
      );
      if (count === 0) {
        break;
      }
      bytesRead += count;
    }
    const finalDescriptorStat = io.fstatSync(descriptor, { bigint: true });
    const finalPathStat = io.lstatSync(filePath, { bigint: true });
    if (
      bytesRead !== expectedSize
      || !sameStat(expectedStat, finalDescriptorStat)
      || !sameStat(expectedStat, finalPathStat)
      || finalPathStat.isSymbolicLink()
      || !finalPathStat.isFile()
    ) {
      throw new Error("Evidence changed while it was being read.");
    }
    strictText(storage);
    return storage;
  } finally {
    if (descriptor !== undefined) {
      io.closeSync(descriptor);
    }
  }
}

function collectEvidence({
  returnLogPath,
  supplementalPaths,
  captureAttested,
  maxFileBytes = MAX_EVIDENCE_FILE_BYTES,
  maxTotalBytes = MAX_EVIDENCE_TOTAL_BYTES,
  maxFiles = MAX_EVIDENCE_FILES,
  expectedReturnStat,
  io = fs
}) {
  let captureComplete = captureAttested === true;
  let totalBytes = 0;
  let fileCount = 0;
  let discoveredEntries = 0;
  let directoryReadOperations = 0;
  let maximumBufferedEntries = 0;
  let maximumTraversalDepth = 0;
  let returnLog = Buffer.alloc(0);
  let returnLogReadComplete = false;
  const supplemental = [];
  const digest = crypto.createHash("sha256");
  const observedFileIdentities = new Set();

  function recordFile(candidate, kind, observedStat) {
    let stat = observedStat;
    if (!stat) {
      try {
        stat = io.lstatSync(candidate, { bigint: true });
      } catch {
        captureComplete = false;
        return;
      }
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      captureComplete = false;
      return;
    }
    if (kind === "return" && expectedReturnStat && !sameStat(expectedReturnStat, stat)) {
      captureComplete = false;
      return;
    }
    if (!EVIDENCE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) {
      if (kind === "return") {
        captureComplete = false;
      }
      return;
    }
    const identity = `${stat.dev}:${stat.ino}`;
    if (observedFileIdentities.has(identity)) {
      return;
    }
    const size = Number(stat.size);
    if (
      !Number.isSafeInteger(size)
      || size > maxFileBytes
      || fileCount >= maxFiles
      || totalBytes + size > maxTotalBytes
    ) {
      captureComplete = false;
      return;
    }
    try {
      const data = boundedRead(
        candidate,
        stat,
        Math.min(maxFileBytes, maxTotalBytes - totalBytes),
        io
      );
      const label = kind === "return"
        ? "return"
        : `supplemental-${String(supplemental.length).padStart(3, "0")}`;
      digest.update(label);
      digest.update("\0");
      digest.update(data);
      digest.update("\0");
      totalBytes += data.length;
      fileCount += 1;
      observedFileIdentities.add(identity);
      if (kind === "return") {
        returnLog = data;
        returnLogReadComplete = true;
      } else {
        supplemental.push(data);
      }
    } catch {
      captureComplete = false;
    }
  }

  const pending = [];

  function queueCandidate(candidate, depth) {
    if (discoveredEntries >= MAX_VISITED_ENTRIES) {
      captureComplete = false;
      return false;
    }
    discoveredEntries += 1;
    maximumTraversalDepth = Math.max(maximumTraversalDepth, depth);
    pending.push({ candidate, depth });
    maximumBufferedEntries = Math.max(maximumBufferedEntries, pending.length);
    return true;
  }

  function inspectCandidate(candidate, depth) {
    let stat;
    try {
      stat = io.lstatSync(candidate, { bigint: true });
    } catch {
      captureComplete = false;
      return;
    }
    if (stat.isSymbolicLink()) {
      captureComplete = false;
      return;
    }
    if (stat.isFile()) {
      recordFile(candidate, "supplemental", stat);
      return;
    }
    if (!stat.isDirectory()) {
      captureComplete = false;
      return;
    }
    if (discoveredEntries >= MAX_VISITED_ENTRIES) {
      captureComplete = false;
      return;
    }
    const children = [];
    let directory;
    try {
      directory = io.opendirSync(candidate);
      while (
        discoveredEntries < MAX_VISITED_ENTRIES
        && directoryReadOperations < MAX_VISITED_ENTRIES
      ) {
        directoryReadOperations += 1;
        const entry = directory.readSync();
        if (entry === null) {
          break;
        }
        discoveredEntries += 1;
        maximumTraversalDepth = Math.max(maximumTraversalDepth, depth + 1);
        children.push({ candidate: path.join(candidate, entry.name), depth: depth + 1 });
        maximumBufferedEntries = Math.max(
          maximumBufferedEntries,
          pending.length + children.length
        );
      }
      if (
        discoveredEntries >= MAX_VISITED_ENTRIES
        || directoryReadOperations >= MAX_VISITED_ENTRIES
      ) {
        captureComplete = false;
      }
    } catch {
      captureComplete = false;
      return;
    } finally {
      if (directory) {
        try {
          directory.closeSync();
        } catch {
          captureComplete = false;
        }
      }
    }
    children.sort((left, right) => {
      if (left.candidate < right.candidate) {
        return -1;
      }
      return left.candidate > right.candidate ? 1 : 0;
    });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]);
    }
    maximumBufferedEntries = Math.max(maximumBufferedEntries, pending.length);
  }

  recordFile(returnLogPath, "return");
  const boundedPathCount = Math.min(supplementalPaths.length, MAX_VISITED_ENTRIES);
  if (supplementalPaths.length > boundedPathCount) {
    captureComplete = false;
  }
  for (let index = boundedPathCount - 1; index >= 0; index -= 1) {
    queueCandidate(supplementalPaths[index], 0);
  }
  while (pending.length > 0) {
    const { candidate, depth } = pending.pop();
    inspectCandidate(candidate, depth);
  }
  return {
    returnLog,
    returnLogReadComplete,
    supplemental,
    captureComplete,
    digest: digest.digest("hex"),
    discoveredEntries,
    directoryReadOperations,
    maximumBufferedEntries,
    maximumTraversalDepth
  };
}

function evidenceText(value) {
  return strictText(Buffer.isBuffer(value) ? value : Buffer.from(value));
}

function classifyEvidence({
  exitCode,
  returnLog,
  supplemental,
  commandCompleted,
  captureComplete
}) {
  const returnText = evidenceText(returnLog);
  const supplementalText = supplemental.map(evidenceText);
  const combined = [returnText, ...supplementalText].join("\n");
  if (ACCOUNT_BLOCKED_PATTERN.test(combined)) {
    return {
      resourceSafe: false,
      cleanupStatus: "unknown",
      health: "blocked",
      reason: "unity-account-limit-20111"
    };
  }
  if (!captureComplete) {
    return {
      resourceSafe: false,
      cleanupStatus: "unknown",
      health: "healthy",
      reason: "return-log-truncated"
    };
  }
  if (RETURN_400006_PATTERN.test(combined)) {
    return {
      resourceSafe: false,
      cleanupStatus: "unknown",
      health: "healthy",
      reason: "unity-return-400006"
    };
  }
  if (commandCompleted && TERMINATED_EXIT_CODES.has(exitCode)) {
    return {
      resourceSafe: false,
      cleanupStatus: "unknown",
      health: "healthy",
      reason: "return-terminated"
    };
  }
  if (commandCompleted && exitCode === 124) {
    return {
      resourceSafe: false,
      cleanupStatus: "unknown",
      health: "healthy",
      reason: "return-timeout"
    };
  }
  if (UNCLASSIFIED_20113_PATTERN.test(combined)) {
    return {
      resourceSafe: false,
      cleanupStatus: "unknown",
      health: "healthy",
      reason: "unity-20113-unclassified"
    };
  }

  const lines = returnText
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.trim());
  if (lines.some((line) => ULF_SKIPPED_PATTERN.test(line))) {
    return {
      resourceSafe: false,
      cleanupStatus: "unknown",
      health: "healthy",
      reason: "return-ulf-skipped"
    };
  }
  const entitlementReturned = lines.some((line) => ENTITLEMENT_LINES.has(line));
  const ulfReturned = lines.some((line) => ULF_RETURNED_PATTERN.test(line));
  if (commandCompleted && entitlementReturned && ulfReturned) {
    return {
      resourceSafe: true,
      cleanupStatus: "confirmed",
      health: "healthy",
      reason: "cleanup-confirmed"
    };
  }
  return {
    resourceSafe: false,
    cleanupStatus: "unknown",
    health: "healthy",
    reason: "return-missing-positive-evidence"
  };
}

function appendOutputs(outputPath, values) {
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required.");
  }
  const lines = [
    `resource-safe=${values.resourceSafe ? "true" : "false"}`,
    `resource-cleanup-status=${values.cleanupStatus}`,
    `resource-health=${values.health}`,
    `resource-reason=${values.reason}`,
    `classification-complete=${values.classificationComplete ? "true" : "false"}`,
    `evidence-digest=${values.evidenceDigest}`
  ];
  fs.appendFileSync(outputPath, `${lines.join("\n")}\n`, { encoding: "utf8" });
}

function run({
  inputs,
  outputPath,
  environment = process.env,
  io = fs,
  pathImpl = path,
  randomBytes = crypto.randomBytes,
  deleteByIdentity = identityBoundDeleteWindows,
  log = console.log
}) {
  const defaults = {
    resourceSafe: false,
    cleanupStatus: "unknown",
    health: "healthy",
    reason: "return-log-truncated",
    classificationComplete: false,
    evidenceDigest: ZERO_DIGEST
  };
  appendOutputs(outputPath, defaults);
  const parsed = parseInputs(inputs);
  const target = resolveReturnEvidenceTarget(environment, parsed.returnLogPath, pathImpl);
  const targetIdentity = inspectReturnEvidenceTarget(target, io, pathImpl);
  const { claimedIdentity, claimedTarget } = claimConsumedReturnEvidence(
    target,
    targetIdentity,
    io,
    pathImpl,
    randomBytes
  );
  const evidence = collectEvidence({
    ...parsed,
    returnLogPath: claimedTarget.returnLogPath,
    expectedReturnStat: claimedIdentity.returnLogStat,
    io
  });
  if (!evidence.returnLogReadComplete) {
    throw new Error("Central return evidence could not be read and validated.");
  }
  if (
    crypto.createHash("sha256").update(evidence.returnLog).digest("hex") !== parsed.returnLogDigest
  ) {
    throw new Error("Return log digest does not match the central return output.");
  }
  const result = classifyEvidence({
    exitCode: parsed.exitCode,
    returnLog: evidence.returnLog,
    supplemental: evidence.supplemental,
    commandCompleted: parsed.commandCompleted,
    captureComplete: evidence.captureComplete
  });
  deleteClaimedReturnEvidence(
    claimedTarget,
    claimedIdentity,
    target,
    io,
    pathImpl,
    deleteByIdentity,
    parsed.returnLogDigest
  );
  const completed = {
    ...result,
    classificationComplete: true,
    evidenceDigest: evidence.digest
  };
  appendOutputs(outputPath, completed);
  log(`Unity cleanup evidence classified: reason=${result.reason} evidence-digest=${evidence.digest}`);
  return completed;
}

function environmentInputs(environment = process.env) {
  const names = [
    "return-log-path",
    "return-command-completed",
    "return-exit-code",
    "evidence-capture-complete",
    "return-log-digest",
    "supplemental-evidence-paths"
  ];
  return Object.fromEntries(names.map((name) => [
    name,
    environment[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] || ""
  ]));
}

function main() {
  try {
    run({
      inputs: environmentInputs(),
      outputPath: process.env.GITHUB_OUTPUT || ""
    });
  } catch {
    console.error("::error title=Unity cleanup evidence unavailable::Classification failed closed.");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  MAX_EVIDENCE_FILE_BYTES,
  MAX_EVIDENCE_FILES,
  MAX_EVIDENCE_TOTAL_BYTES,
  MAX_VISITED_ENTRIES,
  claimConsumedReturnEvidence,
  classifyEvidence,
  collectEvidence,
  deleteClaimedReturnEvidence,
  environmentInputs,
  identityBoundDeleteWindows,
  inspectReturnEvidenceTarget,
  parseInputs,
  resolveReturnEvidenceTarget,
  run
};
