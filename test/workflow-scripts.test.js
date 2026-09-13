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
    "merge-policy-audit.sh",
    "onboard-unity-repository.sh",
    "open-release-authorization-pr.sh",
    "repin-consumer-locks.sh",
    "report-nonconventional-commits.sh",
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

test("merge policy summary fails closed when retained audit evidence is incomplete", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "merge-policy-summary-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const auditPath = path.join(temporary, "audit.json");
  const summaryPath = path.join(temporary, "summary.md");
  const environment = { AUDIT_PATH: auditPath, GITHUB_STEP_SUMMARY: summaryPath };

  fs.writeFileSync(auditPath, JSON.stringify({ repositories: [], inventory: [], findings: [], complete: true }));
  assert.equal(runScript("merge-policy-audit.sh", "record-counts", environment).status, 0);
  assert.match(fs.readFileSync(summaryPath, "utf8"), /Complete: true/);

  fs.writeFileSync(auditPath, JSON.stringify({ repositories: [], inventory: [], findings: [], complete: false }));
  const incomplete = runScript("merge-policy-audit.sh", "record-counts", environment);
  assert.notEqual(incomplete.status, 0);
  assert.match(fs.readFileSync(summaryPath, "utf8"), /merge-gate status is unknown/);
});

const revalidateRepositories = [
  { repository: "Ambiguous-Interactive/example-a", defaultBranch: "main" },
  { repository: "Ambiguous-Interactive/example-b", defaultBranch: "main" }
];

function headRevalidationHarness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-head-revalidate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shims = path.join(root, "shims");
  const runnerTemp = path.join(root, "runner-temp");
  fs.mkdirSync(shims);
  fs.mkdirSync(runnerTemp);
  fs.mkdirSync(path.join(root, ".policy-consumers", "example-a", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, ".policy-consumers", "example-b", ".git"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "unity-enrollment-policy.json"),
    JSON.stringify({ repositories: revalidateRepositories })
  );
  const heads = path.join(root, "heads.tsv");
  const current = path.join(root, "current.tsv");
  const events = path.join(root, "events.log");
  const counter = path.join(root, "counter");
  const analyzeFixture = path.join(root, "analyze-fixture.json");
  const auditPath = path.join(root, "audit.json");
  fs.writeFileSync(heads, "example-a\taaa\nexample-b\tbbb\n");
  fs.writeFileSync(current, [
    "Ambiguous-Interactive/example-a\taaa",
    "Ambiguous-Interactive/example-b\tbbb"
  ].join("\n"));
  fs.writeFileSync(counter, "0");
  const analyzeFixtureContent = {
    complete: true,
    repositories: [
      { repository: "Ambiguous-Interactive/example-a", sha: "aaa" },
      { repository: "Ambiguous-Interactive/example-b", sha: "bbb" }
    ],
    inventory: [],
    findings: []
  };
  if (options.analyzeFindings) {
    analyzeFixtureContent.findings.push({
      repository: "Ambiguous-Interactive/example-a",
      sha: "aaa",
      code: "unapproved-lock-ref",
      path: ".github/workflows/unity.yml",
      job: "unity"
    });
  }
  fs.writeFileSync(analyzeFixture, JSON.stringify(analyzeFixtureContent));
  fs.writeFileSync(auditPath, fs.readFileSync(analyzeFixture, "utf8"));

  writeExecutable(path.join(shims, "git"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then',
    '  name="$(basename "$2")"',
    '  printf \'git %s\\n\' "${name}" >> "${TEST_EVENTS}"',
    '  sha="$(awk -F\'\\t\' -v n="${name}" \'$1 == n { print $2; found = 1 } END { if (!found) exit 1 }\' "${TEST_HEADS}")"',
    '  printf \'%s\\n\' "${sha}"',
    "  exit 0",
    "fi",
    "exit 64"
  ].join("\n"));
  writeExecutable(path.join(shims, "gh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'if [ "$1" = "api" ]; then',
    '  ref="$(printf \'%s\' "$2" | sed -n \'s|^repos/\\([^/]*/[^/]*\\)/git/ref/heads/.*$|\\1|p\')"',
    '  if [ "${TEST_API_STATUS:-0}" != "0" ]; then',
    '    exit "${TEST_API_STATUS}"',
    "  fi",
    '  if [ "${TEST_API_ADVANCE:-0}" = "1" ] && [ "${ref}" = "${TEST_ADVANCE_REPO}" ]; then',
    '    count="$(( $(cat "${TEST_COUNTER}") + 1 ))"',
    '    printf \'%s\' "${count}" > "${TEST_COUNTER}"',
    '    sha="push${count}"',
    '    awk -F\'\\t\' -v r="${ref}" -v s="${sha}" \'BEGIN { OFS = "\\t" } $1 == r { print $1, s; next } { print }\' "${TEST_CURRENT}" > "${TEST_CURRENT}.next"',
    '    mv "${TEST_CURRENT}.next" "${TEST_CURRENT}"',
    "  else",
    '    sha="$(awk -F\'\\t\' -v n="${ref}" \'$1 == n { print $2; found = 1 } END { if (!found) exit 1 }\' "${TEST_CURRENT}")"',
    "  fi",
    '  printf \'api %s %s\\n\' "${ref}" "${sha}" >> "${TEST_EVENTS}"',
    '  printf \'%s\\n\' "${sha}"',
    "  exit 0",
    "fi",
    'if [ "$1" = "repo" ] && [ "$2" = "clone" ]; then',
    '  printf \'clone %s\\n\' "$3" >> "${TEST_EVENTS}"',
    '  mkdir -p "$4/.git"',
    '  sha="$(awk -F\'\\t\' -v n="$3" \'$1 == n { print $2; found = 1 } END { if (!found) exit 1 }\' "${TEST_CURRENT}")"',
    '  awk -F\'\\t\' -v n="$(basename "$4")" -v s="${sha}" \'BEGIN { OFS = "\\t" } $1 == n { print $1, s; next } { print }\' "${TEST_HEADS}" > "${TEST_HEADS}.next"',
    '  mv "${TEST_HEADS}.next" "${TEST_HEADS}"',
    "  exit 0",
    "fi",
    "exit 64"
  ].join("\n"));
  writeExecutable(path.join(shims, "go"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'if [ "$1" = "run" ] && [ "$2" = "./cmd/audit-unity-enrollment" ]; then',
    '  printf \'analyze\\n\' >> "${TEST_EVENTS}"',
    '  output=""',
    '  previous=""',
    '  for argument in "$@"; do',
    '    if [ "${previous}" = "--output" ]; then output="${argument}"; fi',
    '    previous="${argument}"',
    "  done",
    '  if [ -z "${output}" ]; then exit 64; fi',
    '  cat "${TEST_ANALYZE_FIXTURE}" > "${output}"',
    '  if [ "$(jq -r \'.complete // false\' "${output}")" = "true" ] &&',
    '     [ "$(jq -r \'.findings | length\' "${output}")" = "0" ]; then',
    "    exit 0",
    "  fi",
    "  exit 1",
    "fi",
    "exit 64"
  ].join("\n"));

  return {
    root,
    heads,
    current,
    events,
    auditPath,
    environment: {
      PATH: `${shims}:${process.env.PATH}`,
      RUNNER_TEMP: runnerTemp,
      AUDIT_PATH: auditPath,
      READER_AUTHORIZATION: "test-reader-token",
      TEST_HEADS: heads,
      TEST_CURRENT: current,
      TEST_EVENTS: events,
      TEST_COUNTER: counter,
      TEST_ANALYZE_FIXTURE: analyzeFixture,
      TEST_API_STATUS: options.apiStatus === undefined ? "0" : String(options.apiStatus),
      TEST_API_ADVANCE: options.advance ? "1" : "0",
      TEST_ADVANCE_REPO: "Ambiguous-Interactive/example-a"
    }
  };
}

function runHeadRevalidation(harness) {
  return childProcess.spawnSync(
    "bash",
    [path.join(scriptsRoot, "unity-enrollment-audit.sh"), "revalidate-heads"],
    { cwd: harness.root, encoding: "utf8", env: { ...process.env, ...harness.environment } }
  );
}

function readHeadRevalidationEvents(harness) {
  return fs.readFileSync(harness.events, "utf8").split("\n").filter(Boolean);
}

test("head revalidation passes without refresh when every head matches", (t) => {
  const harness = headRevalidationHarness(t);
  const result = runHeadRevalidation(harness);
  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(fs.readFileSync(harness.auditPath, "utf8"));
  assert.equal(audit.complete, true);
  assert.deepEqual(audit.findings, []);
  assert.deepEqual(readHeadRevalidationEvents(harness).filter((event) => /^(clone|analyze)/.test(event)), []);
});

test("head revalidation re-clones and re-analyzes a snapshot whose branch advanced mid-run", (t) => {
  const harness = headRevalidationHarness(t);
  fs.writeFileSync(harness.current, [
    "Ambiguous-Interactive/example-a\tccc",
    "Ambiguous-Interactive/example-b\tbbb"
  ].join("\n"));

  const result = runHeadRevalidation(harness);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /refreshing the stale snapshots/);
  const audit = JSON.parse(fs.readFileSync(harness.auditPath, "utf8"));
  assert.equal(audit.complete, true);
  assert.deepEqual(audit.findings, []);
  assert.match(fs.readFileSync(harness.heads, "utf8"), /^example-a\tccc$/m);
  assert.deepEqual(readHeadRevalidationEvents(harness).filter((event) => /^(clone|analyze)/.test(event)), [
    "clone Ambiguous-Interactive/example-a",
    "analyze"
  ]);
});

test("head revalidation recovers even when the re-analysis reports consumer findings", (t) => {
  const harness = headRevalidationHarness(t, { analyzeFindings: true });
  fs.writeFileSync(harness.current, [
    "Ambiguous-Interactive/example-a\tccc",
    "Ambiguous-Interactive/example-b\tbbb"
  ].join("\n"));

  const result = runHeadRevalidation(harness);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /refreshing the stale snapshots/);
  const audit = JSON.parse(fs.readFileSync(harness.auditPath, "utf8"));
  assert.equal(audit.complete, true);
  assert.deepEqual(audit.findings, [{
    repository: "Ambiguous-Interactive/example-a",
    sha: "aaa",
    code: "unapproved-lock-ref",
    path: ".github/workflows/unity.yml",
    job: "unity"
  }]);
});

