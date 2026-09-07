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
const DARWIN_CODESIGN_PATH = "/usr/bin/codesign";
const SUPPORTED_RETURN_PLATFORMS = new Set(["win32", "darwin"]);
const EDITOR_LAYOUTS = new Set(["canonical", "ci-managed-alternate"]);
const UNITY_SIGNER_THUMBPRINTS = new Set([
  "228FB6411B0A144478C86AAA3CD9473C43A8ABA7",
  "BFFD800651947878FCD0DC749C16D57B0D5E397D"
]);
/*
  Apple team identifiers whose Developer ID signature is accepted as Unity's own,
  and the Darwin counterpart of UNITY_SIGNER_THUMBPRINTS.

  9QW8UQUTAA was measured rather than recalled. The macOS editor package for the
  pinned editor -- MacEditorInstaller/Unity.pkg at revision eb73d3b415a1,
  6000.5.2f1 -- is a xar whose table of contents carries the signing chain in its
  first few kilobytes. Its leaf reads

    UID = 9QW8UQUTAA
    CN  = Developer ID Installer: Unity Technologies SF (9QW8UQUTAA)
    OU  = 9QW8UQUTAA
    O   = Unity Technologies SF

  issued by Apple's Developer ID Certification Authority under the Apple Root CA.
  A team identifier names the account rather than the certificate purpose, so the
  Developer ID Application certificate on Unity.app carries the same OU. That
  last step is an inference, and the macOS canary is what settles it.

  Being wrong here can only refuse a return, never accept one: the requirement
  also demands the Apple anchor and the Developer ID Application marker, so a
  mismatched team fails closed.
*/
const UNITY_DARWIN_TEAM_IDS = new Set(["9QW8UQUTAA"]);

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

