#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PROFILES = new Set([
  "EditorOnly",
  "StandaloneWindowsIl2Cpp",
  "Android",
  "Full"
]);

function rawInput(env, name) {
  return String(env[`INPUT_${name.toUpperCase()}`] || "");
}

function optionalText(env, name) {
  const value = rawInput(env, name);
  if (value === "") {
    return undefined;
  }
  if (value !== value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error(`${name.toLowerCase()} is invalid.`);
  }
  return value;
}

function optionalBoolean(env, name) {
  const value = rawInput(env, name);
  if (value === "") {
    return undefined;
  }
  if (value !== "true" && value !== "false") {
    throw new Error(`${name.toLowerCase()} must be true or false.`);
  }
  return value === "true";
}

function requiredPayloadPaths(env) {
  let value = rawInput(env, "REQUIRED-EDITOR-PAYLOAD-RELATIVE-PATH");
  if (value === "") {
    return [];
  }
  value = value.replace(/\r?\n$/, "");
  const entries = value.split(/\r?\n/);
  if (entries.some((entry) => entry === "" || entry !== entry.trim())) {
    throw new Error(
      "required-editor-payload-relative-path must not contain blank entries or surrounding whitespace."
    );
  }
  if (entries.some((entry) => /[\r\0]/.test(entry))) {
    throw new Error("required-editor-payload-relative-path is invalid.");
  }
  const seen = new Set();
  for (const entry of entries) {
    const identity = entry.toLowerCase();
    if (seen.has(identity)) {
      throw new Error("required-editor-payload-relative-path must not contain duplicate entries.");
    }
    seen.add(identity);
  }
  return entries;
}

function parseInputs(env = process.env) {
  const unityVersion = optionalText(env, "UNITY-VERSION");
  if (unityVersion === undefined) {
    throw new Error("unity-version is required.");
  }
  if (!/^\d+\.\d+\.\d+f\d+$/.test(unityVersion)) {
    throw new Error("unity-version is invalid; expected a final Unity release such as 6000.5.2f1.");
  }
  const provisioningProfile = optionalText(env, "PROVISIONING-PROFILE");
  if (provisioningProfile !== undefined && !PROFILES.has(provisioningProfile)) {
    throw new Error("provisioning-profile is invalid.");
  }
  const withWindowsIl2Cpp = optionalBoolean(env, "WITH-WINDOWS-IL2CPP");
  if (
    withWindowsIl2Cpp === true &&
    provisioningProfile !== undefined &&
    provisioningProfile !== "StandaloneWindowsIl2Cpp"
  ) {
    throw new Error(
      "with-windows-il2cpp cannot be combined with a different provisioning-profile."
    );
  }
  return {
    unityVersion,
    installRoot: optionalText(env, "INSTALL-ROOT"),
    provisioningProfile,
    diagnosticsPath: optionalText(env, "DIAGNOSTICS-PATH"),
    ciManagedOnly: optionalBoolean(env, "CI-MANAGED-ONLY"),
    requireHealthyExisting: optionalBoolean(env, "REQUIRE-HEALTHY-EXISTING"),
    withWindowsIl2Cpp,
    requiredEditorPayloadRelativePath: requiredPayloadPaths(env)
  };
}

function effectiveValues(inputs, env) {
  return {
    installRoot: inputs.installRoot || env.UNITY_EDITOR_INSTALL_ROOT || "C:\\Unity\\Editors",
    provisioningProfile: inputs.withWindowsIl2Cpp === true
      ? "StandaloneWindowsIl2Cpp"
      : inputs.provisioningProfile || "Full",
    ciManagedOnly: inputs.ciManagedOnly === undefined
      ? env.GITHUB_ACTIONS === "true"
      : inputs.ciManagedOnly
  };
}

function powerShellConfig(inputs) {
  return {
    unityVersion: inputs.unityVersion,
    installRoot: inputs.installRoot ?? null,
    provisioningProfile: inputs.provisioningProfile ?? null,
    diagnosticsPath: inputs.diagnosticsPath ?? null,
    ciManagedOnly: inputs.ciManagedOnly ?? null,
    requireHealthyExisting: inputs.requireHealthyExisting ?? null,
    withWindowsIl2Cpp: inputs.withWindowsIl2Cpp ?? null,
    requiredEditorPayloadRelativePath: inputs.requiredEditorPayloadRelativePath
  };
}

function normalizedWindowsPath(value) {
  return path.win32.normalize(value).replace(/[\\/]+$/, "").toLowerCase();
}

function requiredString(record, name) {
  if (typeof record[name] !== "string" || record[name] === "") {
    throw new Error(`Unity editor diagnostics ${name} is missing or invalid.`);
  }
  return record[name];
}

