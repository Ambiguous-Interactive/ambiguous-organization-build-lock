const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  parseInputs,
  powerShellConfig,
  run,
  validateDiagnostics
} = require("../.github/dist/ensure-unity-editor.js");

const repoRoot = path.join(__dirname, "..");
const payloadPath = path.join(
  repoRoot,
  ".github",
  "actions",
  "ensure-unity-editor",
  "ensure-editor.ps1"
);

function validEnvironment(overrides = {}) {
  return {
    "INPUT_UNITY-VERSION": "6000.5.2f1",
    "INPUT_INSTALL-ROOT": "D:\\tool-cache\\u6-v3",
    "INPUT_PROVISIONING-PROFILE": "EditorOnly",
    "INPUT_DIAGNOSTICS-PATH": "unity-editor-check.json",
    "INPUT_CI-MANAGED-ONLY": "true",
    "INPUT_REQUIRE-HEALTHY-EXISTING": "true",
    "INPUT_WITH-WINDOWS-IL2CPP": "false",
    "INPUT_REQUIRED-EDITOR-PAYLOAD-RELATIVE-PATH": "Data/Resources/unity default resources\nData/Managed/UnityEngine.dll",
    GITHUB_ACTIONS: "true",
    GITHUB_OUTPUT: "github-output.txt",
    ...overrides
  };
}

function validDiagnostics(overrides = {}) {
  return {
    unityVersion: "6000.5.2f1",
    provisioningProfile: "EditorOnly",
    installRoot: "D:\\tool-cache\\u6-v3",
    editorPath: "D:\\tool-cache\\u6-v3\\6000.5.2f1\\Editor\\Unity.exe",
    ciManagedOnly: true,
    finalClassification: "success",
    ...overrides
  };
}

test("action input parsing preserves the upstream parameter surface", () => {
  const parsed = parseInputs(validEnvironment());
  assert.deepEqual(parsed, {
    unityVersion: "6000.5.2f1",
    installRoot: "D:\\tool-cache\\u6-v3",
    provisioningProfile: "EditorOnly",
    diagnosticsPath: "unity-editor-check.json",
    ciManagedOnly: true,
    requireHealthyExisting: true,
    withWindowsIl2Cpp: false,
    requiredEditorPayloadRelativePath: [
      "Data/Resources/unity default resources",
      "Data/Managed/UnityEngine.dll"
    ]
  });
});

test("optional inputs remain omitted so the upstream defaults stay authoritative", () => {
  assert.deepEqual(parseInputs(validEnvironment({
    "INPUT_INSTALL-ROOT": "",
    "INPUT_PROVISIONING-PROFILE": "",
    "INPUT_DIAGNOSTICS-PATH": "",
    "INPUT_CI-MANAGED-ONLY": "",
    "INPUT_REQUIRE-HEALTHY-EXISTING": "",
    "INPUT_WITH-WINDOWS-IL2CPP": "",
    "INPUT_REQUIRED-EDITOR-PAYLOAD-RELATIVE-PATH": ""
  })), {
    unityVersion: "6000.5.2f1",
    installRoot: undefined,
    provisioningProfile: undefined,
    diagnosticsPath: undefined,
    ciManagedOnly: undefined,
    requireHealthyExisting: undefined,
    withWindowsIl2Cpp: undefined,
    requiredEditorPayloadRelativePath: []
  });
});

test("payload lists accept the single trailing newline produced by YAML block scalars", () => {
  assert.deepEqual(
    parseInputs(validEnvironment({
      "INPUT_REQUIRED-EDITOR-PAYLOAD-RELATIVE-PATH": "Data/a\r\nData/b\r\n"
    })).requiredEditorPayloadRelativePath,
    ["Data/a", "Data/b"]
  );
});