test("head revalidation fails closed when a branch keeps advancing past every refresh", (t) => {
  const harness = headRevalidationHarness(t, { advance: true });

  const result = runHeadRevalidation(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fails closed/);
  const audit = JSON.parse(fs.readFileSync(harness.auditPath, "utf8"));
  assert.equal(audit.complete, false);
  assert.deepEqual(audit.findings, [{
    repository: "Ambiguous-Interactive/example-a",
    sha: "push2",
    code: "default-branch-advanced"
  }]);
  const events = readHeadRevalidationEvents(harness);
  assert.equal(events.filter((event) => event.startsWith("clone ")).length, 2);
  assert.equal(events.filter((event) => event === "analyze").length, 2);
});

test("head revalidation fails closed when the head read keeps failing", (t) => {
  const harness = headRevalidationHarness(t, { apiStatus: 1 });

  const result = runHeadRevalidation(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fails closed/);
  const audit = JSON.parse(fs.readFileSync(harness.auditPath, "utf8"));
  assert.equal(audit.complete, false);
  assert.equal(audit.findings.length, 2);
  assert.ok(audit.findings.every((finding) => finding.code === "default-branch-revalidation-incomplete"));
  assert.deepEqual(
    audit.findings.map((finding) => finding.repository).sort(),
    ["Ambiguous-Interactive/example-a", "Ambiguous-Interactive/example-b"]
  );
});

test("consumer repin rewrites only lock action references and refuses unauthorized targets", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-consumer-locks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflows = path.join(root, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  const oldSha = "300501e91c9bec81bb9b5a977c22aa5bb2d9b649";
  const target = "64bac446903115134dca8235410b332bc5a83547";
  fs.writeFileSync(
    path.join(workflows, "unity.yml"),
    [
      "jobs:",
      "  unity:",
      "    steps:",
      `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${oldSha} # v1.13.0`,
      `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/return-unity-license@${oldSha}`,
      `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/release-build-lock@${target} # v1.14.0`,
      `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/require-current-pr-head@${target}`,
      `      - uses: actions/checkout@${oldSha}`,
      `      - run: echo 'Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/release-build-lock@${oldSha}'`,
      `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/classify-unity-changes@168b8dea5351f1cc448ed499e354cb31ad64ef10 # post-v1.10.0`,
      ""
    ].join("\n")
  );
  const runRewrite = (...args) =>
    childProcess.spawnSync(
      "bash",
      [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, ...args],
      { cwd: repoRoot, encoding: "utf8" }
    );

  const result = runRewrite(target, "v1.14.0", "Ambiguous-Interactive/unity-helpers");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    changed: 3,
    files: [{ path: path.join(".github", "workflows", "unity.yml"), lines: 3 }],
    skipped: [],
    unmatched: [],
    companions: [],
    unmatchedCompanions: []
  });

  const lines = fs.readFileSync(path.join(workflows, "unity.yml"), "utf8").split("\n");
  assert.equal(
    lines[3],
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${target} # v1.14.0`
  );
  assert.equal(
    lines[4],
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/return-unity-license@${target} # v1.14.0`,
    "a moved pin without a comment gains the release version comment"
  );
  assert.equal(
    lines[5],
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/release-build-lock@${target} # v1.14.0`
  );
  assert.equal(
    lines[6],
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/require-current-pr-head@${target}`,
    "a pin already at the target keeps its reviewed shape; comments attach only to moved pins"
  );
  assert.equal(lines[7], `      - uses: actions/checkout@${oldSha}`);
  assert.equal(lines[8], `      - run: echo 'Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/release-build-lock@${oldSha}'`);
  assert.equal(
    lines[9],
    "      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/classify-unity-changes@64bac446903115134dca8235410b332bc5a83547 # post-v1.10.0",
    "a reviewed witness comment survives a pin move untouched"
  );

  const rerun = runRewrite(target, "v1.14.0", "Ambiguous-Interactive/unity-helpers");
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.deepEqual(JSON.parse(rerun.stdout), {
    changed: 0,
    files: [],
    skipped: [],
    unmatched: [],
    companions: [],
    unmatchedCompanions: []
  });

  const unapproved = runRewrite("0".repeat(40), "v0.0.0", "Ambiguous-Interactive/unity-helpers");
  assert.equal(unapproved.status, 1);
  assert.match(unapproved.stderr, /not authorized in both allowlists/);

  const malformed = runRewrite("64bac446", "v1.14.0", "Ambiguous-Interactive/unity-helpers");
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /40-character commit SHA/);
});

test("moved pin comments follow the disposition matrix for every comment and version shape", (t) => {
  // Each case is one moved pin under one target version. The scheduled
  // resolver only emits `vX.Y.Z` tags; the empty version proves the rewrite
  // never deletes a reviewed label when the tag is unknown, and the
  // malformed version proves the version comment stays a machine-readable
  // contract.
  const oldSha = "300501e91c9bec81bb9b5a977c22aa5bb2d9b649";
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const prefix = "      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@";
  const cases = [
    { comment: "", version: "v1.14.0", expected: `${target} # v1.14.0` },
    { comment: " # v1.13.0", version: "v1.14.0", expected: `${target} # v1.14.0` },
    { comment: " # post-v1.10.0", version: "v1.14.0", expected: `${target} # post-v1.10.0` },
    { comment: "", version: "", expected: `${target}` },
    { comment: " # v1.13.0", version: "", expected: `${target} # v1.13.0` },
    { comment: " # post-v1.10.0", version: "", expected: `${target} # post-v1.10.0` }
  ];
  for (const testCase of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-comments-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workflows = path.join(root, ".github", "workflows");
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(
      path.join(workflows, "unity.yml"),
      `${prefix}${oldSha}${testCase.comment}\n`
    );
    const result = childProcess.spawnSync(
      "bash",
      [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, testCase.version, "Ambiguous-Interactive/unity-helpers"],
      { cwd: repoRoot, encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(path.join(workflows, "unity.yml"), "utf8"),
      `${prefix}${testCase.expected}\n`,
      `comment ${JSON.stringify(testCase.comment)} at version ${JSON.stringify(testCase.version)}`
    );
  }

  const injection = fs.mkdtempSync(path.join(os.tmpdir(), "repin-comments-"));
  t.after(() => fs.rmSync(injection, { recursive: true, force: true }));
  const workflows = path.join(injection, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  fs.writeFileSync(path.join(workflows, "unity.yml"), `${prefix}${oldSha}\n`);
  const hostile = childProcess.spawnSync(
    "bash",
    [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", injection, target, "v1.14.0\nrun: exploit", "Ambiguous-Interactive/unity-helpers"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert.equal(hostile.status, 1);
  assert.match(hostile.stderr, /vMAJOR\.MINOR\.PATCH target version/);
  assert.equal(
    fs.readFileSync(path.join(workflows, "unity.yml"), "utf8"),
    `${prefix}${oldSha}\n`,
    "a fail-closed run leaves the pin untouched"
  );
});

test("consumer repin preserves reviewed compatibility exceptions and fails closed on expiry", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-exceptions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = "300501e91c9bec81bb9b5a977c22aa5bb2d9b649";
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const legacyPin = `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/return-unity-license@${oldSha}`;
  const writeWorkflow = (repository, name, pinLine) => {
    const workflows = path.join(root, "consumers", repository, ".github", "workflows");
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, name), [pinLine, ""].join("\n"));
  };
  // The legacy wrapper shape from issue 233: a caller whose input contract
  // cannot satisfy the newer classifier, protected by a reviewed exception.
  writeWorkflow("unity-helpers", "legacy-return.yml", legacyPin);
  writeWorkflow("unity-helpers", "native.yml", legacyPin);
  writeWorkflow("dxmessaging", "legacy-return.yml", legacyPin);
  const baseException = {
    repository: "Ambiguous-Interactive/unity-helpers",
    path: ".github/workflows/legacy-return.yml",
    reason: "The wrapper cannot supply the return-log-digest input.",
    owner: "unity-helpers-maintainers",
    expiresAt: "2099-01-01T00:00:00Z"
  };
  const writePolicy = (repinExceptions) => {
    const policyPath = path.join(root, "policy.json");
    fs.writeFileSync(policyPath, JSON.stringify({
      schemaVersion: 1,
      organization: "Ambiguous-Interactive",
      approvedLockShas: [oldSha, target],
      approvedReturnShas: [target],
      approvedDarwinReturnShas: [],
      repositories: [
        { repository: "Ambiguous-Interactive/unity-helpers" },
        { repository: "Ambiguous-Interactive/dxmessaging" }
      ],
      exceptions: [],
      repinExceptions
    }));
    return policyPath;
  };
  const runRewrite = (repository, policyPath) =>
    childProcess.spawnSync(
      "bash",
      [
        path.join(scriptsRoot, "repin-consumer-locks.sh"),
        "rewrite-pins",
        path.join(root, "consumers", repository),
        target,
        "v1.14.0",
        `Ambiguous-Interactive/${repository}`
      ],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: policyPath } }
    );

  const preserved = runRewrite("unity-helpers", writePolicy([baseException]));
  assert.equal(preserved.status, 0, preserved.stderr);
  assert.deepEqual(JSON.parse(preserved.stdout), {
    changed: 1,
    files: [{ path: path.join(".github", "workflows", "native.yml"), lines: 1 }],
    skipped: [
      {
        path: path.join(".github", "workflows", "legacy-return.yml"),
        owner: "unity-helpers-maintainers",
        expiresAt: "2099-01-01T00:00:00Z"
      }
    ],
    unmatched: [],
    companions: [],
    unmatchedCompanions: []
  });
  assert.equal(
    fs.readFileSync(path.join(root, "consumers", "unity-helpers", ".github", "workflows", "legacy-return.yml"), "utf8"),
    `${legacyPin}\n`
  );
  assert.match(
    fs.readFileSync(path.join(root, "consumers", "unity-helpers", ".github", "workflows", "native.yml"), "utf8"),
    new RegExp(`return-unity-license@${target}`)
  );

  // The exception is scoped to one repository; other consumers still repin.
  const otherRepository = runRewrite("dxmessaging", writePolicy([baseException]));
  assert.equal(otherRepository.status, 0, otherRepository.stderr);
  assert.deepEqual(JSON.parse(otherRepository.stdout), {
    changed: 1,
    files: [{ path: path.join(".github", "workflows", "legacy-return.yml"), lines: 1 }],
    skipped: [],
    unmatched: [],
    companions: [],
    unmatchedCompanions: []
  });

  // An exception whose file no longer exists is visible, not fatal.
  const orphaned = { ...baseException, path: ".github/workflows/deleted-wrapper.yml" };
  const unmatched = runRewrite("unity-helpers", writePolicy([baseException, orphaned]));
  assert.equal(unmatched.status, 0, unmatched.stderr);
  assert.deepEqual(JSON.parse(unmatched.stdout).unmatched, [
    {
      path: path.join(".github", "workflows", "deleted-wrapper.yml"),
      owner: "unity-helpers-maintainers",
      expiresAt: "2099-01-01T00:00:00Z"
    }
  ]);

  const fatalCases = [
    {
      name: "expired",
      entries: [{ ...baseException, expiresAt: "2000-01-01T00:00:00Z" }],
      stderr: /expired at 2000-01-01T00:00:00Z; renew or remove it before repinning/
    },
    {
      name: "path outside workflows",
      entries: [{ ...baseException, path: "scripts/legacy-return.yml" }],
      stderr: /normalized workflow path/
    },
    {
      name: "non-RFC3339 expiry",
      entries: [{ ...baseException, expiresAt: "2099-01-01" }],
      stderr: /RFC3339 expiry/
    },
    {
      name: "duplicate entry",
      entries: [baseException, { ...baseException }],
      stderr: /duplicate repository\/path repinExceptions entry/
    },
    {
      name: "malformed entry for another repository",
      entries: [baseException, { ...baseException, repository: "Ambiguous-Interactive/dxmessaging", path: "bogus" }],
      stderr: /normalized workflow path/
    },
    {
      name: "non-canonical repository spelling",
      entries: [{ ...baseException, repository: "Ambiguous-Interactive/UNITY-HELPERS" }],
      stderr: /registered canonical repository spelling/
    },
    {
      name: "unregistered repository",
      entries: [{ ...baseException, repository: "Ambiguous-Interactive/not-enrolled" }],
      stderr: /registered canonical repository spelling/
    },
    {
      name: "backtick in owner",
      entries: [{ ...baseException, owner: "`owner`" }],
      stderr: /single-line owner and reason/
    }
  ];
  for (const fatalCase of fatalCases) {
    const result = runRewrite("unity-helpers", writePolicy(fatalCase.entries));
    assert.equal(result.status, 1, `${fatalCase.name}: expected failure, got ${result.status}`);
    assert.match(result.stderr, fatalCase.stderr, fatalCase.name);
  }
});