function editorPath(toolCache, unityVersion, editorLayout = "canonical", platform = "win32") {
  if (!EDITOR_LAYOUTS.has(editorLayout)) {
    throw new Error("editor-layout is invalid.");
  }
  /*
    Deliberately no platform gate here. Resolving a path decides nothing about
    trust, and verifyUnityEditor is the one place that refuses an unsupported
    platform -- so there is a single answer to "may this platform return a
    licence" rather than two that can drift apart.
  */
  const layoutComponents = editorLayout === "ci-managed-alternate"
    ? ["u6-v3", "_ci-managed-editors"]
    : ["u6-v3"];
  /*
    The same install root on both platforms, so the layout stays one reviewed
    shape. Darwin's editor is the Mach-O inside the bundle rather than the
    bundle: the bundle is a directory, and every guard here -- the regular-file
    assertion, the symlink walk, and code-signature verification -- is about the
    executable the return actually runs.
  */
  const executableComponents = platform === "darwin"
    ? ["Editor", "Unity.app", "Contents", "MacOS", "Unity"]
    : ["Editor", "Unity.exe"];
  return path.join(
    toolCache,
    ...layoutComponents,
    unityVersion,
    ...executableComponents
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

/*
  The Darwin counterpart of the Authenticode script below, stated as a code
  signing requirement rather than as a thumbprint comparison this action makes
  itself. Both halves of the Windows check appear here:

    anchor apple generic                       -- the chain roots in Apple, as
                                                  Get-AuthenticodeSignature's
                                                  Valid status asserts;
    certificate 1[...6.2.6] exists             -- the issuer is the Developer ID
                                                  CA, not any Apple-anchored CA;
    certificate leaf[...6.1.13] exists         -- the leaf carries the Developer
                                                  ID Application marker, which
                                                  is the code-signing usage the
                                                  Windows script reads as EKU
                                                  1.3.6.1.5.5.7.3.3;
    certificate leaf[subject.OU] = "<team>"    -- the identity, which is what the
                                                  thumbprint allowlist pins.

  codesign evaluates it against the signature on disk, so no part of the verdict
  is computed from output this action parses.
*/
function darwinDesignatedRequirement(teamIDs) {
  const ordered = [...teamIDs].sort();
  if (ordered.length === 0) {
    throw new Error(
      "No reviewed Unity Developer ID team is configured, so a Darwin Unity return cannot be trusted."
    );
  }
  for (const teamID of ordered) {
    if (!/^[A-Z0-9]{10}$/.test(teamID)) {
      throw new Error("A reviewed Unity Developer ID team identifier is malformed.");
    }
  }
  const identity = ordered
    .map((teamID) => `certificate leaf[subject.OU] = "${teamID}"`)
    .join(" or ");
  return [
    "anchor apple generic",
    "certificate 1[field.1.2.840.113635.100.6.2.6] exists",
    "certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
    ordered.length === 1 ? identity : `(${identity})`
  ].join(" and ");
}

async function verifyDarwinUnityEditor(executable, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const environment = options.environment || {};
  const timeoutMs = options.timeoutMs === undefined
    ? DEFAULT_VERIFY_TIMEOUT_MS
    : options.timeoutMs;
  const teamIDs = options.allowedTeamIDs || UNITY_DARWIN_TEAM_IDS;
  const requirement = darwinDesignatedRequirement(teamIDs);

  await new Promise((resolve, reject) => {
    let settled = false;
    const verifier = spawnImpl(
      DARWIN_CODESIGN_PATH,
      ["--verify", "--strict", "-R", `=${requirement}`, "--", executable],
      {
        cwd: "/",
        env: environment,
        shell: false,
        stdio: "ignore"
      }
    );
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      terminateProcess(verifier, "darwin", spawnImpl, environment, options.killImpl);
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

async function verifyUnityEditor(executable, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "darwin") {
    return verifyDarwinUnityEditor(executable, options);
  }
  if (platform !== "win32") {
    throw new Error("The central Unity return action supports Windows and Darwin only.");
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

function terminateProcess(child, platform, spawnImpl, environment, killImpl) {
  if (!child || child.exitCode !== null) {
    return;
  }
  /*
    taskkill /T's counterpart. The editor is spawned detached on Darwin, so it
    leads its own process group and a negative pid signals the group -- the
    editor and every descendant it left behind. Signalling the pid alone would
    leave a hung child holding the seat after the parent exited, which is the
    property #153 names.
  */
  if (platform === "darwin" && Number.isInteger(child.pid) && child.pid > 0) {
    const kill = killImpl || process.kill.bind(process);
    const signalGroup = (signal) => {
      try {
        kill(-child.pid, signal);
        return true;
      } catch {
        return false;
      }
    };
    const fallback = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The caller will fail closed if the process does not exit.
      }
    };
    if (!signalGroup("SIGTERM")) {
      fallback();
      return;
    }
    const escalation = setTimeout(() => {
      if (!signalGroup("SIGKILL")) {
        fallback();
      }
    }, 5_000);
    escalation.unref?.();
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

function editorEnvironment(env, runnerTemp, platform = "win32") {
  if (platform === "darwin") {
    /*
      The same rule as the Windows list: an allowlist, so nothing the workflow
      happens to export reaches the editor. HOME is load-bearing rather than
      convenience -- the Unity licensing client reads and writes per-user state
      under it, and a return launched without it looks to Unity like a different
      user with no license to give back.
    */
    const allowedDarwin = ["HOME", "LANG", "LOGNAME", "PATH", "SHELL", "USER"];
    const darwinResult = {};
    for (const name of allowedDarwin) {
      if (typeof env[name] === "string" && env[name] !== "") {
        darwinResult[name] = env[name];
      }
    }
    if (!darwinResult.PATH) {
      darwinResult.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    }
    darwinResult.TMPDIR = runnerTemp;
    return darwinResult;
  }
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
    values.editorLayout,
    platform
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
  const childEnvironment = editorEnvironment(env, identity.runnerTemp, platform);
  const verifyEditor = options.verifyEditor || verifyUnityEditor;
  await verifyEditor(executable, {
    allowedTeamIDs: options.allowedTeamIDs,
    environment: childEnvironment,
    execPath: options.execPath,
    killImpl: options.killImpl,
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
      terminateProcess(child, platform, spawnImpl, childEnvironment, options.killImpl);
      terminationGrace = setTimeout(
        () => settle({ code: null, signal: "termination-grace-expired" }),
        terminationGraceMs
      );
      terminationGrace.unref?.();
    };
    child = spawnImpl(executable, argumentsList, {
      cwd: identity.runnerTemp,
      // Its own process group on Darwin, so terminateProcess can reach every
      // descendant with one signal. Inert on Windows, where taskkill /T walks
      // the tree instead.
      detached: platform === "darwin",
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
  DARWIN_CODESIGN_PATH,
  SUPPORTED_RETURN_PLATFORMS,
  UNITY_DARWIN_TEAM_IDS,
  UNITY_SIGNER_THUMBPRINTS,
  WINDOWS_SYSTEM_ROOT,
  assertNoReparsePath,
  darwinDesignatedRequirement,
  editorEnvironment,
  editorPath,
  executeReturn,
  redactedEvidence,
  requiredInputs,
  run,
  runIdentity,
  systemPowerShell,
  terminateProcess,
  verifyDarwinUnityEditor,
  verifyUnityEditor,
  workflowCommandData
};
