"use strict";

const test = require("node:test");

const {
  assert,
  childProcess,
  fs,
  os,
  path,
  repoRoot,
  scriptsRoot,
  runScript,
  shellCheckInstallHarness,
  causeSummaryCases,
  headRevalidationHarness,
  runHeadRevalidation,
  readHeadRevalidationEvents,
  repinOldSha,
} = require("./workflow-scripts-support.js");


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


for (const testCase of causeSummaryCases) {
  test(`${testCase.script} publishes every refusal cause in the run summary`, (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "refusal-cause-summary-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const auditPath = path.join(temporary, "audit.json");
    const summaryPath = path.join(temporary, "summary.md");
    const environment = { AUDIT_PATH: auditPath, GITHUB_STEP_SUMMARY: summaryPath };
    const write = (findings, complete) =>
      fs.writeFileSync(
        auditPath,
        JSON.stringify({ repositories: [], inventory: [], findings, complete })
      );

    write([], true);
    assert.equal(runScript(testCase.script, "record-counts", environment).status, 0);
    assert.doesNotMatch(
      fs.readFileSync(summaryPath, "utf8"),
      /Refused evidence/,
      "an audit with no cause must not publish an empty cause table"
    );

    // Each script is fed a cause only its own analyzer can produce, so a change
    // to either alphabet is caught by the script that renders it. The bounded
    // block below uses one cause for both, so it checks the bound and not the
    // alphabet.
    write(
      [
        {
          repository: "Ambiguous-Interactive/DoxReloaded",
          code: testCase.code,
          cause: testCase.cause
        },
        { repository: "Ambiguous-Interactive/qora-redux", code: testCase.code }
      ],
      false
    );
    assert.notEqual(runScript(testCase.script, "record-counts", environment).status, 0);
    const summary = fs.readFileSync(summaryPath, "utf8");
    assert.match(summary, /Refused evidence/);
    assert.match(summary, testCase.fileNeedle);
    assert.match(summary, /Ambiguous-Interactive\/DoxReloaded/);
    assert.doesNotMatch(summary, /qora-redux/, "a finding with no cause must not publish a blank row");

    // The table is bounded, so a long list cannot push a summary past its limit.
    write(
      Array.from({ length: 25 }, (_, index) => ({
        repository: `Ambiguous-Interactive/repo-${index}`,
        code: "repository-retrieval-incomplete",
        cause: "lock state is not valid UTF-8"
      })),
      false
    );
    assert.notEqual(runScript(testCase.script, "record-counts", environment).status, 0);
    const bounded = fs.readFileSync(summaryPath, "utf8");
    assert.match(bounded, /and 5 more in the retained artifact/);
    assert.doesNotMatch(bounded, /repo-24/, "the bounded table must stop before the last cause");
  });
}


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
    uses: 3,
    refs: 0,
    files: [{ path: path.join(".github", "workflows", "unity.yml"), lines: 3 }],
    skipped: [],
    unmatched: [],
    companions: [],
    unmatchedCompanions: []
  });

  const lines = fs.readFileSync(path.join(workflows, "unity.yml"), "utf8").split("\n");
  assert.equal(
    lines[3],
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${target} # v1.14.0`,
    "a moved pin keeps the repository's own comment spacing"
  );
  assert.equal(
    lines[4],
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/return-unity-license@${target} # v1.14.0`,
    "a moved pin without a comment gains the release version comment in the repository's own spacing"
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
    uses: 0,
    refs: 0,
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


test("consumer repin moves a uses: pin through every spelling a workflow may write", (t) => {
const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-uses-spellings-"));
t.after(() => fs.rmSync(root, { recursive: true, force: true }));
const oldSha = repinOldSha;
const target = "64bac446903115134dca8235410b332bc5a83547";
const lockRepository = "Ambiguous-Interactive/ambiguous-organization-build-lock";
const workflows = path.join(root, ".github", "workflows");
fs.mkdirSync(workflows, { recursive: true });
// Each spelling below froze a real pin before: the rewrite reported nothing to
// change, the automation called the repository already pinned and closed its
// own offer, and the stale pin had no evidence against it. `pinLine` is the
// exact line the rewrite has to produce, because a count proves a pin moved
// and the line proves how it was rebuilt.
const cases = [
  {
    name: "a quoted uses: key",
    why: "a quoted key is the same key to a YAML reader and to GitHub, and a pattern that accepted only a bare `uses:` froze the pin with the run reporting the repository already pinned",
    lines: [
      "      - \"uses\": " + lockRepository + "/.github/actions/acquire-build-lock@" + oldSha + " # v1.13.0"
    ],
    pinLine: "      - \"uses\": " + lockRepository + "/.github/actions/acquire-build-lock@" + target + " # v1.14.0"
  },
  {
    name: "a uses: key with a space before its colon",
    why: "YAML allows it and GitHub reads the key, so a pattern that required `uses:` exactly froze a real pin",
    lines: [
      "      - uses : " + lockRepository + "/.github/actions/acquire-build-lock@" + oldSha + " # v1.13.0"
    ],
    pinLine: "      - uses : " + lockRepository + "/.github/actions/acquire-build-lock@" + target + " # v1.14.0"
  },
  {
    name: "a two-space gap in front of the value",
    why: "the gap is the consumer's own spacing, and a rebuild that normalises it edits a byte the pin did not name",
    lines: [
      "      - uses:  " + lockRepository + "/.github/actions/acquire-build-lock@" + oldSha + " # v1.13.0"
    ],
    pinLine: "      - uses:  " + lockRepository + "/.github/actions/acquire-build-lock@" + target + " # v1.14.0"
  },
  {
    name: "a uses: key in another case",
    why: "GitHub reads an action's key without regard to case, so this names the same pin",
    lines: [
      "      - USES: " + lockRepository + "/.github/actions/acquire-build-lock@" + oldSha + " # v1.13.0"
    ],
    pinLine: "      - USES: " + lockRepository + "/.github/actions/acquire-build-lock@" + target + " # v1.14.0"
  },
  {
    name: "a repository name in another case on the uses: line",
    why: "GitHub reads a repository name without regard to case, so a spelling that differs only in case names the same pin",
    lines: [
      "      - uses: AMBIGUOUS-INTERACTIVE/Ambiguous-Organization-Build-Lock/.github/actions/acquire-build-lock@" + oldSha + " # v1.13.0"
    ],
    pinLine: "      - uses: AMBIGUOUS-INTERACTIVE/Ambiguous-Organization-Build-Lock/.github/actions/acquire-build-lock@" + target + " # v1.14.0"
  },  ];
const runRewrite = () =>
  childProcess.spawnSync(
    "bash",
    [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
    { cwd: repoRoot, encoding: "utf8" }
  );
const file = path.join(workflows, "unity.yml");
for (const testCase of cases) {
  fs.writeFileSync(file, ["jobs:", "  unity:", "    steps:", ...testCase.lines, ""].join("\n"));
  const result = runRewrite();
  assert.equal(result.status, 0, testCase.name + ": " + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.uses, 1, testCase.name + ": " + testCase.why);
  assert.equal(report.changed, 1, testCase.name + ": " + testCase.why);
  assert.ok(
    fs.readFileSync(file, "utf8").split("\n").includes(testCase.pinLine),
    testCase.name + ": the rewritten line is not exactly " + JSON.stringify(testCase.pinLine) + "\n" + fs.readFileSync(file, "utf8")
  );
}
// Two shapes that froze a real pin, and a value carrying a second `@` that the
// rebuild used to cut at the wrong one. A pin followed by a space and no
// comment was skipped by the value pattern, and a value with two `@` lost
// everything between them.
for (const [name, line, moved] of [
  [
    "a trailing space and no comment",
    "      - uses: " + lockRepository + "/.github/actions/a@" + oldSha + " ",
    "      - uses: " + lockRepository + "/.github/actions/a@" + target + " # v1.14.0"
  ],
  [
    "a second @ in the value",
    "      - uses: " + lockRepository + "/.github/actions/a@" + oldSha + "@" + oldSha + " # v1.13.0",
    "      - uses: " + lockRepository + "/.github/actions/a@" + oldSha + "@" + target + " # v1.14.0"
  ]
]) {
  fs.writeFileSync(file, ["jobs:", "  unity:", "    steps:", line, ""].join("\n"));
  const result = runRewrite();
  assert.equal(result.status, 0, name + ": " + result.stderr);
  assert.equal(JSON.parse(result.stdout).uses, 1, name + " froze a real pin");
  assert.ok(
    fs.readFileSync(file, "utf8").split("\n").includes(moved),
    name + ": the rewritten line is not exactly " + JSON.stringify(moved) + "\n" + fs.readFileSync(file, "utf8")
  );
}
// A key that is not `uses:` is not a pin, whatever its value looks like. The
// value pattern would accept every one of these lines, so the key is what
// refuses them, and nothing else in the suite pins that.
for (const key of ["run", "name", "env", "shell", "id"]) {
  fs.writeFileSync(
    file,
    ["jobs:", "  unity:", "    steps:", "      - " + key + ": " + lockRepository + "/.github/actions/a@" + oldSha + " # v1.13.0", ""].join("\n")
  );
  const result = runRewrite();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(result.stdout).changed,
    0,
    "a " + key + ": line carrying a pin-shaped value moved, and that is not a pin"
  );
}

// The shapes that are not this repository's pin, or are not a pinned commit,
// stay put. A rewrite that moved any of them would edit a line that is not a
// pin, which is the outcome worse than a frozen one.
for (const line of [
  "      - !!str uses: " + lockRepository + "/.github/actions/a@" + oldSha + " # v1.13.0",
  "      - uses: !!str " + lockRepository + "/.github/actions/a@" + oldSha + " # v1.13.0",
  "      - uses: &p " + lockRepository + "/.github/actions/a@" + oldSha + " # v1.13.0",
  "      - {uses: " + lockRepository + "/.github/actions/a@" + oldSha + "} # v1.13.0",
  "      - uses: " + lockRepository + "/.github/actions/a@v1.2.3 # v1.13.0",
  "      - uses: Ambiguous-Interactive/other-repo/.github/actions/a@" + oldSha + " # v1.13.0",
  "      - uses: " + lockRepository + "/.github/actions/a@" + oldSha.toUpperCase() + " # v1.13.0",
  "      - uses: " + lockRepository + "/.github/actions/a@" + oldSha.slice(0, 39) + " # v1.13.0",
  "      - uses: " + lockRepository + "/.github/actions/a@" + oldSha + "0 # v1.13.0",
  // A `#` with no separation space is part of the plain scalar, so the value is
  // not a commit and moving it would edit a line that is not a pin.
  "      - uses: " + lockRepository + "/.github/actions/a@" + oldSha + "# v1.13.0",
  // A repository with no action path is a repository reference, and this rule
  // owns no action under a bare repository path.
  "      - uses: " + lockRepository + "@" + oldSha + " # v1.13.0"
  ]) {
  fs.writeFileSync(file, ["jobs:", "  unity:", "    steps:", line, ""].join("\n"));
  const result = runRewrite();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(result.stdout).changed,
    0,
    "a line that is not a pinned commit of this repository moved: " + line
  );
}
});


