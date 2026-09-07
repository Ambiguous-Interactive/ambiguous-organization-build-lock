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
    "open-release-authorization-pr.sh",
    "repin-consumer-locks.sh",
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
    unmatched: []
  });

  const lines = fs.readFileSync(path.join(workflows, "unity.yml"), "utf8").split("\n");
  assert.equal(
    lines[3],
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${target} # v1.14.0`
  );
  assert.equal(
    lines[4],
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/return-unity-license@${target}`
  );
  assert.equal(
    lines[5],
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/release-build-lock@${target} # v1.14.0`
  );
  assert.equal(lines[6], `      - uses: actions/checkout@${oldSha}`);
  assert.equal(lines[7], `      - run: echo 'Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/release-build-lock@${oldSha}'`);
  assert.equal(
    lines[8],
    "      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/classify-unity-changes@64bac446903115134dca8235410b332bc5a83547 # post-v1.10.0"
  );

  const rerun = runRewrite(target, "v1.14.0", "Ambiguous-Interactive/unity-helpers");
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.deepEqual(JSON.parse(rerun.stdout), { changed: 0, files: [], skipped: [], unmatched: [] });

  const unapproved = runRewrite("0".repeat(40), "v0.0.0", "Ambiguous-Interactive/unity-helpers");
  assert.equal(unapproved.status, 1);
  assert.match(unapproved.stderr, /not authorized in both allowlists/);

  const malformed = runRewrite("64bac446", "v1.14.0", "Ambiguous-Interactive/unity-helpers");
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /40-character commit SHA/);
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
    unmatched: []
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
    unmatched: []
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