test("consumer repin carries reviewed companion artifacts through mode-bound rewrites", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-companions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = repinOldSha;
  const target = "64bac446903115134dca8235410b332bc5a83547";
  // Authorized in the policy but pinned nowhere: a companion literal that
  // must survive as a historical witness, exactly like qora-redux's
  // wrong-but-plausible superseded commit.
  const witnessSha = "0854a7d586640e5d12e3559d789c481c232ed044";
  const workflows = path.join(root, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  fs.writeFileSync(
    path.join(workflows, "unity.yml"),
    [
      "jobs:",
      "  unity:",
      "    steps:",
      `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${oldSha} # v1.0.0`,
      ""
    ].join("\n")
  );
  fs.mkdirSync(path.join(root, "docs", "ops"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "docs", "ops", "pin-doc.md"),
    [
      "## Example",
      "",
      "- uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@" +
        `${oldSha} # v1.0.0`,
      ""
    ].join("\n")
  );
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tests", "pin-contract.js"),
    [
      `const policyCommit = "${oldSha}";`,
      `const supersededCommit = "${witnessSha}";`,
      ""
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(root, "policy-snapshot.json"),
    JSON.stringify({
      schemaVersion: 1,
      organization: "Ambiguous-Interactive",
      approvedLockShas: [oldSha],
      approvedReturnShas: [oldSha]
    }) + "\n"
  );
  const policyPath = path.join(root, "policy.json");
  const writePolicy = (repinCompanions, mutate) => {
    const policy = {
      schemaVersion: 1,
      organization: "Ambiguous-Interactive",
      approvedLockShas: [oldSha, witnessSha, target],
      approvedReturnShas: [target],
      approvedDarwinReturnShas: [],
      repositories: [{ repository: "Ambiguous-Interactive/unity-helpers" }],
      exceptions: [],
      repinExceptions: [],
      repinCompanions
    };
    if (mutate) {
      mutate(policy);
    }
    fs.writeFileSync(policyPath, JSON.stringify(policy));
    return policyPath;
  };
  const runRewrite = (policyCompanions, mutate) =>
    childProcess.spawnSync(
      "bash",
      [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: writePolicy(policyCompanions, mutate) } }
    );

  const result = runRewrite([
    { repository: "Ambiguous-Interactive/unity-helpers", path: "docs/ops/pin-doc.md", mode: "pin-lines" },
    { repository: "Ambiguous-Interactive/unity-helpers", path: "tests/pin-contract.js", mode: "pin-literal" },
    { repository: "Ambiguous-Interactive/unity-helpers", path: "policy-snapshot.json", mode: "policy-snapshot" },
    { repository: "Ambiguous-Interactive/unity-helpers", path: "docs/ops/deleted-companion.md", mode: "pin-lines" }
  ]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report, {
    changed: 4,
    files: [{ path: ".github/workflows/unity.yml", lines: 1 }],
    skipped: [],
    unmatched: [],
    companions: [
      { path: "docs/ops/pin-doc.md", mode: "pin-lines", lines: 1 },
      { path: "tests/pin-contract.js", mode: "pin-literal", lines: 1 },
      { path: "policy-snapshot.json", mode: "policy-snapshot", lines: 1 }
    ],
    unmatchedCompanions: [
      { path: "docs/ops/deleted-companion.md", mode: "pin-lines" }
    ]
  });
  assert.equal(
    fs.readFileSync(path.join(root, "docs", "ops", "pin-doc.md"), "utf8"),
    [
      "## Example",
      "",
      `- uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${target} # v1.14.0`,
      ""
    ].join("\n")
  );
  assert.equal(
    fs.readFileSync(path.join(root, "tests", "pin-contract.js"), "utf8"),
    [`const policyCommit = "${target}";`, `const supersededCommit = "${witnessSha}";`, ""].join("\n")
  );
  assert.equal(
    fs.readFileSync(path.join(root, "policy-snapshot.json"), "utf8"),
    `${JSON.stringify({
      schemaVersion: 1,
      organization: "Ambiguous-Interactive",
      approvedLockShas: [oldSha, witnessSha, target],
      approvedReturnShas: [target],
      approvedDarwinReturnShas: []
    }, null, 2)}\n`
  );

  // The rewrite is idempotent once every pin and companion is current.
  const rerun = runRewrite([
    { repository: "Ambiguous-Interactive/unity-helpers", path: "docs/ops/pin-doc.md", mode: "pin-lines" },
    { repository: "Ambiguous-Interactive/unity-helpers", path: "tests/pin-contract.js", mode: "pin-literal" },
    { repository: "Ambiguous-Interactive/unity-helpers", path: "policy-snapshot.json", mode: "policy-snapshot" },
    { repository: "Ambiguous-Interactive/unity-helpers", path: "docs/ops/deleted-companion.md", mode: "pin-lines" }
  ]);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(JSON.parse(rerun.stdout).changed, 0);

  const invalidPolicies = [
    {
      name: "unknown mode",
      companions: [{ repository: "Ambiguous-Interactive/unity-helpers", path: "docs/ops/pin-doc.md", mode: "rewrite-everything" }],
      stderr: /reviewed mechanical mode/
    },
    {
      name: "empty mode",
      companions: [{ repository: "Ambiguous-Interactive/unity-helpers", path: "docs/ops/pin-doc.md", mode: "" }],
      stderr: /reviewed mechanical mode/
    },
    {
      name: "path inside .github",
      companions: [{ repository: "Ambiguous-Interactive/unity-helpers", path: ".github/pin-doc.md", mode: "pin-lines" }],
      stderr: /outside \.github/
    },
    {
      name: "escaping path",
      companions: [{ repository: "Ambiguous-Interactive/unity-helpers", path: "docs/../pin-doc.md", mode: "pin-lines" }],
      stderr: /normalized repository-relative path/
    },
    {
      name: "windows path",
      companions: [{ repository: "Ambiguous-Interactive/unity-helpers", path: "docs\\pin-doc.md", mode: "pin-lines" }],
      stderr: /normalized repository-relative path/
    },
    {
      name: "absolute path",
      companions: [{ repository: "Ambiguous-Interactive/unity-helpers", path: "/docs/pin-doc.md", mode: "pin-lines" }],
      stderr: /normalized repository-relative path/
    },
    {
      name: "option-like path",
      companions: [{ repository: "Ambiguous-Interactive/unity-helpers", path: "-docs/pin-doc.md", mode: "pin-lines" }],
      stderr: /normalized repository-relative path/
    },
    {
      name: "backtick path",
      companions: [{ repository: "Ambiguous-Interactive/unity-helpers", path: "docs/pin`doc.md", mode: "pin-lines" }],
      stderr: /normalized repository-relative path/
    },
    {
      name: "non-canonical repository",
      companions: [{ repository: "Ambiguous-Interactive/UNITY-HELPERS", path: "docs/ops/pin-doc.md", mode: "pin-lines" }],
      stderr: /registered canonical repository spelling/
    },
    {
      name: "unregistered repository",
      companions: [{ repository: "Ambiguous-Interactive/not-enrolled", path: "docs/ops/pin-doc.md", mode: "pin-lines" }],
      stderr: /registered canonical repository spelling/
    },
    {
      name: "duplicate repository/path entry",
      companions: [
        { repository: "Ambiguous-Interactive/unity-helpers", path: "docs/ops/pin-doc.md", mode: "pin-lines" },
        { repository: "Ambiguous-Interactive/unity-helpers", path: "docs/ops/pin-doc.md", mode: "pin-literal" }
      ],
      stderr: /duplicate repository\/path repinCompanions entry/
    },
    {
      name: "unknown entry field",
      companions: [
        { repository: "Ambiguous-Interactive/unity-helpers", path: "docs/ops/pin-doc.md", mode: "pin-lines", extra: true }
      ],
      stderr: /unknown repinCompanions entry field/
    },
    {
      name: "unknown repinExceptions entry field",
      companions: [],
      mutatePolicy: (policy) => {
        policy.repinExceptions = [{
          repository: "Ambiguous-Interactive/unity-helpers",
          path: ".github/workflows/unity.yml",
          reason: "r",
          owner: "o",
          expiresAt: "2099-01-01T00:00:00Z",
          extra: true
        }];
      },
      stderr: /unknown repinExceptions entry field/
    },
    {
      name: "string schemaVersion",
      companions: [],
      mutatePolicy: (policy) => {
        policy.schemaVersion = "1";
      },
      stderr: /schemaVersion 1/
    },
    {
      name: "wrong organization",
      companions: [],
      mutatePolicy: (policy) => {
        policy.organization = "NotAmbiguous";
      },
      stderr: /reviewed policy organization/
    },
    {
      name: "unknown approved allowlist key",
      companions: [
        { repository: "Ambiguous-Interactive/unity-helpers", path: "policy-snapshot.json", mode: "policy-snapshot" }
      ],
      mutatePolicy: (policy) => {
        policy.approvedExtraShas = ["totally-unreviewed-value"];
      },
      stderr: /unknown policy field/
    }
  ];
  for (const invalidPolicy of invalidPolicies) {
    const invalid = runRewrite(invalidPolicy.companions, invalidPolicy.mutatePolicy);
    assert.equal(invalid.status, 1, `${invalidPolicy.name}: expected failure, got ${invalid.status}`);
    assert.match(invalid.stderr, invalidPolicy.stderr, invalidPolicy.name);
  }
});