for (const item of [
  { name: "missing version", env: { "INPUT_UNITY-VERSION": "" }, match: /unity-version is required/ },
  { name: "non-final version", env: { "INPUT_UNITY-VERSION": "6000.5.2b1" }, match: /unity-version is invalid/ },
  { name: "unknown profile", env: { "INPUT_PROVISIONING-PROFILE": "Server" }, match: /provisioning-profile is invalid/ },
  { name: "malformed managed flag", env: { "INPUT_CI-MANAGED-ONLY": "yes" }, match: /ci-managed-only must be true or false/ },
  { name: "malformed healthy flag", env: { "INPUT_REQUIRE-HEALTHY-EXISTING": "1" }, match: /require-healthy-existing must be true or false/ },
  { name: "malformed IL2CPP flag", env: { "INPUT_WITH-WINDOWS-IL2CPP": "TRUE " }, match: /with-windows-il2cpp must be true or false/ },
  { name: "conflicting IL2CPP profile", env: { "INPUT_WITH-WINDOWS-IL2CPP": "true", "INPUT_PROVISIONING-PROFILE": "EditorOnly" }, match: /cannot be combined/ },
  { name: "blank payload entry", env: { "INPUT_REQUIRED-EDITOR-PAYLOAD-RELATIVE-PATH": "Data/a\n\nData/b" }, match: /must not contain blank entries/ },
  { name: "duplicate payload entry", env: { "INPUT_REQUIRED-EDITOR-PAYLOAD-RELATIVE-PATH": "Data/a\ndata/a" }, match: /must not contain duplicate entries/ }
]) {
  test(`input parsing rejects ${item.name}`, () => {
    assert.throws(() => parseInputs(validEnvironment(item.env)), item.match);
  });
}

test("diagnostics bind the canonical managed editor path", () => {
  const inputs = parseInputs(validEnvironment());
  assert.equal(
    validateDiagnostics(validDiagnostics(), inputs, validEnvironment()),
    "D:\\tool-cache\\u6-v3\\6000.5.2f1\\Editor\\Unity.exe"
  );
});

test("diagnostics bind the reviewed CI-managed alternate editor path", () => {
  const inputs = parseInputs(validEnvironment());
  assert.equal(
    validateDiagnostics(validDiagnostics({
      editorPath: "D:\\tool-cache\\u6-v3\\_ci-managed-editors\\6000.5.2f1\\Editor\\Unity.exe"
    }), inputs, validEnvironment()),
    "D:\\tool-cache\\u6-v3\\_ci-managed-editors\\6000.5.2f1\\Editor\\Unity.exe"
  );
});

for (const item of [
  { name: "wrong version", diagnostics: { unityVersion: "2022.3.45f1" }, match: /Unity version/ },
  { name: "wrong profile", diagnostics: { provisioningProfile: "Full" }, match: /provisioning profile/ },
  { name: "wrong install root", diagnostics: { installRoot: "D:\\other" }, match: /install root/ },
  { name: "unmanaged result", diagnostics: { ciManagedOnly: false }, match: /managed-only mode/ },
  { name: "failed classification", diagnostics: { finalClassification: "failed: probe" }, match: /successful classification/ },
  { name: "outside-root path", diagnostics: { editorPath: "D:\\attacker\\Unity.exe" }, match: /reviewed managed layout/ },
  { name: "output injection", diagnostics: { editorPath: "D:\\tool-cache\\u6-v3\\6000.5.2f1\\Editor\\Unity.exe\nunsafe=true" }, match: /editor path is invalid/ }
]) {
  test(`diagnostics reject ${item.name}`, () => {
    const inputs = parseInputs(validEnvironment());
    assert.throws(
      () => validateDiagnostics(validDiagnostics(item.diagnostics), inputs, validEnvironment()),
      item.match
    );
  });
}

test("the action invokes pwsh without a shell and writes output only after evidence validation", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-unity-editor-test-"));
  test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const diagnosticsPath = path.join(temp, "diagnostics.json");
  const outputPath = path.join(temp, "output.txt");
  const environment = validEnvironment({
    "INPUT_DIAGNOSTICS-PATH": diagnosticsPath,
    GITHUB_OUTPUT: outputPath
  });
  let invocation;
  const spawnSync = (executable, args, options) => {
    invocation = { executable, args, options };
    fs.writeFileSync(diagnosticsPath, `\ufeff${JSON.stringify(validDiagnostics())}`, "utf8");
    return { status: 0, signal: null, error: undefined };
  };

  const result = run({ env: environment, platform: "win32", spawnSync });

  assert.equal(result.editorPath, validDiagnostics().editorPath);
  assert.equal(invocation.executable, "pwsh");
  assert.deepEqual(invocation.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File"]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.stdio, "inherit");
  assert.equal(
    JSON.parse(Buffer.from(invocation.options.env.ENSURE_UNITY_EDITOR_CONFIG_B64, "base64").toString("utf8")).unityVersion,
    "6000.5.2f1"
  );
  assert.equal(fs.readFileSync(outputPath, "utf8"), `editor-path=${validDiagnostics().editorPath}\n`);
});

