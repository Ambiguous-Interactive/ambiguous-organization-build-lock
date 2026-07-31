#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");

const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_VERIFY_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 30_000;
const WINDOWS_SYSTEM_ROOT = "C:\\Windows";
const EDITOR_LAYOUTS = new Set(["canonical", "ci-managed-alternate"]);
const UNITY_SIGNER_THUMBPRINTS = new Set([
  "228FB6411B0A144478C86AAA3CD9473C43A8ABA7",
  "BFFD800651947878FCD0DC749C16D57B0D5E397D"
]);

function input(env, name) {
  return String(env[`INPUT_${name.toUpperCase()}`] || "").trim();
}

function writeOutput(env, name, value, appendFile = fs.appendFileSync) {
  if (!env.GITHUB_OUTPUT) {
    throw new Error("GITHUB_OUTPUT is required.");
  }
  appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
}

function workflowCommandData(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

function requiredInputs(env) {
  const unityVersion = input(env, "UNITY-VERSION");
  const toolCache = input(env, "TOOL-CACHE");
  const email = input(env, "UNITY-EMAIL");
  const password = input(env, "UNITY-PASSWORD");
  const evidenceSuffix = input(env, "EVIDENCE-SUFFIX") || "default";
  const editorLayout = input(env, "EDITOR-LAYOUT") || "canonical";

  if (!/^[0-9]{4}\.[0-9]+\.[0-9]+[abfp][0-9]+$/i.test(unityVersion)) {
    throw new Error("unity-version is invalid.");
  }
  if (!path.isAbsolute(toolCache)) {
    throw new Error("tool-cache must be an absolute path.");
  }
  if (!email || !password) {
    throw new Error("Unity credentials are required.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(evidenceSuffix)) {
    throw new Error("evidence-suffix is invalid.");
  }
  if (!EDITOR_LAYOUTS.has(editorLayout)) {
    throw new Error("editor-layout is invalid.");
  }
  return { unityVersion, toolCache, email, password, evidenceSuffix, editorLayout };
}

function runIdentity(env) {
  const runID = String(env.GITHUB_RUN_ID || "").trim();
  const runAttempt = String(env.GITHUB_RUN_ATTEMPT || "").trim();
  const runnerTemp = String(env.RUNNER_TEMP || "").trim();
  if (!/^[1-9][0-9]*$/.test(runID) || !/^[1-9][0-9]*$/.test(runAttempt)) {
    throw new Error("GitHub run identity is invalid.");
  }
  if (!path.isAbsolute(runnerTemp)) {
    throw new Error("RUNNER_TEMP must be an absolute path.");
  }
  return { runID, runAttempt, runnerTemp };
}

function editorPath(toolCache, unityVersion, editorLayout = "canonical") {
  if (!EDITOR_LAYOUTS.has(editorLayout)) {
    throw new Error("editor-layout is invalid.");
  }
  const layoutComponents = editorLayout === "ci-managed-alternate"
    ? ["u6-v3", "_ci-managed-editors"]
    : ["u6-v3"];
  return path.join(
    toolCache,
    ...layoutComponents,
    unityVersion,
    "Editor",
    "Unity.exe"
  );
}

function assertNoReparsePath(target, io = fs, pathImpl = path) {
  const absolute = pathImpl.resolve(target);
  const parsed = pathImpl.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(pathImpl.sep).filter(Boolean)) {
    current = pathImpl.join(current, component);
    const stat = io.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error("The CI-managed Unity editor path contains a reparse point.");
    }
  }
}