test("consumer repin fails closed on a stale pin-literal companion and survives hex witnesses", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-companions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = repinOldSha;
  const target = "64bac446903115134dca8235410b332bc5a83547";
  // Authorized in the policy but pinned nowhere: a historical witness that a
  // mechanical rewrite must never corrupt, embedded here inside a longer hex
  // constant exactly like a concatenated digest would embed it.
  const witnessSha = "0854a7d586640e5d12e3559d789c481c232ed044";
  const workflows = path.join(root, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  fs.writeFileSync(
    path.join(workflows, "unity.yml"),
    [
      "jobs:",
      "  unity:",
      "    steps:",
      `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${target}`,
      ""
    ].join("\n")
  );
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tests", "pin-contract.js"),
    [
      `const policyCommit = "${oldSha}";`,
      `const witnessDigest = "9f${witnessSha}aa11";`,
      ""
    ].join("\n")
  );
  const writePolicy = () => {
    fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify({
      schemaVersion: 1,
      organization: "Ambiguous-Interactive",
      approvedLockShas: [oldSha, witnessSha, target],
      approvedReturnShas: [target],
      approvedDarwinReturnShas: [],
      repositories: [{ repository: "Ambiguous-Interactive/unity-helpers" }],
      exceptions: [],
      repinExceptions: [],
      repinCompanions: [
        { repository: "Ambiguous-Interactive/unity-helpers", path: "tests/pin-contract.js", mode: "pin-literal" }
      ]
    }));
  };
  writePolicy();
  const runRewrite = () =>
    childProcess.spawnSync(
      "bash",
      [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: path.join(root, "policy.json") } }
    );

  // The workflows already pin the target, so no pin was removed and the
  // companion still names only the stale pin. A mechanical rewrite cannot
  // tell a stale pin constant from a reviewed witness; the run must fail
  // closed instead of reporting a green "already pinned" row.
  const divergent = runRewrite();
  assert.equal(divergent.status, 1, `expected failure, got ${divergent.status}: ${divergent.stdout}`);
  assert.match(divergent.stderr, /stale pin constant from a reviewed witness/);
  assert.equal(
    fs.readFileSync(path.join(root, "tests", "pin-contract.js"), "utf8"),
    [`const policyCommit = "${oldSha}";`, `const witnessDigest = "9f${witnessSha}aa11";`, ""].join("\n"),
    "a fail-closed run leaves the companion untouched"
  );

  // A healed companion names the target as its pin constant beside the
  // witness; the same no-pin-removed rerun stays green and idempotent.
  fs.writeFileSync(
    path.join(root, "tests", "pin-contract.js"),
    [`const policyCommit = "${target}";`, `const witnessDigest = "9f${witnessSha}aa11";`, ""].join("\n")
  );
  const healed = runRewrite();
  assert.equal(healed.status, 0, healed.stderr);
  assert.equal(JSON.parse(healed.stdout).changed, 0);

  // Once a workflow pin is removed, the same companion updates its standalone
  // pin constant while the hex-embedded witness digest survives untouched.
  fs.writeFileSync(
    path.join(workflows, "unity.yml"),
    [
      "jobs:",
      "  unity:",
      "    steps:",
      `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${oldSha}`,
      ""
    ].join("\n")
  );
  const atomic = runRewrite();
  assert.equal(atomic.status, 0, atomic.stderr);
  assert.equal(
    fs.readFileSync(path.join(root, "tests", "pin-contract.js"), "utf8"),
    [`const policyCommit = "${target}";`, `const witnessDigest = "9f${witnessSha}aa11";`, ""].join("\n")
  );
});

test("consumer repin refuses a companion that is not a regular file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-companions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const workflows = path.join(root, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  fs.writeFileSync(
    path.join(workflows, "unity.yml"),
    `- uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${repinOldSha}\n`
  );
  const outside = path.join(root, "outside-secret.txt");
  fs.writeFileSync(outside, "untouched\n");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "docs", "snap.json"));
  fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify({
    schemaVersion: 1,
    organization: "Ambiguous-Interactive",
    approvedLockShas: [repinOldSha, target],
    approvedReturnShas: [target],
    approvedDarwinReturnShas: [],
    repositories: [{ repository: "Ambiguous-Interactive/unity-helpers" }],
    exceptions: [],
    repinExceptions: [],
    repinCompanions: [
      { repository: "Ambiguous-Interactive/unity-helpers", path: "docs/snap.json", mode: "policy-snapshot" }
    ]
  }));
  const result = childProcess.spawnSync(
    "bash",
    [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: path.join(root, "policy.json") } }
  );
  assert.equal(result.status, 1, `expected failure, got ${result.status}: ${result.stdout}`);
  assert.match(result.stderr, /not a regular file/);
  assert.equal(fs.readFileSync(outside, "utf8"), "untouched\n", "the write never escapes the checkout");
});
const repinOldSha = "300501e91c9bec81bb9b5a977c22aa5bb2d9b649";
const repinOrganization = "Ambiguous-Interactive";