test("moved pin comments keep the consumer's own comment spacing", async (t) => {
  // The consumer owns the gap between its pin and a `# vX.Y.Z` comment,
  // because its own formatter owns the file. Enrolled repositories disagree:
  // IshoBoy's yamllint sets `min-spaces-from-content: 2` and rejects one
  // space, while unity-helpers runs Prettier over `.github/` and rewrites two
  // spaces back to one. A hard-coded width broke unity-helpers' `main` on
  // the v1.16.0 offer (#307), so the rewrite must reproduce each repository's
  // existing bytes instead of normalizing them. Every case runs under every
  // gap the rewrite accepts.
  //
  // Each case is one moved pin under one target version. The scheduled
  // resolver only emits `vX.Y.Z` tags; the empty version proves the rewrite
  // never deletes a reviewed label when the tag is unknown, and the
  // malformed version proves the version comment stays a machine-readable
  // contract.
  const oldSha = "300501e91c9bec81bb9b5a977c22aa5bb2d9b649";
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const pin = (action, ref) =>
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/${action}@${ref}`;
  // The repository's other pin already sits at the target, so it supplies the
  // spacing evidence without moving itself.
  const precedent = (gap) => `jobs:\n  unity:\n    steps:\n${pin("acquire-build-lock", `${target}${gap}# v1.14.0`)}\n`;
  for (const gap of [" ", "  "]) {
    const other = gap === " " ? "  " : " ";
    const cases = [
      { comment: "", version: "v1.14.0", expected: `${target}${gap}# v1.14.0` },
      { comment: `${gap}# v1.13.0`, version: "v1.14.0", expected: `${target}${gap}# v1.14.0` },
      { comment: `${other}# v1.13.0`, version: "v1.14.0", expected: `${target}${other}# v1.14.0` },
      { comment: " # post-v1.10.0", version: "v1.14.0", expected: `${target} # post-v1.10.0` },
      { comment: "", version: "", expected: `${target}` },
      { comment: `${gap}# v1.13.0`, version: "", expected: `${target}${gap}# v1.13.0` },
      { comment: " # post-v1.10.0", version: "", expected: `${target} # post-v1.10.0` }
    ];
    for (const testCase of cases) {
      await t.test(`gap ${JSON.stringify(gap)} comment ${JSON.stringify(testCase.comment)} version ${JSON.stringify(testCase.version)}`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-comments-"));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const workflows = path.join(root, ".github", "workflows");
        fs.mkdirSync(workflows, { recursive: true });
        fs.writeFileSync(
          path.join(workflows, "unity.yml"),
          `${precedent(gap)}${pin("return-unity-license", oldSha + testCase.comment)}\n`
        );
        const result = childProcess.spawnSync(
          "bash",
          [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, testCase.version, "Ambiguous-Interactive/unity-helpers"],
          { cwd: repoRoot, encoding: "utf8" }
        );
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout).changed, 1);
        assert.equal(
          fs.readFileSync(path.join(workflows, "unity.yml"), "utf8"),
          `${precedent(gap)}${pin("return-unity-license", testCase.expected)}\n`
        );
      });
    }
  }

  const injection = fs.mkdtempSync(path.join(os.tmpdir(), "repin-comments-"));
  t.after(() => fs.rmSync(injection, { recursive: true, force: true }));
  const workflows = path.join(injection, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  fs.writeFileSync(path.join(workflows, "unity.yml"), `${pin("acquire-build-lock", oldSha)}\n`);
  const hostile = childProcess.spawnSync(
    "bash",
    [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", injection, target, "v1.14.0\nrun: exploit", "Ambiguous-Interactive/unity-helpers"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert.equal(hostile.status, 1);
  assert.match(hostile.stderr, /vMAJOR\.MINOR\.PATCH target version/);
  assert.equal(
    fs.readFileSync(path.join(workflows, "unity.yml"), "utf8"),
    `${pin("acquire-build-lock", oldSha)}\n`,
    "a fail-closed run leaves the pin untouched"
  );
});


test("consumer repin fails closed when the repository's comment spacing has no single evidence", async (t) => {
  const oldSha = "300501e91c9bec81bb9b5a977c22aa5bb2d9b649";
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const pin = (action, ref) =>
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/${action}@${ref}`;
  // A pin that gains a version comment needs a gap, and the only evidence is
  // what the repository already writes. A mechanical rewrite cannot tell which
  // width a consumer's formatter accepts, so an absent, split, or
  // unreproducible precedent fails closed and names the file to fix instead of
  // guessing. Each case also proves the checkout stays byte-identical, so a
  // fail-closed run can never leave a half-rewritten tree.
  const cases = [
    {
      name: "no version comment to copy",
      files: { "unity.yml": `${pin("return-unity-license", oldSha)}\n` },
      expected: /None of its lock pins carries a `# vX\.Y\.Z` comment\./u
    },
    {
      name: "two comment gaps in one repository",
      files: {
        "a.yml": `${pin("acquire-build-lock", `${oldSha} # v1.13.0`)}\n`,
        "b.yml": `${pin("release-build-lock", `${oldSha}  # v1.13.0`)}\n${pin("return-unity-license", oldSha)}\n`
      },
      expected: /Its lock pins use 2 different comment gaps: " ", "  "\./u
    },
    {
      // `trim()` strips a non-breaking space, so this comment passes the
      // version test. Copying the gap is impossible and dropping it folds the
      // `#` into the `uses:` value, which hides the pin from every later run.
      name: "a gap that is not a space",
      files: { "unity.yml": `${pin("acquire-build-lock", `${oldSha}\u00a0# v1.13.0`)}\n` },
      expected: /with "\u00a0" instead of one or more spaces\.[\s\S]*`uses:` value/u
    },
    {
      // A gap that starts with a space and then a non-breaking space is still
      // not reproducible, and the message has to name the gap as it really is.
      name: "a gap that mixes a space with another whitespace character",
      files: { "unity.yml": `${pin("acquire-build-lock", `${oldSha} \u00a0# v1.13.0`)}\n` },
      expected: /with " \u00a0" instead of one or more spaces\./u
    },
    {
      // libyaml rejects a tab before a comment as a syntax error, so a tab is a
      // space the consumer never wrote and the rewrite must not emit one.
      name: "a tab gap",
      files: { "unity.yml": `${pin("acquire-build-lock", `${oldSha}\t# v1.13.0`)}\n` },
      expected: /with "\\t" instead of one or more spaces\./u
    }
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-gap-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const workflows = path.join(root, ".github", "workflows");
      fs.mkdirSync(workflows, { recursive: true });
      for (const [name, content] of Object.entries(testCase.files)) {
        fs.writeFileSync(path.join(workflows, name), content);
      }
      const result = childProcess.spawnSync(
        "bash",
        [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
        { cwd: repoRoot, encoding: "utf8" }
      );
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, testCase.expected);
      assert.match(result.stderr, /Ambiguous-Interactive\/unity-helpers/);
      // The message must name the file the operator has to edit.
      assert.match(result.stderr, /\.github\/workflows\/[a-z]+\.yml:\d+/u);
      for (const [name, content] of Object.entries(testCase.files)) {
        assert.equal(
          fs.readFileSync(path.join(workflows, name), "utf8"),
          content,
          "a fail-closed run leaves every file byte-identical"
        );
      }
    });
  }

  // A repository with no lock pin at all has no pin to move, so it never needs
  // a gap and must not fail.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "repin-gap-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  fs.mkdirSync(path.join(empty, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(empty, ".github", "workflows", "unity.yml"), "jobs: {}\n");
  const skipped = childProcess.spawnSync(
    "bash",
    [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", empty, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.deepEqual(JSON.parse(skipped.stdout).changed, 0);
});


test("consumer repin refuses a symlink under .github instead of following it", (t) => {
  // A symlink is followed on read and written through, so a workflow reached
  // through one would be edited outside the checkout the offer shows while
  // `git status` stays clean, and a symlinked directory would hide every pin
  // inside it so the run would report no change and close its own offer as
  // superseded. The companion path already refuses the file shape; a workflow
  // must refuse both, and the target has to sit outside the consumer root for
  // the claim to mean anything.
  const oldSha = "300501e91c9bec81bb9b5a977c22aa5bb2d9b649";
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const original =
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${oldSha} # v1.13.0\n`;
  const cases = [
    { name: "a symlinked workflow file", link: "linked.yml", kind: "file" },
    { name: "a symlinked workflow directory", link: "linked.yml", kind: "directory" },
    { name: "a symlinked directory under .github", link: "shared", kind: "directory" },
    { name: "a .github that is a file", link: null, kind: "github-file" },
    { name: "a .github that is a symlink", link: null, kind: "github-symlink" }
  ];
  for (const testCase of cases) {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "repin-symlink-"));
    t.after(() => fs.rmSync(container, { recursive: true, force: true }));
    const root = path.join(container, "consumer");
    const outside = path.join(container, "outside");
    if (testCase.kind === "github-file") {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, ".github"), original);
    } else if (testCase.kind === "github-symlink") {
      fs.mkdirSync(root, { recursive: true });
      fs.mkdirSync(path.join(outside, "workflows"), { recursive: true });
      fs.writeFileSync(path.join(outside, "workflows", "unity.yml"), original);
      fs.symlinkSync(outside, path.join(root, ".github"));
    } else {
      const workflows = path.join(root, ".github", "workflows");
      fs.mkdirSync(workflows, { recursive: true });
      fs.writeFileSync(path.join(workflows, "unity.yml"), `jobs: {}\n`);
      if (testCase.kind === "file") {
        fs.mkdirSync(outside, { recursive: true });
        fs.writeFileSync(path.join(outside, testCase.link), original);
      } else {
        fs.mkdirSync(path.join(outside, testCase.link), { recursive: true });
        fs.writeFileSync(path.join(outside, testCase.link, "unity.yml"), original);
      }
      fs.symlinkSync(
        path.relative(path.dirname(path.join(root, ".github", testCase.link)), path.join(outside, testCase.link)),
        path.join(root, ".github", testCase.link)
      );
    }
    const result = childProcess.spawnSync(
      "bash",
      [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
      { cwd: repoRoot, encoding: "utf8" }
    );
    assert.equal(result.status, 1, `${testCase.name}: ${result.stdout}`);
    if (testCase.link === null) {
      assert.match(result.stderr, /refuse a \.github that is not a directory/u, testCase.name);
    } else {
      assert.match(
        result.stderr,
        new RegExp(`refuse the symlink \\.github/${testCase.link} under \\.github`, "u"),
        testCase.name
      );
    }
    if (testCase.kind === "file") {
      assert.equal(
        fs.readFileSync(path.join(outside, testCase.link), "utf8"),
        original,
        `${testCase.name}: the write never escapes the checkout`
      );
    }
    if (testCase.kind === "github-symlink") {
      assert.equal(
        fs.readFileSync(path.join(outside, "workflows", "unity.yml"), "utf8"),
        original,
        `${testCase.name}: the write never escapes the checkout`
      );
    }
  }
});