test("a failed validator never writes editor-path", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-unity-editor-test-"));
  test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const outputPath = path.join(temp, "output.txt");
  assert.throws(() => run({
    env: validEnvironment({
      "INPUT_DIAGNOSTICS-PATH": path.join(temp, "missing.json"),
      GITHUB_OUTPUT: outputPath
    }),
    platform: "win32",
    spawnSync: () => ({ status: 7, signal: null, error: undefined })
  }), /validator exited with code 7/);
  assert.equal(fs.existsSync(outputPath), false);
});

test("successful execution with malformed evidence never writes editor-path", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-unity-editor-test-"));
  test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const diagnosticsPath = path.join(temp, "diagnostics.json");
  const outputPath = path.join(temp, "output.txt");
  assert.throws(() => run({
    env: validEnvironment({
      "INPUT_DIAGNOSTICS-PATH": diagnosticsPath,
      GITHUB_OUTPUT: outputPath
    }),
    platform: "win32",
    spawnSync: () => {
      fs.writeFileSync(diagnosticsPath, "not json", "utf8");
      return { status: 0, signal: null, error: undefined };
    }
  }), /malformed diagnostics JSON/);
  assert.equal(fs.existsSync(outputPath), false);
});

test("the action remains Windows-only", () => {
  assert.throws(
    () => run({ env: validEnvironment(), platform: "linux", spawnSync: () => assert.fail("spawned") }),
    /Windows runner/
  );
});

test("vendored validator is the approved self-contained upstream payload", () => {
  const payload = fs.readFileSync(payloadPath);
  assert.equal(
    crypto.createHash("sha256").update(payload).digest("hex"),
    "c9a5cea6ad890bc7b2ad189a05a0d1a0514f1b850e45002318b360851289e837"
  );
  const text = payload.toString("utf8");
  assert.doesNotMatch(text, /\$PSScriptRoot/i);
  assert.doesNotMatch(text, /^\s*\.\s+[^\r\n]+/m);
});

test("the PowerShell adapter splats typed JSON without dynamic evaluation", () => {
  const adapter = fs.readFileSync(path.join(path.dirname(payloadPath), "invoke-ensure-editor.ps1"), "utf8");
  assert.match(adapter, /ConvertFrom-Json/);
  assert.match(adapter, /& \$ValidatorPath @parameters/);
  assert.doesNotMatch(adapter, /Invoke-Expression|ScriptBlock/i);
});

test("the PowerShell adapter maps every typed value", {
  skip: process.platform !== "win32" && "requires hosted Windows PowerShell"
}, () => {
  const childProcess = require("node:child_process");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-unity-editor-pwsh-"));
  test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const fakeValidator = path.join(temp, "validator.ps1");
  fs.writeFileSync(fakeValidator, `param(
  [string]$UnityVersion, [string]$InstallRoot, [string]$ProvisioningProfile,
  [string]$DiagnosticsPath, [switch]$CiManagedOnly,
  [switch]$RequireHealthyExisting, [switch]$WithWindowsIl2Cpp,
  [string[]]$RequiredEditorPayloadRelativePath
)
[ordered]@{
  unityVersion = $UnityVersion; installRoot = $InstallRoot
  provisioningProfile = $ProvisioningProfile; diagnosticsPath = $DiagnosticsPath
  ciManagedOnly = [bool]$CiManagedOnly; requireHealthyExisting = [bool]$RequireHealthyExisting
  withWindowsIl2Cpp = [bool]$WithWindowsIl2Cpp
  required = @($RequiredEditorPayloadRelativePath)
} | ConvertTo-Json -Compress
`, "utf8");
  const inputs = parseInputs(validEnvironment());
  const result = childProcess.spawnSync("pwsh", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    path.join(path.dirname(payloadPath), "invoke-ensure-editor.ps1"), fakeValidator
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      ENSURE_UNITY_EDITOR_CONFIG_B64: Buffer.from(
        JSON.stringify(powerShellConfig(inputs)),
        "utf8"
      ).toString("base64")
    },
    shell: false
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    unityVersion: inputs.unityVersion,
    installRoot: inputs.installRoot,
    provisioningProfile: inputs.provisioningProfile,
    diagnosticsPath: inputs.diagnosticsPath,
    ciManagedOnly: true,
    requireHealthyExisting: true,
    withWindowsIl2Cpp: false,
    required: inputs.requiredEditorPayloadRelativePath
  });
});