function gitRun(cwd, ...args) {
  const result = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

// A consumer remote whose default branch pins an older release. An
// "automation" state adds the repin branch a previous run pushed, and
// "advanced" moves the default branch forward after that branch existed.
// "companionFiles" seeds reviewed companion artifacts beside the workflow.
function createConsumerRemote(root, name, state, releaseSha, branchName) {
  const remotePath = path.join(root, "remote", repinOrganization, `${name}.git`);
  const seed = path.join(root, "seed", name);
  fs.mkdirSync(path.dirname(remotePath), { recursive: true });
  fs.mkdirSync(seed, { recursive: true });
  gitRun(root, "init", "--bare", "-b", "master", remotePath);
  gitRun(seed, "init", "-b", "master");
  gitRun(seed, "config", "user.name", "seed");
  gitRun(seed, "config", "user.email", "seed@example.com");
  gitRun(seed, "remote", "add", "origin", remotePath);
  const workflows = path.join(seed, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  const writePin = (sha) => fs.writeFileSync(
    path.join(workflows, "unity.yml"),
    `- uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/return-unity-license@${sha}\n`
  );
  writePin(state.atTarget ? releaseSha : repinOldSha);
  for (const [relativePath, content] of Object.entries(state.companionFiles || {})) {
    const filePath = path.join(seed, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  gitRun(seed, "add", "-A");
  gitRun(seed, "commit", "-m", "seed workflow");
  gitRun(seed, "push", "-q", "origin", "master");
  if (state.automation) {
    gitRun(seed, "checkout", "-qB", branchName);
    // A branch a current run pushed carries the release version comment the
    // rewrite normalizes onto every moved pin.
    fs.writeFileSync(
      path.join(workflows, "unity.yml"),
      `- uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/return-unity-license@${releaseSha} # v1.14.0\n`
    );
    gitRun(seed, "add", "-A");
    gitRun(seed, "commit", "-m", "chore: repin organization lock actions to v1.14.0");
    gitRun(seed, "push", "-q", "origin", branchName);
    gitRun(seed, "checkout", "-q", "master");
    if (state.advanced) {
      fs.writeFileSync(path.join(seed, "README.md"), "advanced\n");
      gitRun(seed, "add", "-A");
      gitRun(seed, "commit", "-m", "advance default after the branch existed");
      gitRun(seed, "push", "-q", "origin", "master");
    }
  }
  if (!state.automation) {
    return null;
  }
  return gitRun(remotePath, "rev-parse", `refs/heads/${branchName}`);
}

function consumerRepinHarness(t, consumerStates) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-consumers-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // A local release tag drives resolve_repin_target instead of network state.
  const targetRepository = path.join(root, "target-repository.git");
  const targetSeed = path.join(root, "target-seed");
  fs.mkdirSync(targetRepository, { recursive: true });
  fs.mkdirSync(targetSeed, { recursive: true });
  gitRun(root, "init", "--bare", "-b", "main", targetRepository);
  gitRun(targetSeed, "init", "-b", "main");
  gitRun(targetSeed, "config", "user.name", "seed");
  gitRun(targetSeed, "config", "user.email", "seed@example.com");
  gitRun(targetSeed, "remote", "add", "origin", targetRepository);
  fs.writeFileSync(path.join(targetSeed, "README.md"), "release\n");
  gitRun(targetSeed, "add", "-A");
  gitRun(targetSeed, "commit", "-m", "release v1.14.0");
  gitRun(targetSeed, "tag", "v1.14.0");
  gitRun(targetSeed, "push", "-q", "origin", "main");
  gitRun(targetSeed, "push", "-q", "origin", "refs/tags/v1.14.0");
  const releaseSha = gitRun(targetRepository, "rev-parse", "refs/tags/v1.14.0^{commit}");
  const branchName = `automation/repin-lock-${releaseSha.slice(0, 7)}`;

  const branches = new Map();
  const consumers = [];
  for (const [name, state] of Object.entries(consumerStates)) {
    branches.set(name, createConsumerRemote(root, name, state, releaseSha, branchName));
    consumers.push({ repository: `${repinOrganization}/${name}`, defaultBranch: "master" });
  }
  const policy = {
    schemaVersion: 1,
    organization: repinOrganization,
    approvedLockShas: [repinOldSha, releaseSha],
    approvedReturnShas: [releaseSha],
    approvedDarwinReturnShas: [],
    repositories: consumers,
    exceptions: []
  };
  for (const state of Object.values(consumerStates)) {
    if (state.companions) {
      policy.repinCompanions = [...(policy.repinCompanions || []), ...state.companions];
    }
  }
  const policyPath = path.join(root, "unity-enrollment-policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(policy));

  const shims = path.join(root, "shims");
  fs.mkdirSync(shims);
  const events = path.join(root, "events.log");
  const prState = path.join(root, "pr-state");
  fs.writeFileSync(events, "");
  fs.mkdirSync(prState, { recursive: true });
  for (const [name, state] of Object.entries(consumerStates)) {
    fs.mkdirSync(path.join(prState, name), { recursive: true });
    // The fixtures are the raw pull-request lists the GitHub API would
    // return; the shim applies the state and head filters and the script's
    // own --jq filter, so the ownership filter runs for real.
    const open = [];
    for (let index = 0; index < (state.openPrs || 0); index += 1) {
      open.push({ number: 700 + index, headRefName: branchName });
    }
    for (const offer of state.openOffers || []) {
      open.push({ number: offer.number, headRefName: offer.head });
    }
    const closed = [];
    for (let index = 0; index < (state.closedPrs || 0); index += 1) {
      closed.push({ number: 800 + index, headRefName: branchName });
    }
    fs.writeFileSync(path.join(prState, name, "open.json"), JSON.stringify(open));
    fs.writeFileSync(path.join(prState, name, "closed.json"), JSON.stringify(closed));
    if (state.failClose) {
      fs.writeFileSync(path.join(prState, name, "fail-close"), "1\n");
    }
    if (state.failAutoMerge) {
      fs.writeFileSync(path.join(prState, name, "fail-automerge"), "1\n");
    }
    if (state.noMergeMethods) {
      fs.writeFileSync(path.join(prState, name, "no-merge-methods"), "1\n");
    }
    if (state.mergeMethodsMergeOnly) {
      fs.writeFileSync(path.join(prState, name, "merge-methods-merge-only"), "1\n");
    }
    if (state.mergeMethodsRebaseOnly) {
      fs.writeFileSync(path.join(prState, name, "merge-methods-rebase-only"), "1\n");
    }
    if (state.malformedPrUrl) {
      fs.writeFileSync(path.join(prState, name, "malformed-pr-url"), "1\n");
    }
  }

  writeExecutable(path.join(shims, "gh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'if [ "$1" = "repo" ] && [ "$2" = "clone" ]; then',
    '  repository="$3"; directory="$4"',
    '  printf \'clone %s\\n\' "${repository}" >> "${TEST_EVENTS}"',
    '  shift 5',
    '  exec git clone "${TEST_CLONE_BASE}/${repository}.git" "${directory}" "$@"',
    "fi",
    'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then',
    '  repository=""; state="open"; head=""; jqexpr=""; limit="30"',
    '  previous=""',
    '  for argument in "$@"; do',
    '    if [ "${previous}" = "--repo" ]; then repository="${argument}"; fi',
    '    if [ "${previous}" = "--state" ]; then state="${argument}"; fi',
    '    if [ "${previous}" = "--head" ]; then head="${argument}"; fi',
    '    if [ "${previous}" = "--jq" ]; then jqexpr="${argument}"; fi',
    '    if [ "${previous}" = "--limit" ]; then limit="${argument}"; fi',
    '    previous="${argument}"',
    "  done",
    '  name="${repository#*/}"',
    '  state_file="${TEST_PR_STATE}/${name}/${state}.json"',
    '  # gh filters server-side by state and head, caps the page at 30 items,',
    '  # and rejects a non-positive --limit. String results print raw.',
    '  case "${limit}" in',
    '    "" | *[!0-9]* | 0)',
    '      printf \'invalid value for --limit: %s\\n\' "${limit}" >&2',
    "      exit 1",
    "      ;;",
    "  esac",
    '  if [ -n "${head}" ]; then',
    "    filtered='[.[] | select(.headRefName == $head)]'",
    '  else',
    "    filtered='.'",
    '  fi',
    '  jq -r --arg head "${head}" --argjson limit "${limit}" "${filtered} | .[0:$limit] | ${jqexpr}" "${state_file}"',
    "  exit 0",
    "fi",
    'if [ "$1" = "pr" ] && [ "$2" = "close" ]; then',
    '  number="$3"',
    '  repository=""; comment=""',
    '  previous=""',
    '  for argument in "$@"; do',
    '    if [ "${previous}" = "--repo" ]; then repository="${argument}"; fi',
    '    if [ "${previous}" = "--comment" ]; then comment="${argument}"; fi',
    '    previous="${argument}"',
    "  done",
    '  name="${repository#*/}"',
    '  printf \'close %s %s\\n\' "${name}" "${number}" >> "${TEST_EVENTS}"',
    '  printf \'%s\' "${comment}" > "${TEST_PR_STATE}/${name}/last-close-comment.md"',
    '  if [ -f "${TEST_PR_STATE}/${name}/fail-close" ]; then exit 1; fi',
    "  exit 0",
    "fi",
    'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
    '  head=""; title=""',
    '  repository=""',
    '  previous=""',
    '  for argument in "$@"; do',
    '    if [ "${previous}" = "--head" ]; then head="${argument}"; fi',
    '    if [ "${previous}" = "--title" ]; then title="${argument}"; fi',
    '    if [ "${previous}" = "--repo" ]; then repository="${argument}"; fi',
    '    if [ "${previous}" = "--body-file" ]; then bodyfile="${argument}"; fi',
    '    previous="${argument}"',
    "  done",
    '  printf \'create %s %s\\n\' "${head}" "${title}" >> "${TEST_EVENTS}"',
    '  name="${repository#*/}"',
    '  if [ -n "${bodyfile:-}" ]; then cp "${bodyfile}" "${TEST_PR_STATE}/${name}/last-body.md"; fi',
    '  # gh pr create prints the pull request URL on success; the script parses',
    '  # the number out of it for the auto-merge request.',
    '  counter_file="${TEST_PR_STATE}/${name}/next-pr-number"',
    '  number="$(cat "${counter_file}" 2>/dev/null || echo 899)"',
    '  number=$((number + 1))',
    '  printf \'%s\\n\' "${number}" > "${counter_file}"',
    '  # A malformed output makes the script parse a URL that matches no pull',
    '  # request, so the auto-merge request cannot read its offer identity.',
    '  if [ -f "${TEST_PR_STATE}/${name}/malformed-pr-url" ]; then',
    '    printf \'unexpected error\\n\'',
    '    exit 0',
    '  fi',
    '  printf \'https://github.com/%s/%s/pull/%s\\n\' "${repository%%/*}" "${name}" "${number}"',
    "  exit 0",
    "fi",
    'if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then',
    '  query=""; jqexpr="."; owner=""; name=""; number=""; node_id=""; merge_method=""',
    '  previous=""',
    '  for argument in "$@"; do',
    '    if [ "${previous}" = "--jq" ]; then jqexpr="${argument}"; fi',
    '    case "${previous}" in',
    '      "-f")',
    '        case "${argument}" in',
    '          query=*) query="${argument#query=}";;',
    '          owner=*) owner="${argument#owner=}";;',
    '          name=*) name="${argument#name=}";;',
    '          id=*) node_id="${argument#id=}";;',
    '          method=*) merge_method="${argument#method=}";;',
    '        esac',
    '        ;;',
    '      "-F") case "${argument}" in number=*) number="${argument#number=}";; esac ;;',
    '    esac',
    '    previous="${argument}"',
    '  done',
    '  case "${query}" in',
    '    *"pullRequest(number"*)',
    '      printf \'prid %s %s %s\\n\' "${owner}" "${name}" "${number}" >> "${TEST_EVENTS}"',
    '      # The fixtures shape the allowed-methods answer so the script\'s own',
    '      # SQUASH, MERGE, REBASE preference runs for real.',
    '      if [ -f "${TEST_PR_STATE}/${name}/no-merge-methods" ]; then',
    '        printf \'{"data":{"repository":{"pullRequest":{"id":"PR_%s_test"},"squashMergeAllowed":false,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}}}\\n\' "${name}" | jq -r "${jqexpr}"',
    '      elif [ -f "${TEST_PR_STATE}/${name}/merge-methods-merge-only" ]; then',
    '        printf \'{"data":{"repository":{"pullRequest":{"id":"PR_%s_test"},"squashMergeAllowed":false,"mergeCommitAllowed":true,"rebaseMergeAllowed":false}}}\\n\' "${name}" | jq -r "${jqexpr}"',
    '      elif [ -f "${TEST_PR_STATE}/${name}/merge-methods-rebase-only" ]; then',
    '        printf \'{"data":{"repository":{"pullRequest":{"id":"PR_%s_test"},"squashMergeAllowed":false,"mergeCommitAllowed":false,"rebaseMergeAllowed":true}}}\\n\' "${name}" | jq -r "${jqexpr}"',
    '      else',
    '        printf \'{"data":{"repository":{"pullRequest":{"id":"PR_%s_test"},"squashMergeAllowed":true,"mergeCommitAllowed":true,"rebaseMergeAllowed":false}}}\\n\' "${name}" | jq -r "${jqexpr}"',
    '      fi',
    '      ;;',
    '    *"enablePullRequestAutoMerge"*)',
    '      target_name="$(printf \'%s\' "${node_id}" | sed -n \'s/^PR_\\(.*\\)_test$/\\1/p\')"',
    '      printf \'automerge %s\\n\' "${target_name}" >> "${TEST_EVENTS}"',
    '      printf \'automerge-method %s %s\\n\' "${target_name}" "${merge_method}" >> "${TEST_EVENTS}"',
    '      if [ -f "${TEST_PR_STATE}/${target_name}/fail-automerge" ]; then',
    '        printf \'GraphQL: Auto-merge is not allowed for this repository (enablePullRequestAutoMerge)\\n\' >&2',
    '        exit 1',
    '      fi',
    '      printf \'{"data":{"enablePullRequestAutoMerge":{"pullRequest":{"number":901}}}}\\n\' | jq -r "${jqexpr}"',
    '      ;;',
    '    *)',
    '      printf \'test shim received an unexpected graphql query: %s\\n\' "${query}" >&2',
    '      exit 64',
    '  esac',
    "  exit 0",
    "fi",
    "exit 64"
  ].join("\n"));

  // Real git commands keep their production https URLs; the rewrite sends
  // them to local bare repositories so pushes, fetches, and ls-remote calls
  // exercise real Git behavior.
  const gitConfig = path.join(root, "git-config");
  fs.writeFileSync(gitConfig, [
    `[url "file://${path.join(root, "remote")}/"]`,
    "\tinsteadOf = https://github.com/"
  ].join("\n"));

  const summaryPath = path.join(root, "summary.md");
  fs.mkdirSync(path.join(root, "runner-temp"), { recursive: true });
  const remotePath = (name) => path.join(root, "remote", repinOrganization, `${name}.git`);
  return {
    root,
    events,
    branches,
    branchName,
    releaseSha,
    summaryPath,
    remotePath,
    run: () => {
      const workspace = path.join(root, "workspace");
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.mkdirSync(workspace, { recursive: true });
      fs.copyFileSync(policyPath, path.join(workspace, "unity-enrollment-policy.json"));
      gitRun(root, "init", "-q", "-b", "main", workspace);
      gitRun(workspace, "remote", "add", "origin", targetRepository);
      return childProcess.spawnSync(
        "bash",
        [path.join(scriptsRoot, "repin-consumer-locks.sh"), "repin-consumers"],
        {
          cwd: workspace,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${shims}:${process.env.PATH}`,
            GIT_CONFIG_GLOBAL: gitConfig,
            CONSUMER_AUTHORIZATION: "test-consumer-token",
            GITHUB_STEP_SUMMARY: summaryPath,
            RUNNER_TEMP: path.join(root, "runner-temp"),
            TEST_EVENTS: events,
            TEST_PR_STATE: prState,
            TEST_CLONE_BASE: `file://${path.join(root, "remote")}`
          }
        }
      );
    }
  };
}

function repinEventLog(harness) {
  return fs.readFileSync(harness.events, "utf8").split("\n").filter(Boolean);
}

test("consumer repin skips a closed repin pull request and stays green", (t) => {
  const harness = consumerRepinHarness(t, {
    "unity-helpers": { automation: true, closedPrs: 1 },
    "dxmessaging": {}
  });

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /left the closed repin pull request in place/);
  const summary = fs.readFileSync(harness.summaryPath, "utf8");
  assert.match(summary, /\| `Ambiguous-Interactive\/unity-helpers` \| repin pull request for `v1.14.0` was closed; a closed offer is never re-offered \|/);
  assert.match(summary, /\| `Ambiguous-Interactive\/dxmessaging` \| opened repin pull request to `v1.14.0` \(1 line\) \|/);
  assert.equal(
    repinEventLog(harness).filter((event) => event.startsWith("create")).length,
    1,
    "only the fresh consumer opens a pull request"
  );
  assert.equal(
    harness.branches.get("unity-helpers"),
    gitRun(harness.remotePath("unity-helpers"), "rev-parse", `refs/heads/${harness.branchName}`),
    "the consumer's repin branch is never updated"
  );
});

test("consumer repin reuses an orphaned repin branch with identical content", (t) => {
  const harness = consumerRepinHarness(t, {
    "unity-helpers": { automation: true }
  });

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  const events = repinEventLog(harness);
  assert.deepEqual(events.filter((event) => event.startsWith("create")), [
    `create ${harness.branchName} Repin organization lock actions to v1.14.0`
  ]);
  const summary = fs.readFileSync(harness.summaryPath, "utf8");
  assert.match(summary, /\| `Ambiguous-Interactive\/unity-helpers` \| opened repin pull request to `v1.14.0` from the existing branch \|/);
  assert.equal(
    harness.branches.get("unity-helpers"),
    gitRun(harness.remotePath("unity-helpers"), "rev-parse", `refs/heads/${harness.branchName}`),
    "the identical remote branch is reused without a push"
  );
});

test("consumer repin leaves a repin branch with different content untouched", (t) => {
  const harness = consumerRepinHarness(t, {
    "unity-helpers": { automation: true, advanced: true }
  });

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /left the stale repin branch untouched/);
  const summary = fs.readFileSync(harness.summaryPath, "utf8");
  assert.match(summary, /\| `Ambiguous-Interactive\/unity-helpers` \| existing repin branch has different content; left untouched \|/);
  assert.equal(repinEventLog(harness).filter((event) => event.startsWith("create")).length, 0);
  assert.equal(
    harness.branches.get("unity-helpers"),
    gitRun(harness.remotePath("unity-helpers"), "rev-parse", `refs/heads/${harness.branchName}`)
  );
});

test("consumer repin keeps the run green when auto-merge is refused", (t) => {
  const harness = consumerRepinHarness(t, {
    "dxmessaging": { failAutoMerge: true }
  });

  const result = harness.run();

  // A refused auto-merge request never fails the run and never removes the
  // offer: the merge gates stay with the consumer, and the summary row keeps
  // the gap operator-visible.
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /::warning::Ambiguous-Interactive\/dxmessaging: repin offer #[0-9]+ is open but auto-merge was not enabled/);
  assert.match(result.stderr, /Allow auto-merge/);
  const events = repinEventLog(harness);
  assert.equal(events.filter((event) => event.startsWith("create ")).length, 1);
  assert.equal(events.filter((event) => event.startsWith("automerge ")).length, 1, "the refused request is attempted once");
  const summary = fs.readFileSync(harness.summaryPath, "utf8");
  assert.match(summary, /\| `Ambiguous-Interactive\/dxmessaging` \| repin offer #[0-9]+ is open; auto-merge was not enabled \(see the job log\) \|/);
});

test("consumer repin records a repository where no merge method allows auto-merge", (t) => {
  const harness = consumerRepinHarness(t, {
    "dxmessaging": { noMergeMethods: true }
  });

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no readable identity or no allowed merge method/);
  const events = repinEventLog(harness);
  assert.equal(events.filter((event) => event.startsWith("prid ")).length, 1);
  assert.equal(events.filter((event) => event.startsWith("automerge ")).length, 0, "no mutation is sent without an allowed merge method");
  const summary = fs.readFileSync(harness.summaryPath, "utf8");
  assert.match(summary, /\| `Ambiguous-Interactive\/dxmessaging` \| repin offer #[0-9]+ is open; auto-merge was not requested \(see the job log\) \|/);
});

test("consumer repin picks the single allowed merge method on restricted repositories", async (t) => {
  const cases = [
    { fixture: "merge-methods-merge-only", state: { mergeMethodsMergeOnly: true }, method: "MERGE" },
    { fixture: "merge-methods-rebase-only", state: { mergeMethodsRebaseOnly: true }, method: "REBASE" }
  ];

  for (const testCase of cases) {
    await t.test(testCase.fixture, (subtest) => {
      const harness = consumerRepinHarness(subtest, {
        "dxmessaging": testCase.state
      });

      const result = harness.run();

      assert.equal(result.status, 0, result.stderr);
      const events = repinEventLog(harness);
      assert.equal(events.filter((event) => event.startsWith("automerge ")).length, 1, "the mutation fires once");
      assert.deepEqual(events.filter((event) => event.startsWith("automerge-method ")), [
        `automerge-method dxmessaging ${testCase.method}`
      ]);
      const summary = fs.readFileSync(harness.summaryPath, "utf8");
      assert.match(summary, /\| `Ambiguous-Interactive\/dxmessaging` \| opened repin pull request to `v1\.14\.0` \(1 line\) \|/);
    });
  }
});

test("consumer repin keeps the run green when the pull request URL is unreadable", (t) => {
  const harness = consumerRepinHarness(t, {
    "dxmessaging": { malformedPrUrl: true }
  });

  const result = harness.run();

  // A URL that matches no pull request leaves the offer open without an
  // auto-merge request: the run stays green and the summary row keeps the
  // gap operator-visible.
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /::warning::Ambiguous-Interactive\/dxmessaging: opened the repin offer but could not read its pull request URL/);
  const events = repinEventLog(harness);
  assert.equal(events.filter((event) => event.startsWith("prid ")).length, 0);
  assert.equal(events.filter((event) => event.startsWith("automerge")).length, 0);
  const summary = fs.readFileSync(harness.summaryPath, "utf8");
  assert.match(summary, /\| `Ambiguous-Interactive\/dxmessaging` \| repin offer is open; auto-merge was not requested \(see the job log\) \|/);
});

test("consumer repin pushes and opens a pull request when no branch exists", (t) => {
  const harness = consumerRepinHarness(t, { "dxmessaging": {} });

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  const events = repinEventLog(harness);
  assert.deepEqual(events.filter((event) => event.startsWith("create")), [
    `create ${harness.branchName} Repin organization lock actions to v1.14.0`
  ]);
  const pushed = gitRun(
    harness.remotePath("dxmessaging"),
    "show", `${harness.branchName}:.github/workflows/unity.yml`
  );
  assert.match(pushed, new RegExp(`return-unity-license@${harness.releaseSha}`));
  const summary = fs.readFileSync(harness.summaryPath, "utf8");
  assert.match(summary, /\| `Ambiguous-Interactive\/dxmessaging` \| opened repin pull request to `v1.14.0` \(1 line\) \|/);
});

test("consumer repin commits companion artifacts and lists them in the pull request body", (t) => {
  const harness = consumerRepinHarness(t, {
    "dxmessaging": {
      companionFiles: {
        "docs/ops/pin-doc.md": [
          "## Example",
          "",
          "  uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@" +
            `${repinOldSha} # v1.13.0`,
          "",
          "  uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/return-unity-license@" +
            `${repinOldSha}`,
          ""
        ].join("\n")
      },
      companions: [
        { repository: "Ambiguous-Interactive/dxmessaging", path: "docs/ops/pin-doc.md", mode: "pin-lines" }
      ]
    }
  });

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  const pushedDoc = gitRun(
    harness.remotePath("dxmessaging"),
    "show", `${harness.branchName}:docs/ops/pin-doc.md`
  );
  assert.match(pushedDoc, new RegExp(`acquire-build-lock@${harness.releaseSha} # v1.14.0`));
  assert.match(pushedDoc, new RegExp(`return-unity-license@${harness.releaseSha} # v1.14.0`));
  const pushedWorkflow = gitRun(
    harness.remotePath("dxmessaging"),
    "show", `${harness.branchName}:.github/workflows/unity.yml`
  );
  assert.match(pushedWorkflow, new RegExp(`return-unity-license@${harness.releaseSha}`));
  const summary = fs.readFileSync(harness.summaryPath, "utf8");
  assert.match(summary, /\| `Ambiguous-Interactive\/dxmessaging` \| opened repin pull request to `v1.14.0` \(3 lines\) \|/);
  const body = fs.readFileSync(
    path.join(harness.root, "pr-state", "dxmessaging", "last-body.md"),
    "utf8"
  );
  assert.match(body, /Reviewed companion artifacts/);
  assert.match(body, /- `docs\/ops\/pin-doc\.md` \(pin-lines\)/);
  assert.match(body, /enables auto-merge on this pull request/);
  assert.doesNotMatch(body, /never merges itself/);
});

test("consumer repin enables auto-merge on every offer it opens", (t) => {
  const harness = consumerRepinHarness(t, {
    "unity-helpers": { automation: true },
    "dxmessaging": {}
  });

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  const events = repinEventLog(harness);
  // Both open paths (fresh push and identical-branch recovery) request
  // auto-merge exactly once, immediately after the offer is created.
  assert.equal(
    events.filter((event) => event.startsWith(`create ${harness.branchName} `)).length,
    2,
    "each consumer opens one offer"
  );
  for (const name of ["unity-helpers", "dxmessaging"]) {
    const prid = events.filter((event) => event.startsWith(`prid Ambiguous-Interactive ${name} `));
    const automerge = events.filter((event) => event === `automerge ${name}`);
    assert.equal(prid.length, 1, `${name}: the offer identity is read once`);
    assert.equal(automerge.length, 1, `${name}: auto-merge is requested once`);
  }
  const summary = fs.readFileSync(harness.summaryPath, "utf8");
  assert.match(summary, /\| `Ambiguous-Interactive\/dxmessaging` \| opened repin pull request to `v1\.14\.0` \(1 line\) \|/);
});

test("consumer repin never duplicates an open pull request", (t) => {
  const harness = consumerRepinHarness(t, {
    "unity-helpers": { automation: true, openPrs: 1 }
  });

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  const summary = fs.readFileSync(harness.summaryPath, "utf8");
  assert.match(summary, /\| `Ambiguous-Interactive\/unity-helpers` \| repin pull request for `v1.14.0` is already open \|/);
  assert.equal(repinEventLog(harness).filter((event) => event.startsWith("create")).length, 0);
  // A later run never re-requests auto-merge on an existing offer, so a
  // consumer who disabled auto-merge keeps that decision.
  assert.equal(repinEventLog(harness).filter((event) => event.startsWith("automerge")).length, 0);
  assert.equal(
    harness.branches.get("unity-helpers"),
    gitRun(harness.remotePath("unity-helpers"), "rev-parse", `refs/heads/${harness.branchName}`)
  );
});

test("consumer repin closes superseded offers when the default branch already pins the target", (t) => {
  const harness = consumerRepinHarness(t, {
    "unity-helpers": {
      atTarget: true,
      openOffers: [
        // A foreign-head pull request is never the automation's offer.
        { number: 900, head: "consumer/own-work" },
        { number: 801, head: "automation/repin-lock-300501e" }
      ]
    },
    "dxmessaging": {}
  });
  // The default branch adopted the target outside the offer, so an open
  // offer for the current target is redundant too.
  const openPath = path.join(harness.root, "pr-state", "unity-helpers", "open.json");
  const open = JSON.parse(fs.readFileSync(openPath, "utf8"));
  open.push({ number: 751, headRefName: harness.branchName });
  fs.writeFileSync(openPath, JSON.stringify(open));

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(repinEventLog(harness).filter((event) => event.startsWith("close")), [
    "close unity-helpers 801",
    "close unity-helpers 751"
  ]);
  assert.deepEqual(repinEventLog(harness).filter((event) => event.startsWith("create")), [
    `create ${harness.branchName} Repin organization lock actions to v1.14.0`
  ]);
  const summary = fs.readFileSync(harness.summaryPath, "utf8");
  assert.match(summary, /\| `Ambiguous-Interactive\/unity-helpers` \| already pinned to `v1.14.0`; closed 2 superseded repin offer\(s\) \|/);
  assert.match(summary, /\| `Ambiguous-Interactive\/dxmessaging` \| opened repin pull request to `v1.14.0` \(1 line\) \|/);
  const comment = fs.readFileSync(
    path.join(harness.root, "pr-state", "unity-helpers", "last-close-comment.md"),
    "utf8"
  );
  assert.match(comment, /superseded/);
  assert.match(comment, new RegExp(harness.releaseSha));
});

test("consumer repin keeps offers open while the default branch still needs the pin", (t) => {
  const harness = consumerRepinHarness(t, {
    "unity-helpers": {
      automation: true,
      openPrs: 1,
      openOffers: [{ number: 751, head: "automation/repin-lock-300501e" }]
    }
  });

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(repinEventLog(harness).filter((event) => event.startsWith("close")).length, 0);
  const summary = fs.readFileSync(harness.summaryPath, "utf8");
  assert.match(summary, /\| `Ambiguous-Interactive\/unity-helpers` \| repin pull request for `v1.14.0` is already open \|/);
  assert.equal(
    harness.branches.get("unity-helpers"),
    gitRun(harness.remotePath("unity-helpers"), "rev-parse", `refs/heads/${harness.branchName}`)
  );
});

test("consumer repin records an already pinned repository without offers", (t) => {
  const harness = consumerRepinHarness(t, { "unity-helpers": { atTarget: true } });

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  const summary = fs.readFileSync(harness.summaryPath, "utf8");
  assert.match(summary, /\| `Ambiguous-Interactive\/unity-helpers` \| already pinned to `v1.14.0` \|/);
  assert.equal(repinEventLog(harness).filter((event) => !event.startsWith("clone")).length, 0);
});

test("consumer repin closes a superseded offer buried under newer pull requests", (t) => {
  // gh returns the newest pull requests first and caps the default page at
  // 30. The stale offer sorts behind 31 newer foreign pull requests, so the
  // scan must fetch past the default page to see it.
  const openOffers = [];
  for (let index = 0; index < 31; index += 1) {
    openOffers.push({ number: 900 + index, head: `consumer/feature-${index}` });
  }
  openOffers.push({ number: 801, head: "automation/repin-lock-300501e" });
  const harness = consumerRepinHarness(t, {
    "unity-helpers": { atTarget: true, openOffers }
  });

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(repinEventLog(harness).filter((event) => event.startsWith("close")), [
    "close unity-helpers 801"
  ]);
  const summary = fs.readFileSync(harness.summaryPath, "utf8");
  assert.match(summary, /\| `Ambiguous-Interactive\/unity-helpers` \| already pinned to `v1.14.0`; closed 1 superseded repin offer\(s\) \|/);
});

test("consumer repin fails closed when the offer scan page hits its bound", (t) => {
  // The scan proves its list is complete only while the page holds every
  // open pull request. A page at the bound could hide an offer behind the
  // cut, so the run fails closed and closes nothing.
  const openOffers = [];
  for (let index = 0; index < 100; index += 1) {
    openOffers.push({ number: 900 + index, head: `consumer/feature-${index}` });
  }
  openOffers.push({ number: 801, head: "automation/repin-lock-300501e" });
  const harness = consumerRepinHarness(t, {
    "unity-helpers": { atTarget: true, openOffers }
  });

  const result = harness.run();

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /offer scan would be truncated/);
  assert.match(result.stderr, /could not close the superseded repin offers/);
  assert.equal(repinEventLog(harness).filter((event) => event.startsWith("close")).length, 0);
});