test("a pin-lines companion with no version comment falls back to the workflow gap", (t) => {
  // A companion with no version comment of its own carries no evidence, and an
  // empty Set is truthy, so the fallback has to test the size. Without it the
  // run fails closed on a repository whose workflows already say the answer.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-companion-fallback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = "300501e91c9bec81bb9b5a977c22aa5bb2d9b649";
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const pin = (action, ref) =>
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/${action}@${ref}`;
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".github", "workflows", "unity.yml"),
    `jobs:\n  unity:\n    steps:\n${pin("acquire-build-lock", `${target}   # v1.14.0`)}\n`
  );
  // Two spaces in the workflow evidence, so a one-space answer proves the
  // workflow set was used rather than the companion's own.
  const companion = [
    pin("acquire-build-lock", oldSha),
    pin("return-unity-license", oldSha),
    ""
  ].join("\n");
  fs.writeFileSync(path.join(root, "docs", "pins.md"), companion);
  const policyPath = path.join(root, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify({
    schemaVersion: 1,
    organization: "Ambiguous-Interactive",
    approvedLockShas: [oldSha, target],
    approvedReturnShas: [target],
    approvedDarwinReturnShas: [],
    repositories: [{ repository: "Ambiguous-Interactive/unity-helpers" }],
    exceptions: [],
    repinExceptions: [],
    repinCompanions: [
      { repository: "Ambiguous-Interactive/unity-helpers", path: "docs/pins.md", mode: "pin-lines" }
    ]
  }));
  const result = childProcess.spawnSync(
    "bash",
    [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: policyPath } }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(path.join(root, "docs", "pins.md"), "utf8"),
    [
      pin("acquire-build-lock", `${target}   # v1.14.0`),
      pin("return-unity-license", `${target}   # v1.14.0`),
      ""
    ].join("\n")
  );
});