function validateDiagnostics(record, inputs, env = process.env) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Unity editor diagnostics must be a JSON object.");
  }
  const expected = effectiveValues(inputs, env);
  if (requiredString(record, "unityVersion") !== inputs.unityVersion) {
    throw new Error("Unity editor diagnostics reported a different Unity version.");
  }
  if (requiredString(record, "provisioningProfile") !== expected.provisioningProfile) {
    throw new Error("Unity editor diagnostics reported a different provisioning profile.");
  }
  if (
    normalizedWindowsPath(requiredString(record, "installRoot")) !==
    normalizedWindowsPath(expected.installRoot)
  ) {
    throw new Error("Unity editor diagnostics reported a different install root.");
  }
  if (typeof record.ciManagedOnly !== "boolean" || record.ciManagedOnly !== expected.ciManagedOnly) {
    throw new Error("Unity editor diagnostics reported a different managed-only mode.");
  }
  if (record.finalClassification !== "success") {
    throw new Error("Unity editor diagnostics do not contain a successful classification.");
  }

  const editorPath = requiredString(record, "editorPath");
  if (/[^\S ]|\0/.test(editorPath) || !path.win32.isAbsolute(editorPath)) {
    throw new Error("Unity editor diagnostics editor path is invalid.");
  }
  if (expected.ciManagedOnly) {
    const expectedPaths = [
      path.win32.join(expected.installRoot, inputs.unityVersion, "Editor", "Unity.exe"),
      path.win32.join(
        expected.installRoot,
        "_ci-managed-editors",
        inputs.unityVersion,
        "Editor",
        "Unity.exe"
      )
    ].map(normalizedWindowsPath);
    if (!expectedPaths.includes(normalizedWindowsPath(editorPath))) {
      throw new Error("Unity editor diagnostics path is outside the reviewed managed layout.");
    }
  }
  return editorPath;
}

function resolvedDiagnosticsPath(inputs, env, io = fs) {
  const effective = effectiveValues(inputs, env);
  const requested = inputs.diagnosticsPath || path.win32.join(
    effective.installRoot,
    "_diagnostics",
    `${inputs.unityVersion}-provisioning-summary.json`
  );
  let directory = false;
  try {
    directory = io.statSync(requested).isDirectory();
  } catch {
    // A missing target with an extension is the normal file-output case.
  }
  if (directory || path.win32.extname(requested) === "") {
    return path.win32.join(requested, "ensure-editor-summary.json");
  }
  return requested;
}

function readDiagnostics(diagnosticsPath, io = fs) {
  let text;
  try {
    text = io.readFileSync(diagnosticsPath, "utf8");
  } catch {
    throw new Error("Unity editor validator did not produce readable diagnostics.");
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Unity editor validator produced malformed diagnostics JSON.");
  }
}

function writeOutput(env, editorPath, appendFile = fs.appendFileSync) {
  if (!env.GITHUB_OUTPUT) {
    throw new Error("GITHUB_OUTPUT is required.");
  }
  if (/[\r\n\0]/.test(editorPath)) {
    throw new Error("Unity editor path cannot be written safely.");
  }
  appendFile(env.GITHUB_OUTPUT, `editor-path=${editorPath}\n`, "utf8");
}

function workflowCommandData(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

function run(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const spawnSync = options.spawnSync || childProcess.spawnSync;
  const io = options.fs || fs;
  if (platform !== "win32") {
    throw new Error("ensure-unity-editor requires a Windows runner.");
  }
  const inputs = parseInputs(env);
  const actionRoot = path.join(__dirname, "..", "actions", "ensure-unity-editor");
  const wrapperPath = path.join(actionRoot, "invoke-ensure-editor.ps1");
  const validatorPath = path.join(actionRoot, "ensure-editor.ps1");
  const childEnv = {
    ...env,
    ENSURE_UNITY_EDITOR_CONFIG_B64: Buffer.from(
      JSON.stringify(powerShellConfig(inputs)),
      "utf8"
    ).toString("base64")
  };
  const result = spawnSync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", wrapperPath, validatorPath],
    {
      env: childEnv,
      shell: false,
      stdio: "inherit",
      windowsHide: true
    }
  );
  if (result.error) {
    throw new Error("Unity editor validator could not start.");
  }
  if (result.status !== 0) {
    if (result.status === null) {
      throw new Error(`Unity editor validator was terminated by ${result.signal || "an unknown signal"}.`);
    }
    throw new Error(`Unity editor validator exited with code ${result.status}.`);
  }
  const diagnosticsPath = resolvedDiagnosticsPath(inputs, env, io);
  const editorPath = validateDiagnostics(readDiagnostics(diagnosticsPath, io), inputs, env);
  writeOutput(env, editorPath, options.appendFile);
  console.log(`::notice::Unity editor validated: ${workflowCommandData(editorPath)}`);
  return { diagnosticsPath, editorPath };
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(`::error::${workflowCommandData(error.message || error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  effectiveValues,
  parseInputs,
  powerShellConfig,
  readDiagnostics,
  resolvedDiagnosticsPath,
  run,
  validateDiagnostics,
  workflowCommandData,
  writeOutput
};