test("consumer repin fails closed when a superseded offer cannot be closed", (t) => {
  const harness = consumerRepinHarness(t, {
    "unity-helpers": {
      atTarget: true,
      openOffers: [{ number: 801, head: "automation/repin-lock-300501e" }],
      failClose: true
    }
  });

  const result = harness.run();

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /could not close the superseded repin offers/);
  const summary = fs.readFileSync(harness.summaryPath, "utf8");
  assert.match(summary, /\| `Ambiguous-Interactive\/unity-helpers` \| failed; see the job log \|/);
});

const authorizationScriptPath = path.join(scriptsRoot, "open-release-authorization-pr.sh");
const diagnosticScriptPath = path.join(scriptsRoot, "report-nonconventional-commits.sh");

// A policy repository with release tags v1.12.1, v1.14.0, and v1.15.0. The
// `publishedReleases` option is the raw GitHub API releases payload the shim
// serves, so the script's own --jq filter and selection run for real. Set
// `omitTag` to a release that exists in the payload but not in git, to prove
// discovery fails closed when the newest release cannot be examined.
// `authorizedTags` names the release commits the policy lists.
function releaseAuthorizationHarness(t, {
  publishedReleases,
  authorizedTags,
  omitTag = null,
  declinedPrs = false,
  prCreateStatus = "0"
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-authorization-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const remotePath = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");
  fs.mkdirSync(remotePath, { recursive: true });
  fs.mkdirSync(seed, { recursive: true });
  gitRun(root, "init", "--bare", "-b", "main", remotePath);
  gitRun(seed, "init", "-b", "main");
  gitRun(seed, "config", "user.name", "seed");
  gitRun(seed, "config", "user.email", "seed@example.com");
  gitRun(seed, "remote", "add", "origin", remotePath);

  const shasByTag = new Map();
  for (const version of ["v1.12.1", "v1.14.0", "v1.15.0"]) {
    fs.writeFileSync(path.join(seed, `${version}.txt`), `${version}\n`);
    gitRun(seed, "add", "-A");
    gitRun(seed, "commit", "-m", `release ${version}`);
    gitRun(seed, "tag", version);
    shasByTag.set(version, gitRun(seed, "rev-parse", `${version}^{commit}`));
  }
  const authorizedShas = authorizedTags.map((tag) => shasByTag.get(tag));
  fs.writeFileSync(path.join(seed, "unity-enrollment-policy.json"), JSON.stringify({
    schemaVersion: 1,
    approvedLockShas: authorizedShas,
    approvedReturnShas: authorizedShas,
    approvedDarwinReturnShas: [],
    repositories: [],
    exceptions: []
  }));
  gitRun(seed, "add", "-A");
  gitRun(seed, "commit", "-m", "policy");
  gitRun(seed, "push", "-q", "origin", "main");
  const pushedTags = ["v1.12.1", "v1.14.0", "v1.15.0"].filter((tag) => tag !== omitTag);
  gitRun(seed, "push", "-q", "origin", "main", ...pushedTags.map((tag) => `refs/tags/${tag}`));

  gitRun(root, "clone", "-q", remotePath, work);

  const shims = path.join(root, "shims");
  const events = path.join(root, "events.log");
  const releasesPayload = path.join(root, "releases.json");
  const prState = path.join(root, "pr-state");
  fs.mkdirSync(shims);
  fs.mkdirSync(prState);
  fs.writeFileSync(events, "");
  fs.writeFileSync(releasesPayload, JSON.stringify(publishedReleases));
  fs.writeFileSync(path.join(prState, "open"), "0\n");
  fs.writeFileSync(path.join(prState, "closed"), `${declinedPrs ? 1 : 0}\n`);
  writeExecutable(path.join(shims, "gh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'printf \'gh %s\\n\' "$*" >> "${TEST_EVENTS}"',
    'if [ "$1" = "api" ]; then',
    '  program=""',
    '  previous=""',
    '  for argument in "$@"; do',
    '    if [ "${previous}" = "--jq" ]; then program="${argument}"; fi',
    '    previous="${argument}"',
    "  done",
    '  exec jq "${program}" "${TEST_RELEASES_PAYLOAD}"',
    "fi",
    'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then',
    '  state="open"',
    '  previous=""',
    '  for argument in "$@"; do',
    '    if [ "${previous}" = "--state" ]; then state="${argument}"; fi',
    '    previous="${argument}"',
    "  done",
    '  cat "${TEST_PR_STATE}/${state}"',
    "  exit 0",
    "fi",
    'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
    '  exit "${TEST_PR_CREATE_STATUS}"',
    "fi",
    'if [ "$1" = "workflow" ] && [ "$2" = "run" ]; then',
    "  exit 0",
    "fi",
    "exit 64"
  ].join("\n"));

  return {
    root,
    remotePath,
    work,
    events,
    shasByTag,
    run: () => childProcess.spawnSync("bash", [authorizationScriptPath], {
      cwd: work,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${shims}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "Ambiguous-Interactive/ambiguous-organization-build-lock",
        RELEASE_VERSION: "",
        GH_TOKEN: "test-github-token",
        RELEASE_AUTHORIZATION: "test-release-token",
        TEST_EVENTS: events,
        TEST_RELEASES_PAYLOAD: releasesPayload,
        TEST_PR_STATE: prState,
        TEST_PR_CREATE_STATUS: String(prCreateStatus)
      }
    })
  };
}