function systemPowerShell() {
  return path.win32.join(
    WINDOWS_SYSTEM_ROOT,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
}

async function verifyUnityEditor(executable, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") {
    throw new Error("The central Unity return action requires Windows Authenticode.");
  }
  const spawnImpl = options.spawnImpl || spawn;
  const environment = options.environment || {};
  const timeoutMs = options.timeoutMs === undefined
    ? DEFAULT_VERIFY_TIMEOUT_MS
    : options.timeoutMs;
  const powershell = systemPowerShell();
  const verifierEnvironment = {
    ...environment,
    CENTRAL_UNITY_EDITOR_PATH: executable,
    SystemDrive: "C:",
    SystemRoot: WINDOWS_SYSTEM_ROOT,
    windir: WINDOWS_SYSTEM_ROOT
  };
  const allowedThumbprints = [...UNITY_SIGNER_THUMBPRINTS].join(",");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$allowed = '${allowedThumbprints}'.Split(',')`,
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:CENTRAL_UNITY_EDITOR_PATH -ErrorAction Stop",
    "if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) { exit 41 }",
    "$certificate = $signature.SignerCertificate",
    "if ($null -eq $certificate -or $allowed -notcontains $certificate.Thumbprint.ToUpperInvariant()) { exit 42 }",
    "$codeSigning = $false",
    "foreach ($extension in $certificate.Extensions) {",
    "  if ($extension -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]) {",
    "    foreach ($usage in $extension.EnhancedKeyUsages) { if ($usage.Value -eq '1.3.6.1.5.5.7.3.3') { $codeSigning = $true } }",
    "  }",
    "}",
    "if (-not $codeSigning) { exit 43 }",
    "exit 0"
  ].join("; ");

  await new Promise((resolve, reject) => {
    let settled = false;
    const verifier = spawnImpl(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        cwd: path.win32.join(WINDOWS_SYSTEM_ROOT, "System32"),
        env: verifierEnvironment,
        shell: false,
        windowsHide: true,
        stdio: "ignore"
      }
    );
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      terminateProcess(verifier, platform, spawnImpl, verifierEnvironment);
      reject(new Error("Unity editor signature verification timed out."));
    }, timeoutMs);
    timeout.unref?.();
    verifier.once("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error("Unity editor signature verification could not start."));
      }
    });
    verifier.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error("Unity editor signature verification failed."));
      }
    });
  });
}

function removeEvidenceDirectory(directory, io = fs) {
  let stat;
  try {
    stat = io.lstatSync(directory);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    io.unlinkSync(directory);
    return;
  }
  io.rmSync(directory, { recursive: true, force: false });
}

function terminateProcess(child, platform, spawnImpl, environment) {
  if (!child || child.exitCode !== null) {
    return;
  }
  if (platform === "win32" && Number.isInteger(child.pid) && child.pid > 0) {
    const terminator = spawnImpl(
      path.win32.join(WINDOWS_SYSTEM_ROOT, "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      { env: environment, windowsHide: true, stdio: "ignore" }
    );
    const fallback = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The caller will fail closed if the process does not exit.
      }
    };
    const fallbackTimer = setTimeout(fallback, 5_000);
    fallbackTimer.unref?.();
    terminator.once("error", () => {
      clearTimeout(fallbackTimer);
      fallback();
    });
    terminator.once("close", (code) => {
      clearTimeout(fallbackTimer);
      if (code !== 0) {
        fallback();
      }
    });
    terminator.unref?.();
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The caller will fail closed if the process does not exit.
  }
}

function editorEnvironment(env, runnerTemp) {
  const allowed = [
    "ALLUSERSPROFILE",
    "APPDATA",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "SystemDrive",
    "SystemRoot",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "windir"
  ];
  const result = {};
  for (const name of allowed) {
    if (typeof env[name] === "string" && env[name] !== "") {
      result[name] = env[name];
    }
  }
  result.SystemDrive = "C:";
  result.SystemRoot = WINDOWS_SYSTEM_ROOT;
  result.windir = WINDOWS_SYSTEM_ROOT;
  result.TEMP = runnerTemp;
  result.TMP = runnerTemp;
  return result;
}

function redactedEvidence(chunks, credentials) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = decoder.decode(Buffer.concat(chunks));
  const orderedCredentials = [...new Set(credentials.filter((value) => value !== ""))]
    .sort((left, right) => right.length - left.length);
  for (const credential of orderedCredentials) {
    text = text.split(credential).join("[REDACTED]");
  }
  // Unity can echo the activation serial while returning a license even though
  // this action never receives UNITY_SERIAL as an input. Redact the stable
  // serial shape before the bounded evidence is persisted.
  text = text.replace(/\bSC-[A-Za-z0-9-]{8,}\b/gi, "[REDACTED]");
  const result = Buffer.from(text, "utf8");
  if (result.length > MAX_EVIDENCE_BYTES) {
    throw new Error("Redacted Unity return evidence exceeds its bound.");
  }
  return result;
}

async function executeReturn(options) {
  const env = options.env || process.env;
  const io = options.io || fs;
  const spawnImpl = options.spawnImpl || spawn;
  const platform = options.platform || process.platform;
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  const terminationGraceMs = options.terminationGraceMs === undefined
    ? TERMINATION_GRACE_MS
    : options.terminationGraceMs;
  const values = requiredInputs(env);
  const identity = runIdentity(env);
  const executable = editorPath(
    values.toolCache,
    values.unityVersion,
    values.editorLayout
  );
  const evidenceDirectory = path.join(
    identity.runnerTemp,
    `unity-return-${identity.runID}-${identity.runAttempt}-${values.evidenceSuffix}`
  );
  const returnLogPath = path.join(evidenceDirectory, "return-license.log");

  writeOutput(env, "return-log-path", returnLogPath, options.appendFile);
  writeOutput(env, "return-command-completed", "false", options.appendFile);
  writeOutput(env, "evidence-capture-complete", "false", options.appendFile);

  const executableStat = io.lstatSync(executable);
  if (executableStat.isSymbolicLink() || !executableStat.isFile()) {
    throw new Error("The CI-managed Unity editor is not a regular file.");
  }
  assertNoReparsePath(executable, io);
  const childEnvironment = editorEnvironment(env, identity.runnerTemp);
  const verifyEditor = options.verifyEditor || verifyUnityEditor;
  await verifyEditor(executable, {
    environment: childEnvironment,
    execPath: options.execPath,
    platform,
    spawnImpl
  });
  removeEvidenceDirectory(evidenceDirectory, io);
  io.mkdirSync(evidenceDirectory, { recursive: false });

  const argumentsList = [
    "-quit",
    "-batchmode",
    "-nographics",
    "-disableManagedDebugger",
    "-returnlicense",
    "-username",
    values.email,
    "-password",
    values.password,
    "-logFile",
    "-"
  ];
  const chunks = [];
  let evidenceBytes = 0;
  let evidenceOverflow = false;
  let timedOut = false;
  let child;

  const result = await new Promise((resolve, reject) => {
    let settled = false;
    let terminationStarted = false;
    let terminationGrace;
    let timeout;
    const settle = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(terminationGrace);
      resolve(value);
    };
    const requestTermination = () => {
      if (terminationStarted) {
        return;
      }
      terminationStarted = true;
      terminateProcess(child, platform, spawnImpl, childEnvironment);
      terminationGrace = setTimeout(
        () => settle({ code: null, signal: "termination-grace-expired" }),
        terminationGraceMs
      );
      terminationGrace.unref?.();
    };
    child = spawnImpl(executable, argumentsList, {
      cwd: identity.runnerTemp,
      env: childEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const record = (chunk) => {
      const data = Buffer.from(chunk);
      if (evidenceBytes + data.length > MAX_EVIDENCE_BYTES) {
        evidenceOverflow = true;
        requestTermination();
        return;
      }
      evidenceBytes += data.length;
      chunks.push(data);
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        clearTimeout(terminationGrace);
        reject(error);
      }
    });
    child.once("close", (code, signal) => settle({ code, signal }));

    timeout = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, timeoutMs);
    timeout.unref?.();
  });

  const completed = result.signal !== "termination-grace-expired" &&
    (child.exitCode !== null || result.code !== null || result.signal !== null);
  const exitCode = timedOut ? 124 : result.code;
  let evidence;
  let returnLogDigest = "";
  let captureComplete = completed && !evidenceOverflow;
  if (captureComplete) {
    try {
      evidence = redactedEvidence(chunks, [values.email, values.password]);
      returnLogDigest = crypto.createHash("sha256").update(evidence).digest("hex");
      io.writeFileSync(returnLogPath, evidence, { flag: "wx" });
    } catch {
      captureComplete = false;
    }
  }
  if (completed) {
    writeOutput(env, "return-command-completed", "true", options.appendFile);
    writeOutput(env, "return-exit-code", String(exitCode ?? 1), options.appendFile);
  }
  if (captureComplete) {
    writeOutput(env, "return-log-digest", returnLogDigest, options.appendFile);
    writeOutput(env, "evidence-capture-complete", "true", options.appendFile);
  }

  return {
    captureComplete,
    commandCompleted: completed,
    evidenceOverflow,
    exitCode: exitCode ?? 1,
    returnLogPath,
    returnLogDigest,
    timedOut
  };
}

async function run(options = {}) {
  const result = await executeReturn(options);
  if (!result.commandCompleted || !result.captureComplete || result.exitCode !== 0) {
    throw new Error("Unity return did not complete with bounded successful evidence.");
  }
  console.log("::notice::Unity return command completed; redacted evidence remains local to the runner.");
  return result;
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`::error::${workflowCommandData(error.message || error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VERIFY_TIMEOUT_MS,
  MAX_EVIDENCE_BYTES,
  TERMINATION_GRACE_MS,
  UNITY_SIGNER_THUMBPRINTS,
  WINDOWS_SYSTEM_ROOT,
  assertNoReparsePath,
  editorEnvironment,
  editorPath,
  executeReturn,
  redactedEvidence,
  requiredInputs,
  run,
  runIdentity,
  systemPowerShell,
  terminateProcess,
  verifyUnityEditor,
  workflowCommandData
};