test("a protected workflow is neither read nor used as comment spacing evidence", (t) => {
  // A `repinExceptions` file is never rewritten, so it is not a reviewed
  // surface for this run. If it were still read, it could veto the whole
  // consumer repin with a gap the run would never touch, and an unreadable
  // protected file would turn a tolerated state into a red run. The gap below
  // is deliberately the one width the rewritten file does not use.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-protected-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = "300501e91c9bec81bb9b5a977c22aa5bb2d9b649";
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const pin = (action, ref) =>
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/${action}@${ref}`;
  const protectedContent = `${pin("release-build-lock", `${oldSha}   # v1.13.0`)}\n`;
  const openContent = `jobs:\n  unity:\n    steps:\n${pin("acquire-build-lock", `${target} # v1.14.0`)}\n${pin("return-unity-license", oldSha)}\n`;
  // The protected gap is deliberately the one width the rewritten file does not
  // use, and one run protects a file that cannot be opened at all. Neither may
  // reach the rewrite: the first would veto the consumer, the second would
  // turn a tolerated state into a red run.
  const policyPath = path.join(root, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify({
    schemaVersion: 1,
    organization: "Ambiguous-Interactive",
    approvedLockShas: [oldSha, target],
    approvedReturnShas: [target],
    approvedDarwinReturnShas: [],
    repositories: [{ repository: "Ambiguous-Interactive/unity-helpers" }],
    exceptions: [],
    repinExceptions: [{
      repository: "Ambiguous-Interactive/unity-helpers",
      path: ".github/workflows/legacy.yml",
      reason: "The wrapper cannot supply the return-log-digest input.",
      owner: "unity-helpers-maintainers",
      expiresAt: "2099-01-01T00:00:00Z"
    }],
    repinCompanions: []
  }));
  const cases = [
    { name: "a protected workflow with a different gap", mode: 0o644 },
    { name: "a protected workflow that cannot be read", mode: 0o000 }
  ];
  for (const testCase of cases) {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "repin-protected-"));
    t.after(() => {
      fs.chmodSync(path.join(checkout, ".github", "workflows", "legacy.yml"), 0o600);
      fs.rmSync(checkout, { recursive: true, force: true });
    });
    const workflows = path.join(checkout, ".github", "workflows");
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, "legacy.yml"), protectedContent);
    fs.writeFileSync(path.join(workflows, "unity.yml"), openContent);
    fs.chmodSync(path.join(workflows, "legacy.yml"), testCase.mode);
    const result = childProcess.spawnSync(
      "bash",
      [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", checkout, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: policyPath } }
    );
    assert.equal(result.status, 0, `${testCase.name}: ${result.stderr}`);
    assert.deepEqual(
      JSON.parse(result.stdout).files,
      [{ path: path.join(".github", "workflows", "unity.yml"), lines: 1 }],
      testCase.name
    );
    assert.equal(
      fs.readFileSync(path.join(workflows, "unity.yml"), "utf8"),
      `jobs:\n  unity:\n    steps:\n${pin("acquire-build-lock", `${target} # v1.14.0`)}\n${pin("return-unity-license", `${target} # v1.14.0`)}\n`,
      testCase.name
    );
    fs.chmodSync(path.join(workflows, "legacy.yml"), 0o600);
    assert.equal(
      fs.readFileSync(path.join(workflows, "legacy.yml"), "utf8"),
      protectedContent,
      testCase.name
    );
  }
});


test("a companion that fails closed leaves every rewritten file byte-identical", async (t) => {
  // A fail-closed run must leave the whole checkout untouched, not only the
  // workflow files. A companion can still fail after an earlier companion has
  // already decided what to change, so a write flushed per companion would
  // leave a half-updated tree. Every companion mode is covered, because each
  // one can be the file that changes first.
  const oldSha = "300501e91c9bec81bb9b5a977c22aa5bb2d9b649";
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const pin = (action, ref) =>
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/${action}@${ref}`;
  const workflow = `jobs:\n  unity:\n    steps:\n${pin("acquire-build-lock", `${target} # v1.14.0`)}\n${pin("return-unity-license", oldSha)}\n`;
  // A companion whose own comment gap is a tab fails closed when the rewrite
  // reaches it, which is after every companion before it.
  const refused = pin("release-build-lock", `${oldSha}\t# v1.13.0`) + "\n";
  const snapshot = { schemaVersion: 1, organization: "Ambiguous-Interactive", approvedLockShas: [target], approvedReturnShas: [target], approvedDarwinReturnShas: [] };
  const modes = [
    {
      name: "pin-lines",
      path: "docs/a.md",
      content: pin("acquire-build-lock", `${oldSha}  # v1.13.0`) + "\n"
    },
    {
      name: "pin-literal",
      path: "docs/a.json",
      content: `{"policyCommit": "${oldSha}"}\n`
    },
    {
      name: "policy-snapshot",
      path: "docs/a.json",
      content: `${JSON.stringify({ ...snapshot, approvedLockShas: [oldSha] }, null, 2)}\n`
    }
  ];
  for (const mode of modes) {
    await t.test(`${mode.name} changes first, then a companion refuses`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-atomic-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
      fs.mkdirSync(path.join(root, "docs"), { recursive: true });
      fs.writeFileSync(path.join(root, ".github", "workflows", "unity.yml"), workflow);
      fs.writeFileSync(path.join(root, mode.path), mode.content);
      fs.writeFileSync(path.join(root, "docs", "z.md"), refused);
      const policyPath = path.join(root, "policy.json");
      const policy = {
        schemaVersion: 1,
        organization: "Ambiguous-Interactive",
        approvedLockShas: [oldSha, target],
        approvedReturnShas: [target],
        approvedDarwinReturnShas: [],
        repositories: [{ repository: "Ambiguous-Interactive/unity-helpers" }],
        exceptions: [],
        repinExceptions: [],
        repinCompanions: [
          { repository: "Ambiguous-Interactive/unity-helpers", path: mode.path, mode: mode.name },
          { repository: "Ambiguous-Interactive/unity-helpers", path: "docs/z.md", mode: "pin-lines" }
        ]
      };
      fs.writeFileSync(policyPath, JSON.stringify(policy));
      const result = childProcess.spawnSync(
        "bash",
        [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
        { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: policyPath } }
      );
      assert.equal(result.status, 1, `${mode.name}: ${result.stdout}`);
      assert.match(result.stderr, /docs\/z\.md:1 separates its pin/u, mode.name);
      assert.equal(
        fs.readFileSync(path.join(root, ".github", "workflows", "unity.yml"), "utf8"),
        workflow,
        `${mode.name}: the workflow pass decided to rewrite this file, and the run still left it alone`
      );
      assert.equal(
        fs.readFileSync(path.join(root, mode.path), "utf8"),
        mode.content,
        `${mode.name}: the companion pass decided to rewrite this file, and the run still left it alone`
      );
      assert.equal(fs.readFileSync(path.join(root, "docs", "z.md"), "utf8"), refused, mode.name);
    });
  }
});
