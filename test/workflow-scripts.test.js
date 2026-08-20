const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");
const scriptsRoot = path.join(repoRoot, "tools", "workflows");

function runScript(name, operation, environment = {}) {
  return childProcess.spawnSync("bash", [path.join(scriptsRoot, name), operation], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...environment }
  });
}

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

function shellCheckInstallHarness(t, architecture, checksumStatus = "0") {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "shellcheck-install-"));
  const shims = path.join(temporary, "bin");
  const runnerTemp = path.join(temporary, "runner");
  const githubPath = path.join(temporary, "github-path");
  const curlArguments = path.join(temporary, "curl-arguments");
  const checksumArguments = path.join(temporary, "checksum-arguments");
  const checksumInput = path.join(temporary, "checksum-input");
  const tarArguments = path.join(temporary, "tar-arguments");
  const events = path.join(temporary, "events");
  const shellcheckStub = path.join(temporary, "shellcheck-stub");

  fs.mkdirSync(shims);
  fs.mkdirSync(runnerTemp);
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

  writeExecutable(path.join(shims, "uname"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf '%s\\n' \"${TEST_ARCHITECTURE}\""
  ].join("\n"));
  writeExecutable(path.join(shims, "curl"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf 'curl\\n' >> \"${TEST_EVENTS}\"",
    "printf '%s\\n' \"$@\" > \"${TEST_CURL_ARGUMENTS}\"",
    "while (( $# > 0 )); do",
    "  if [[ \"$1\" == '--output' ]]; then",
    "    : > \"$2\"",
    "    exit 0",
    "  fi",
    "  shift",
    "done",
    "exit 91"
  ].join("\n"));
  writeExecutable(path.join(shims, "sha256sum"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf 'sha256sum\\n' >> \"${TEST_EVENTS}\"",
    "printf '%s\\n' \"$@\" > \"${TEST_CHECKSUM_ARGUMENTS}\"",
    "cat > \"${TEST_CHECKSUM_INPUT}\"",
    "exit \"${TEST_CHECKSUM_STATUS}\""
  ].join("\n"));
  writeExecutable(shellcheckStub, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf 'shellcheck\\n' >> \"${TEST_EVENTS}\""
  ].join("\n"));
  writeExecutable(path.join(shims, "tar"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf 'tar\\n' >> \"${TEST_EVENTS}\"",
    "printf '%s\\n' \"$@\" > \"${TEST_TAR_ARGUMENTS}\"",
    "mkdir -p \"${TEST_BUNDLE_PATH}\"",
    "cp \"${TEST_SHELLCHECK_STUB}\" \"${TEST_BUNDLE_PATH}/shellcheck\""
  ].join("\n"));

  return {
    temporary,
    runnerTemp,
    githubPath,
    curlArguments,
    checksumArguments,
    checksumInput,
    tarArguments,
    events,
    environment: {
      PATH: `${shims}:${process.env.PATH}`,
      RUNNER_TEMP: runnerTemp,
      GITHUB_PATH: githubPath,
      TEST_ARCHITECTURE: architecture,
      TEST_CHECKSUM_STATUS: checksumStatus,
      TEST_CURL_ARGUMENTS: curlArguments,
      TEST_CHECKSUM_ARGUMENTS: checksumArguments,
      TEST_CHECKSUM_INPUT: checksumInput,
      TEST_TAR_ARGUMENTS: tarArguments,
      TEST_EVENTS: events,
      TEST_SHELLCHECK_STUB: shellcheckStub,
      TEST_BUNDLE_PATH: path.join(runnerTemp, "shellcheck-v0.11.0")
    }
  };
}