function authorizationBranchOnRemote(harness, branch) {
  return gitRun(harness.work, "ls-remote", "--heads", harness.remotePath, branch);
}

function defaultPublishedReleases() {
  // Deliberately shuffled and polluted: discovery must filter drafts and
  // prereleases, sort by semantic version, and take only the newest.
  return [
    { tag_name: "v1.12.1", draft: false, prerelease: false },
    { tag_name: "v1.15.0-rc1", draft: false, prerelease: true },
    { tag_name: "v1.14.0", draft: false, prerelease: false },
    { tag_name: "v1.16.0", draft: true, prerelease: false },
    { tag_name: "v1.15.0", draft: false, prerelease: false }
  ];
}

test("release authorization discovery never re-offers a superseded release", (t) => {
  // v1.14.0 is the newest published release and is authorized. v1.12.1 was
  // superseded before its authorization merged and must never be offered.
  const harness = releaseAuthorizationHarness(t, {
    publishedReleases: [
      { tag_name: "v1.12.1", draft: false, prerelease: false },
      { tag_name: "v1.15.0-rc1", draft: false, prerelease: true },
      { tag_name: "v1.16.0", draft: true, prerelease: false },
      { tag_name: "v1.14.0", draft: false, prerelease: false }
    ],
    authorizedTags: ["v1.14.0"]
  });

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Every published release is already authorized\./);
  assert.doesNotMatch(fs.readFileSync(harness.events, "utf8"), /gh pr create/);
  assert.doesNotMatch(fs.readFileSync(harness.events, "utf8"), /gh workflow run/);
  assert.equal(authorizationBranchOnRemote(harness, "release-authorization/v1.12.1"), "");
  assert.equal(authorizationBranchOnRemote(harness, "release-authorization/v1.14.0"), "");
});

