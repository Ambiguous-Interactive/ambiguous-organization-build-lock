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

test("Steam profile binds to Linux Mono and IL2CPP validation", () => {
  const environment = validEnvironment({ "INPUT_PROVISIONING-PROFILE": "Steam" });
  const inputs = parseInputs(environment);
  assert.equal(inputs.provisioningProfile, "Steam");
  assert.equal(
    validateDiagnostics(validDiagnostics({ provisioningProfile: "Steam" }), inputs, environment),
    validDiagnostics().editorPath
  );
});

test("supported target profiles parse as exact inputs", () => {
  for (const profile of [
    "StandaloneWindowsMono",
    "StandaloneWindowsIl2Cpp",
    "StandaloneLinuxMono",
    "StandaloneLinuxIl2Cpp",
    "StandaloneMacMono",
    "StandaloneMacIl2Cpp",
    "WebGL",
    "iOS",
    "AndroidMono",
    "AndroidIl2Cpp"
  ]) {
    const inputs = parseInputs(validEnvironment({ "INPUT_PROVISIONING-PROFILE": profile }));
    assert.equal(inputs.provisioningProfile, profile);
  }
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

test("vendored validator matches the reviewed self-contained payload digest", () => {
  const text = fs.readFileSync(payloadPath, "utf8");
  const normalizedPayload = Buffer.from(text.replace(/\r\n/g, "\n"), "utf8");
  assert.equal(
    crypto.createHash("sha256").update(normalizedPayload).digest("hex"),
    "cf26dfec9b5a88ff425411a89b1002227d0b3f7bd7781ff8ce4d8cb30be4a36f"
  );
  assert.doesNotMatch(text, /\$PSScriptRoot/i);
  assert.doesNotMatch(text, /^\s*\.\s+[^\r\n]+/m);
});

test("Steam profile includes Linux Mono and IL2CPP without Android modules", () => {
  const source = fs.readFileSync(payloadPath, "utf8");
  const moduleRows = [...source.matchAll(/\[pscustomobject\]@\{ Id = '([^']+)';[^\r\n]*Profiles = @\(([^)]*)\) \}/g)];
  const steamModuleIds = moduleRows
    .filter((row) => row[2].split(",").some((profile) => profile.trim() === "'Steam'"))
    .map((row) => row[1]);
  assert.deepEqual(steamModuleIds, ["linux-mono", "linux-il2cpp"]);
});

test("target profiles cover supported channel targets and backends", () => {
  const source = fs.readFileSync(payloadPath, "utf8");
  const expectedProfiles = [
    "StandaloneWindowsMono",
    "StandaloneWindowsIl2Cpp",
    "StandaloneLinuxMono",
    "StandaloneLinuxIl2Cpp",
    "StandaloneMacMono",
    "StandaloneMacIl2Cpp",
    "WebGL",
    "iOS",
    "AndroidMono",
    "AndroidIl2Cpp",
    "Steam"
  ];
  const validateSet = source.match(/\[ValidateSet\(([^\]]+)\)\]/)?.[1] || "";
  for (const profile of expectedProfiles) {
    assert.ok(validateSet.includes(`'${profile}'`), `${profile} must be accepted by PowerShell`);
  }
  const rows = [...source.matchAll(/\[pscustomobject\]@\{ Id = '([^']+)';[^\r\n]*Profiles = @\(([^)]*)\) \}/g)];
  const assignments = Object.fromEntries(rows.map((row) => [row[1], row[2].split(",").map((item) => item.trim().replaceAll("'", ""))]));
  for (const [module, profiles] of Object.entries({
    "windows-mono": ["StandaloneWindowsMono"],
    "windows-il2cpp": ["StandaloneWindowsIl2Cpp", "Full"],
    "linux-mono": ["StandaloneLinuxMono", "Steam", "Full"],
    "linux-il2cpp": ["StandaloneLinuxIl2Cpp", "Steam", "Full"],
    "mac-mono": ["StandaloneMacMono"],
    "mac-il2cpp": ["StandaloneMacIl2Cpp"],
    webgl: ["WebGL", "Full"],
    ios: ["iOS"],
    android: ["AndroidMono", "AndroidIl2Cpp", "Android", "Full"]
  })) {
    assert.deepEqual(assignments[module], profiles, `${module} profile assignment`);
  }
});

test("target module probes require backend-specific payload evidence", () => {
  const childProcess = require("node:child_process");
  const command = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:ENSURE_EDITOR_SCRIPT_PATH, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) { throw 'ensure-editor.ps1 has parse errors.' }
foreach ($name in @('Test-AnyUnityLeafPresent', 'Test-UnityCiModuleGroupPresent')) {
  $functionAst = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true) | Select-Object -First 1
  if (-not $functionAst) { throw "Function '$name' not found." }
  Invoke-Expression "function script:$name $($functionAst.Body.Extent.Text)"
}
$root = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
$editor = Join-Path $root 'Editor/Unity.exe'
New-Item -ItemType File -Path $editor -Force | Out-Null
$editorPath = $editor
function Add-FixtureFile([string]$RelativePath) {
  $path = Join-Path $root $RelativePath
  New-Item -ItemType File -Path $path -Force | Out-Null
}
try {
  Add-FixtureFile 'Editor/Data/PlaybackEngines/WindowsStandaloneSupport/Variations/win64_player_development_mono/WindowsPlayer.exe'
  Add-FixtureFile 'Editor/Data/PlaybackEngines/iOSSupport/UnityEditor.iOS.Extensions.dll'
  Add-FixtureFile 'Editor/Data/PlaybackEngines/iOSSupport/Tools/MapFileParser.exe'
  Add-FixtureFile 'Editor/Data/PlaybackEngines/MacStandaloneSupport/UnityEditor.OSXStandalone.Extensions.dll'
  $beforeMono = Test-UnityCiModuleGroupPresent -EditorPath $editorPath -Group 'mac-mono'
  $beforeIl2Cpp = Test-UnityCiModuleGroupPresent -EditorPath $editorPath -Group 'mac-il2cpp'
  Add-FixtureFile 'Editor/Data/PlaybackEngines/MacStandaloneSupport/Variations/macosx64_player_development_mono/UnityPlayer.dylib'
  $macMono = Test-UnityCiModuleGroupPresent -EditorPath $editorPath -Group 'mac-mono'
  $afterMonoIl2Cpp = Test-UnityCiModuleGroupPresent -EditorPath $editorPath -Group 'mac-il2cpp'
  Add-FixtureFile 'Editor/Data/PlaybackEngines/MacStandaloneSupport/Variations/macosx64_player_development_il2cpp/UnityPlayer.dylib'
  [ordered]@{
    windowsMono = Test-UnityCiModuleGroupPresent -EditorPath $editorPath -Group 'windows-mono'
    ios = Test-UnityCiModuleGroupPresent -EditorPath $editorPath -Group 'ios'
    macMonoAbsentBeforePlayer = $beforeMono
    macIl2CppAbsentBeforePlayer = $beforeIl2Cpp
    macMono = $macMono
    macIl2CppNotMono = $afterMonoIl2Cpp
    macIl2Cpp = Test-UnityCiModuleGroupPresent -EditorPath $editorPath -Group 'mac-il2cpp'
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
  const result = childProcess.spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    env: { ...process.env, ENSURE_EDITOR_SCRIPT_PATH: payloadPath },
    shell: false
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    windowsMono: true,
    ios: true,
    macMonoAbsentBeforePlayer: false,
    macIl2CppAbsentBeforePlayer: false,
    macMono: true,
    macIl2CppNotMono: false,
    macIl2Cpp: true
  });
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

test("target profiles request and verify only their module groups", () => {
  const childProcess = require("node:child_process");
  const command = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:ENSURE_EDITOR_SCRIPT_PATH, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) { throw 'ensure-editor.ps1 has parse errors.' }
foreach ($name in @('Assert-UnityProvisioningProfile', 'Get-UnityCiModuleSpec', 'Get-UnityCiModuleSpecForProfile', 'Get-UnityCiModuleIds', 'Get-UnityCiVerifiedModuleGroups', 'Test-UnityProvisioningProfileIncludesAndroid', 'Get-UnityCiModuleIdsForTier')) {
  $functionAst = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true) | Select-Object -First 1
  if (-not $functionAst) { throw "Function '$name' not found." }
  Invoke-Expression "function script:$name $($functionAst.Body.Extent.Text)"
}
$profiles = @('StandaloneWindowsMono', 'StandaloneWindowsIl2Cpp', 'StandaloneLinuxMono', 'StandaloneLinuxIl2Cpp', 'StandaloneMacMono', 'StandaloneMacIl2Cpp', 'WebGL', 'iOS', 'AndroidMono', 'AndroidIl2Cpp', 'Steam', 'Android', 'Full')
$result = [ordered]@{}
foreach ($profile in $profiles) {
  $android = @()
  if (Test-UnityProvisioningProfileIncludesAndroid -Profile $profile) {
    $android = @(Get-UnityCiModuleIdsForTier -Tier 'android' -Profile $profile)
  }
  $result[$profile] = [ordered]@{
    requested = @(Get-UnityCiModuleIds -Profile $profile)
    verified = @(Get-UnityCiVerifiedModuleGroups -Profile $profile)
    android = $android
  }
}
$result | ConvertTo-Json -Compress -Depth 5
`;
  const result = childProcess.spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    env: { ...process.env, ENSURE_EDITOR_SCRIPT_PATH: payloadPath },
    shell: false
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    StandaloneWindowsMono: { requested: ["windows-mono"], verified: ["windows-mono"], android: [] },
    StandaloneWindowsIl2Cpp: { requested: ["windows-il2cpp"], verified: ["windows-il2cpp"], android: [] },
    StandaloneLinuxMono: { requested: ["linux-mono"], verified: ["linux-mono"], android: [] },
    StandaloneLinuxIl2Cpp: { requested: ["linux-il2cpp"], verified: ["linux-il2cpp"], android: [] },
    StandaloneMacMono: { requested: ["mac-mono"], verified: ["mac-mono"], android: [] },
    StandaloneMacIl2Cpp: { requested: ["mac-il2cpp"], verified: ["mac-il2cpp"], android: [] },
    WebGL: { requested: ["webgl"], verified: ["webgl"], android: [] },
    iOS: { requested: ["ios"], verified: ["ios"], android: [] },
    AndroidMono: {
      requested: ["android", "android-sdk-ndk-tools"],
      verified: ["android", "android-sdk-ndk-tools", "android-open-jdk"],
      android: ["android", "android-sdk-ndk-tools"]
    },
    AndroidIl2Cpp: {
      requested: ["android", "android-sdk-ndk-tools"],
      verified: ["android", "android-sdk-ndk-tools", "android-open-jdk"],
      android: ["android", "android-sdk-ndk-tools"]
    },
    Steam: { requested: ["linux-mono", "linux-il2cpp"], verified: ["linux-mono", "linux-il2cpp"], android: [] },
    Android: {
      requested: ["android", "android-sdk-ndk-tools"],
      verified: ["android", "android-sdk-ndk-tools", "android-open-jdk"],
      android: ["android", "android-sdk-ndk-tools"]
    },
    Full: {
      requested: ["windows-il2cpp", "webgl", "linux-mono", "linux-il2cpp", "android", "android-sdk-ndk-tools"],
      verified: ["windows-il2cpp", "webgl", "linux-mono", "linux-il2cpp", "android", "android-sdk-ndk-tools", "android-open-jdk"],
      android: ["android", "android-sdk-ndk-tools"]
    }
  });
});