test("workflow shell entrypoints are syntactically valid and strict", () => {
  const scripts = fs.readdirSync(scriptsRoot).filter((name) => name.endsWith(".sh")).sort();
  assert.deepEqual(scripts, [
    "auto-release.sh",
    "ci.sh",
    "onboard-unity-repository.sh",
    "request-unity-repository-onboarding.sh",
    "unity-enrollment-audit.sh"
  ]);

  for (const script of scripts) {
    const text = fs.readFileSync(path.join(scriptsRoot, script), "utf8");
    assert.match(text, /^#!\/usr\/bin\/env bash\nset -euo pipefail\n/);
    assert.equal(childProcess.spawnSync("bash", ["-n", path.join(scriptsRoot, script)]).status, 0);
  }
});

test("ShellCheck installation downloads and verifies the pinned bundle for supported architectures", async (t) => {
  const cases = [
    {
      runnerArchitecture: "x86_64",
      releaseArchitecture: "x86_64",
      checksum: "8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198"
    },
    {
      runnerArchitecture: "aarch64",
      releaseArchitecture: "aarch64",
      checksum: "12b331c1d2db6b9eb13cfca64306b1b157a86eb69db83023e261eaa7e7c14588"
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.runnerArchitecture, (subtest) => {
      const harness = shellCheckInstallHarness(subtest, testCase.runnerArchitecture);
      const archive = path.join(
        harness.runnerTemp,
        `shellcheck-v0.11.0.linux.${testCase.releaseArchitecture}.tar.xz`
      );
      const bundle = path.join(harness.runnerTemp, "shellcheck-v0.11.0");
      const result = runScript("ci.sh", "install-shellcheck", harness.environment);

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(fs.readFileSync(harness.curlArguments, "utf8").trimEnd().split("\n"), [
        "--proto", "=https",
        "--tlsv1.2",
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--retry", "3",
        "--retry-connrefused",
        "--retry-max-time", "240",
        "--connect-timeout", "10",
        "--max-time", "60",
        "--output", archive,
        `https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.${testCase.releaseArchitecture}.tar.xz`
      ]);
      assert.equal(fs.readFileSync(harness.checksumArguments, "utf8"), "--check\n--status\n");
      assert.equal(fs.readFileSync(harness.checksumInput, "utf8"), `${testCase.checksum}  ${archive}\n`);
      assert.deepEqual(fs.readFileSync(harness.tarArguments, "utf8").trimEnd().split("\n"), [
        "-xJf", archive, "-C", harness.runnerTemp
      ]);
      assert.equal(fs.readFileSync(harness.githubPath, "utf8"), `${bundle}\n`);
      assert.equal(fs.readFileSync(harness.events, "utf8"), "curl\nsha256sum\ntar\nshellcheck\n");
    });
  }
});

test("ShellCheck installation stops before extraction when checksum verification fails", (t) => {
  const harness = shellCheckInstallHarness(t, "x86_64", "1");
  fs.writeFileSync(harness.githubPath, "existing-path\n");

  const result = runScript("ci.sh", "install-shellcheck", harness.environment);

  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(harness.events, "utf8"), "curl\nsha256sum\n");
  assert.equal(fs.existsSync(harness.tarArguments), false);
  assert.equal(fs.existsSync(harness.environment.TEST_BUNDLE_PATH), false);
  assert.equal(fs.readFileSync(harness.githubPath, "utf8"), "existing-path\n");
});

test("ShellCheck installation rejects unknown architectures before download", (t) => {
  const harness = shellCheckInstallHarness(t, "riscv64");
  fs.writeFileSync(harness.githubPath, "existing-path\n");

  const result = runScript("ci.sh", "install-shellcheck", harness.environment);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported ShellCheck runner architecture: riscv64/);
  assert.equal(fs.existsSync(harness.curlArguments), false);
  assert.equal(fs.existsSync(harness.events), false);
  assert.equal(fs.readFileSync(harness.githubPath, "utf8"), "existing-path\n");
});