test("release authorization offers only the newest unauthorized release", (t) => {
  const harness = releaseAuthorizationHarness(t, {
    publishedReleases: defaultPublishedReleases(),
    authorizedTags: ["v1.14.0"]
  });

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  const events = fs.readFileSync(harness.events, "utf8");
  assert.match(events, /gh pr create/);
  assert.match(events, /gh workflow run/);
  const releaseSha = harness.shasByTag.get("v1.15.0");
  const pushed = gitRun(
    harness.work,
    "show",
    "refs/remotes/origin/release-authorization/v1.15.0:unity-enrollment-policy.json"
  );
  const pushedPolicy = JSON.parse(pushed);
  assert.ok(pushedPolicy.approvedLockShas.includes(releaseSha));
  assert.ok(pushedPolicy.approvedReturnShas.includes(releaseSha));
});

test("release authorization fails closed when the newest release tag cannot be examined", (t) => {
  const harness = releaseAuthorizationHarness(t, {
    publishedReleases: defaultPublishedReleases(),
    authorizedTags: ["v1.12.1"],
    omitTag: "v1.15.0"
  });

  const result = harness.run();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to claim the newest published release is authorized/);
  assert.equal(authorizationBranchOnRemote(harness, "release-authorization/v1.15.0"), "");
});

test("release authorization never re-offers a declined release", (t) => {
  const harness = releaseAuthorizationHarness(t, {
    publishedReleases: defaultPublishedReleases(),
    authorizedTags: ["v1.14.0"],
    declinedPrs: true
  });

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /closed without merging/);
  assert.doesNotMatch(fs.readFileSync(harness.events, "utf8"), /gh pr create/);
  assert.equal(authorizationBranchOnRemote(harness, "release-authorization/v1.15.0"), "");
});

test("release authorization removes its branch when pull request creation fails", (t) => {
  const harness = releaseAuthorizationHarness(t, {
    publishedReleases: defaultPublishedReleases(),
    authorizedTags: ["v1.14.0"],
    prCreateStatus: "1"
  });

  const result = harness.run();

  assert.notEqual(result.status, 0);
  assert.match(fs.readFileSync(harness.events, "utf8"), /gh pr create/);
  assert.equal(authorizationBranchOnRemote(harness, "release-authorization/v1.15.0"), "");
});

test("release authorization reports an empty release list without offering anything", (t) => {
  const harness = releaseAuthorizationHarness(t, {
    publishedReleases: [],
    authorizedTags: []
  });

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No published release exists to authorize\./);
  assert.doesNotMatch(fs.readFileSync(harness.events, "utf8"), /gh pr create/);
});

function diagnosticHarness(t, subjects, { withTag = true, withSummary = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-diagnostic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  gitRun(root, "init", "-b", "main");
  gitRun(root, "config", "user.name", "seed");
  gitRun(root, "config", "user.email", "seed@example.com");
  fs.writeFileSync(path.join(root, "release.md"), "v1.14.0\n");
  gitRun(root, "add", "-A");
  gitRun(root, "commit", "-m", "release v1.14.0");
  if (withTag) {
    gitRun(root, "tag", "v1.14.0");
  }
  for (const [index, subject] of subjects.entries()) {
    fs.writeFileSync(path.join(root, `commit-${index}.md`), `${subject}\n`);
    gitRun(root, "add", "-A");
    gitRun(root, "commit", "-m", subject);
  }
  const summary = path.join(root, "summary.md");
  fs.writeFileSync(summary, "");
  return {
    root,
    summary,
    run: () => childProcess.spawnSync("bash", [diagnosticScriptPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: withSummary ? summary : ""
      }
    })
  };
}

test("release diagnostics report non-conventional subjects since the newest release", (t) => {
  const harness = diagnosticHarness(t, [
    "Land the Darwin trusted return, with its requirement compiled in CI (#240)"
  ]);

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  const summary = fs.readFileSync(harness.summary, "utf8");
  assert.match(summary, /v1\.14\.0/);
  assert.match(summary, /Land the Darwin trusted return, with its requirement compiled in CI \(#240\)/);
  assert.match(result.stderr, /::warning::/);
});

test("release diagnostics stay silent for conventional subjects and for no unreleased commits", (t) => {
  const conventional = diagnosticHarness(t, ["fix(release): repair discovery", "docs: record session"]);
  assert.equal(conventional.run().status, 0);
  assert.equal(fs.readFileSync(conventional.summary, "utf8"), "");

  const noCommits = diagnosticHarness(t, []);
  assert.equal(noCommits.run().status, 0);
  assert.equal(fs.readFileSync(noCommits.summary, "utf8"), "");
});

test("release diagnostics degrade to a warning when their inputs are missing", (t) => {
  const noTag = diagnosticHarness(t, ["Land the Darwin trusted return (#240)"], { withTag: false });
  const noTagResult = noTag.run();
  assert.equal(noTagResult.status, 0, noTagResult.stderr);
  assert.match(noTagResult.stderr, /No reachable release tag/);
  assert.equal(fs.readFileSync(noTag.summary, "utf8"), "");

  const noSummary = diagnosticHarness(t, ["Land the Darwin trusted return (#240)"], { withSummary: false });
  const noSummaryResult = noSummary.run();
  assert.equal(noSummaryResult.status, 0, noSummaryResult.stderr);
  assert.match(noSummaryResult.stderr, /GITHUB_STEP_SUMMARY is not set/);
});