test("request onboarding rejects non-main refs and writes typed inert evidence", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "unity-onboarding-request-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

  assert.notEqual(runScript("request-unity-repository-onboarding.sh", "validate-ref", {
    REQUEST_REF: "refs/heads/feature"
  }).status, 0);
  assert.equal(runScript("request-unity-repository-onboarding.sh", "validate-ref", {
    REQUEST_REF: "refs/heads/main"
  }).status, 0);

  const result = runScript("request-unity-repository-onboarding.sh", "write-request", {
    RUNNER_TEMP: temporary,
    TARGET_REPOSITORY: "Ambiguous-Interactive/example",
    TARGET_DEFAULT_BRANCH: "main",
    TARGET_FORK: "false",
    TARGET_ALLOW_WORKFLOW_DISPATCH: "true"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(temporary, "unity-onboarding-request.json"), "utf8")),
    {
      repository: "Ambiguous-Interactive/example",
      defaultBranch: "main",
      fork: false,
      allowWorkflowDispatch: true
    }
  );
});

test("trusted onboarding rejects mismatched workflow-run identity", () => {
  const baseline = {
    REQUEST_CONCLUSION: "success",
    REQUEST_HEAD_BRANCH: "main",
    REQUEST_HEAD_REPOSITORY: "Ambiguous-Interactive/ambiguous-organization-build-lock",
    TRUSTED_REPOSITORY: "Ambiguous-Interactive/ambiguous-organization-build-lock"
  };
  assert.equal(runScript("onboard-unity-repository.sh", "reject-untrusted-request", baseline).status, 0);

  for (const override of [
    { REQUEST_CONCLUSION: "failure" },
    { REQUEST_HEAD_BRANCH: "feature" },
    { REQUEST_HEAD_REPOSITORY: "attacker/fork" }
  ]) {
    assert.notEqual(
      runScript("onboard-unity-repository.sh", "reject-untrusted-request", { ...baseline, ...override }).status,
      0
    );
  }
});

test("trusted onboarding validates request shape before publishing outputs", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "unity-onboarding-validate-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const requestPath = path.join(temporary, "request.json");
  const outputPath = path.join(temporary, "output.txt");
  const request = {
    repository: "Ambiguous-Interactive/example",
    defaultBranch: "main",
    fork: false,
    allowWorkflowDispatch: false
  };
  fs.writeFileSync(requestPath, JSON.stringify(request));

  const valid = runScript("onboard-unity-repository.sh", "validate-request", {
    REQUEST_PATH: requestPath,
    GITHUB_OUTPUT: outputPath
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(
    fs.readFileSync(outputPath, "utf8"),
    "repository=Ambiguous-Interactive/example\nrepository_name=example\ndefault_branch=main\nfork=false\nallow_dispatch=false\n"
  );

  fs.writeFileSync(requestPath, JSON.stringify({ ...request, unexpected: true }));
  fs.rmSync(outputPath);
  const invalid = runScript("onboard-unity-repository.sh", "validate-request", {
    REQUEST_PATH: requestPath,
    GITHUB_OUTPUT: outputPath
  });
  assert.notEqual(invalid.status, 0);
  assert.equal(fs.existsSync(outputPath), false);
});

test("enrollment summary fails closed when retained audit evidence is incomplete", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "unity-enrollment-summary-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const auditPath = path.join(temporary, "audit.json");
  const summaryPath = path.join(temporary, "summary.md");
  const environment = { AUDIT_PATH: auditPath, GITHUB_STEP_SUMMARY: summaryPath };

  fs.writeFileSync(auditPath, JSON.stringify({ repositories: [], inventory: [], findings: [], complete: true }));
  assert.equal(runScript("unity-enrollment-audit.sh", "record-counts", environment).status, 0);
  assert.match(fs.readFileSync(summaryPath, "utf8"), /Complete: true/);

  fs.writeFileSync(auditPath, JSON.stringify({ repositories: [], inventory: [], findings: [], complete: false }));
  const incomplete = runScript("unity-enrollment-audit.sh", "record-counts", environment);
  assert.notEqual(incomplete.status, 0);
  assert.match(fs.readFileSync(summaryPath, "utf8"), /policy status is unknown/);
});
