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
  snapshotBytes,
  repinActionPath,
  repinSnapshot,
  repinReadableSurfaces,
  undecodableBytes,
  repinOldSha,
  repinTarget,
  repinOrganization,
  gitRun,
  consumerRepinHarness,
  repinEventLog,
} = require("./workflow-scripts-support.js");

test("consumer repin fails closed when a companion path cannot be read", (t) => {
  // Only a missing companion means absent. A path whose parent is a file
  // returns `ENOTDIR`, and reporting that as a missing companion would offer
  // a commit that silently omits an artifact the policy requires.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-companion-parent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = "300501e91c9bec81bb9b5a977c22aa5bb2d9b649";
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const pin = (action, ref) =>
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/${action}@${ref}`;
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".github", "workflows", "unity.yml"),
    `jobs:\n  unity:\n    steps:\n${pin("acquire-build-lock", `${target} # v1.14.0`)}\n${pin("return-unity-license", oldSha)}\n`
  );
  // `docs` is a regular file, so `docs/pins.md` cannot be stat'ed at all.
  fs.writeFileSync(path.join(root, "docs"), "not a directory\n");
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
  assert.equal(result.status, 1, `a run that reported a missing companion would be green: ${result.stdout}`);
  assert.match(result.stderr, /ENOTDIR/u);
  assert.equal(result.stdout, "", "no report is emitted, so no caller can act on a missing companion");
});

test("a pin-lines companion keeps its own comment spacing", (t) => {
  // A companion is a file the consumer formats on its own terms. A
  // documentation file that carries two spaces must not have a one-space
  // comment written into it just because the workflow files use one, or the
  // offered commit leaves that file internally inconsistent.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-companion-gap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = "300501e91c9bec81bb9b5a977c22aa5bb2d9b649";
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const pin = (action, ref) =>
    `- uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/${action}@${ref}`;
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".github", "workflows", "unity.yml"),
    `jobs:\n  unity:\n    steps:\n      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${target} # v1.14.0\n`
  );
  const companion = [
    pin("acquire-build-lock", `${oldSha}  # v1.13.0`),
    pin("return-unity-license", oldSha),
    pin("release-build-lock", `${oldSha}  # v1.13.0`),
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
      pin("acquire-build-lock", `${target}  # v1.14.0`),
      pin("return-unity-license", `${target}  # v1.14.0`),
      pin("release-build-lock", `${target}  # v1.14.0`),
      ""
    ].join("\n")
  );
});

test("consumer repin moves pins in a CRLF workflow and keeps the line endings", (t) => {
  // `split("\n")` leaves the `\r` on every line and the pin pattern's `$`
  // anchor does not match before it, so a CRLF checkout used to match no pin
  // at all: the run reported no change, closed its own offer as superseded,
  // and left the consumer on a stale pin with no evidence that anything was
  // missed. The rewrite has to see the pin and put the terminator back.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-crlf-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = "300501e91c9bec81bb9b5a977c22aa5bb2d9b649";
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const workflows = path.join(root, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  const original = [
    "jobs:",
    "  unity:",
    "    steps:",
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${oldSha} # v1.13.0`,
    `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/return-unity-license@${oldSha}`,
    ""
  ].join("\r\n");
  fs.writeFileSync(path.join(workflows, "unity.yml"), original);
  const result = childProcess.spawnSync(
    "bash",
    [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).changed, 2);
  assert.equal(
    fs.readFileSync(path.join(workflows, "unity.yml"), "utf8"),
    [
      "jobs:",
      "  unity:",
      "    steps:",
      `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${target} # v1.14.0`,
      `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/return-unity-license@${target} # v1.14.0`,
      ""
    ].join("\r\n")
  );
});

test("consumer repin preserves reviewed compatibility exceptions and fails closed on expiry", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-exceptions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = "300501e91c9bec81bb9b5a977c22aa5bb2d9b649";
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const legacyPin = `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/return-unity-license@${oldSha} # v1.13.0`;
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
    uses: 1,
    refs: 0,
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
    uses: 1,
    refs: 0,
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
    uses: 1,
    refs: 0,
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
      name: "YAML path inside .github",
      companions: [{ repository: "Ambiguous-Interactive/unity-helpers", path: ".github/pin-doc.yml", mode: "pin-lines" }],
      stderr: /that is not a \.github YAML file/
    },
    {
      name: "the .github directory itself",
      companions: [{ repository: "Ambiguous-Interactive/unity-helpers", path: ".github", mode: "pin-lines" }],
      stderr: /that is not a \.github YAML file/
    },
    {
      // `path.posix.normalize` keeps a trailing slash where Go's `path.Clean`
      // removes it, so the two parsers would disagree here without an
      // explicit check. A companion names one file, and `path/` is a
      // directory.
      name: "trailing slash",
      companions: [{ repository: "Ambiguous-Interactive/unity-helpers", path: "docs/pin-doc/", mode: "pin-lines" }],
      stderr: /normalized repository-relative path/
    },
    {
      name: "trailing slash under .github",
      companions: [{ repository: "Ambiguous-Interactive/unity-helpers", path: ".github/scripts/", mode: "pin-lines" }],
      stderr: /normalized repository-relative path/
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
  const writePolicy = (overrides) => {
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
      ],
      ...overrides
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
      `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${oldSha} # v1.13.0`,
      ""
    ].join("\n")
  );
  const atomic = runRewrite();
  assert.equal(atomic.status, 0, atomic.stderr);
  assert.equal(
    fs.readFileSync(path.join(root, "tests", "pin-contract.js"), "utf8"),
    [`const policyCommit = "${target}";`, `const witnessDigest = "9f${witnessSha}aa11";`, ""].join("\n")
  );

  // A pin in a `pin-lines` companion is not a pin this rewrite removed, so it
  // must not widen the set of SHAs a pin-literal companion may move. Here the
  // workflows are already at the target, the documentation companion still
  // names the old SHA, and the pin-literal file quotes that same SHA as a
  // reviewed witness. Only a workflow pin may move it, so the witness stays.
  fs.writeFileSync(
    path.join(workflows, "unity.yml"),
    [
      "jobs:",
      "  unity:",
      "    steps:",
      `      - uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${target} # v1.14.0`,
      ""
    ].join("\n")
  );
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const pinDoc = path.join(root, "docs", "pin-doc.md");
  const docLine = `uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@`;
  fs.writeFileSync(pinDoc, `## Example\n\n- ${docLine}${oldSha} # v1.13.0\n`);
  const witness = [`const policyCommit = "${target}";`, `const reviewedWitness = "${oldSha}";`, ""].join("\n");
  fs.writeFileSync(path.join(root, "tests", "pin-contract.js"), witness);
  const policy = JSON.parse(fs.readFileSync(path.join(root, "policy.json"), "utf8"));
  // Ahead of the pin-literal entry, so the companion pin is already in the
  // set when the pin-literal file is rewritten.
  policy.repinCompanions.unshift({
    repository: "Ambiguous-Interactive/unity-helpers",
    path: "docs/pin-doc.md",
    mode: "pin-lines"
  });
  writePolicy(policy);
  const isolated = runRewrite();
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.equal(
    fs.readFileSync(pinDoc, "utf8"),
    `## Example\n\n- ${docLine}${target} # v1.14.0\n`
  );
  assert.equal(
    fs.readFileSync(path.join(root, "tests", "pin-contract.js"), "utf8"),
    witness,
    "a companion pin does not license a pin-literal witness to move"
  );

  // The same separation decides whether the stale-pin check runs at all. No
  // workflow pin was removed, and the only pin that moved lives in a
  // companion, so a pin-literal file that names only the stale pin must still
  // fail closed for operator review rather than riding on the companion. The
  // documentation companion is put back to the stale release so that it moves
  // again on this run.
  fs.writeFileSync(pinDoc, `## Example\n\n- ${docLine}${oldSha} # v1.13.0\n`);
  const onlyStale = [`const policyCommit = "${oldSha}";`, ""].join("\n");
  fs.writeFileSync(path.join(root, "tests", "pin-contract.js"), onlyStale);
  const guarded = runRewrite();
  assert.equal(guarded.status, 1, `expected failure, got ${guarded.status}: ${guarded.stdout}`);
  assert.match(guarded.stderr, /stale pin constant from a reviewed witness/);
  assert.equal(
    fs.readFileSync(path.join(root, "tests", "pin-contract.js"), "utf8"),
    onlyStale,
    "a fail-closed run leaves the companion untouched"
  );
});

test("consumer repin moves a checkout ref: only when its repository is the lock repository", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-ref-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = repinOldSha;
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const workflows = path.join(root, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  // Every case below is a shape observed in an enrolled consumer. Only the
  // first names the lock repository, so only its ref: may move. The
  // unity-helpers case is the one that decides the rule: a 40-hex ref: in an
  // identical with: block can check out a different repository entirely, so
  // the anchor is the sibling repository: key and never the SHA.
  const checkoutStep = (name, repository, ref, extra = []) => [
    `      - name: ${name}`,
    "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "        with:",
    repository,
    // A comment sits between the keys in DoxReloaded's real checkout, so the
    // scan has to skip a line that is not a key at all.
    "          # The comment is not a key.",
    `          ref: ${ref}`,
    ...extra,
    ""
  ];
  const lockRepository = "Ambiguous-Interactive/ambiguous-organization-build-lock";
  const lockRepositoryLine = `          repository: ${lockRepository}`;
  fs.writeFileSync(
    path.join(workflows, "unity.yml"),
    [
      "jobs:",
      "  unity:",
      "    steps:",
      `      - uses: ${lockRepository}/.github/actions/acquire-build-lock@${oldSha} # v1.13.0`,
      // Moves: the policy checkout of DoxReloaded's build-deploy.yml.
      ...checkoutStep("Checkout central Unity cleanup policy", lockRepositoryLine, oldSha, [
        "          path: .central-build-lock-policy",
        "          persist-credentials: false"
      ]),
      // Moves: the same checkout with a trailing comment on the anchor line.
      // The comment is not part of the value, and a value read with the
      // comment attached names no repository, so the ref: would stay stale.
      ...checkoutStep("Checkout policy with a comment", `${lockRepositoryLine} # the policy`, oldSha),
      // Survives: qora-redux's unity-helpers checkout pins a literal commit in
      // a block that differs only in the repository: value.
      ...checkoutStep(
        "Checkout trusted Unity editor validator",
        "          repository: Ambiguous-Interactive/unity-helpers",
        oldSha
      ),
      // Survives: unity-helpers resolves its ref: from a step output, so the
      // value is not a 40-character SHA and the rewrite leaves it alone.
      ...checkoutStep(
        "Checkout immutable central cleanup policy",
        lockRepositoryLine,
        "${{ steps.policy_pin.outputs.sha }}"
      ),
      // Survives: a branch name, not a pin.
      ...checkoutStep(
        "Checkout upstream",
        "          repository: Ambiguous-Interactive/unity-helpers",
        "main"
      ),
      // Survives: a comment on another repository's line does not make it
      // this one.
      ...checkoutStep(
        "Checkout helper",
        "          repository: Ambiguous-Interactive/unity-helpers # the helper",
        oldSha
      ),
      ""
    ].join("\n")
  );
  // A ref: that is not a sibling of repository:. `nested:` is a direct child
  // of the with: block, so its own mapping is deeper; the ref: below it names
  // a different checkout and must not borrow this block's repository.
  fs.writeFileSync(
    path.join(workflows, "nested.yml"),
    [
      "jobs:",
      "  nested:",
      "    steps:",
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "        with:",
      `          repository: ${lockRepository}`,
      "          nested:",
      `            repository: Ambiguous-Interactive/unity-helpers`,
      `            ref: ${oldSha}`,
      ""
    ].join("\n")
  );
  fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify({
    schemaVersion: 1,
    organization: "Ambiguous-Interactive",
    approvedLockShas: [oldSha, target],
    approvedReturnShas: [target],
    approvedDarwinReturnShas: [],
    repositories: [{ repository: "Ambiguous-Interactive/unity-helpers" }],
    exceptions: [],
    repinExceptions: [],
    repinCompanions: []
  }));
  const runRewrite = () =>
    childProcess.spawnSync(
      "bash",
      [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: path.join(root, "policy.json") } }
    );

  const result = runRewrite();
  assert.equal(result.status, 0, result.stderr);
  const rewritten = fs.readFileSync(path.join(workflows, "unity.yml"), "utf8");
  // The `uses:` pin and the anchored `ref:` both moved, and the comment and
  // `path:` lines around the moved ref: are byte-identical.
  assert.match(rewritten, new RegExp(`acquire-build-lock@${target} # v1\\.14\\.0`));
  assert.ok(
    rewritten.includes(
      lockRepositoryLine + "\n" +
      "          # The comment is not a key.\n" +
      `          ref: ${target}\n` +
      "          path: .central-build-lock-policy\n" +
      "          persist-credentials: false\n"
    ),
    `expected the anchored ref: to move in place:\n${rewritten}`
  );
  // A trailing comment on the anchor line is not part of its value, so the
  // ref: below it moves with the rest.
  assert.ok(
    rewritten.includes(
      `${lockRepositoryLine} # the policy\n` +
      "          # The comment is not a key.\n" +
      `          ref: ${target}\n`
    ),
    `expected a commented repository: to anchor its ref::\n${rewritten}`
  );
  // Every unanchored ref: is byte-identical to what the consumer wrote.
  for (const survivor of [
    "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n" +
      "          repository: Ambiguous-Interactive/unity-helpers\n" +
      "          # The comment is not a key.\n" + `          ref: ${oldSha}\n`,
    "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n" +
      "          repository: Ambiguous-Interactive/unity-helpers # the helper\n" +
      "          # The comment is not a key.\n" + `          ref: ${oldSha}\n`,
    lockRepositoryLine + "\n" +
      "          # The comment is not a key.\n" +
      "          ref: ${{ steps.policy_pin.outputs.sha }}\n",
    "          repository: Ambiguous-Interactive/unity-helpers\n" +
      "          # The comment is not a key.\n" +
      "          ref: main\n"
  ]) {
    assert.ok(rewritten.includes(survivor), `expected the rewrite to preserve:\n${survivor}`);
  }
  // The ref: reports as a changed line of its own file, so the pull request
  // body names the file a reviewer has to read.
  // The `uses:` pin and both anchored `ref:` values moved, and nothing else.
  assert.deepEqual(JSON.parse(result.stdout).files.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: ".github/workflows/unity.yml", lines: 3 }
  ]);
  assert.equal(JSON.parse(result.stdout).refs, 2, "each moved ref: is counted apart");
  assert.equal(
    fs.readFileSync(path.join(workflows, "nested.yml"), "utf8"),
    [
      "jobs:",
      "  nested:",
      "    steps:",
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "        with:",
      `          repository: ${lockRepository}`,
      "          nested:",
      "            repository: Ambiguous-Interactive/unity-helpers",
      `            ref: ${oldSha}`,
      ""
    ].join("\n"),
    "a ref: nested under another key is not a sibling of the repository: key"
  );

  // A ref: already at the target is a no-op, so the rerun is idempotent and
  // reports nothing to change.
  const rerun = runRewrite();
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(JSON.parse(rerun.stdout).changed, 0);
});

test("consumer repin carries a .github companion the workflow rewrite does not own", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-github-companion-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = repinOldSha;
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const workflows = path.join(root, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  fs.writeFileSync(
    path.join(workflows, "unity.yml"),
    `- uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${oldSha} # v1.13.0\n`
  );
  // The two shapes a consumer keeps under .github/: a JSON pin table and a
  // script constant. The workflow walk selects YAML by name, so neither is
  // one of the files it rewrites.
  fs.writeFileSync(
    path.join(root, ".github", "lock-action-pins.json"),
    `{\n  "acquire-build-lock": "${oldSha}"\n}\n`
  );
  fs.mkdirSync(path.join(root, ".github", "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".github", "scripts", "test-central-unity-cleanup-policy.cjs"),
    `const policyCommit = "${oldSha}";\n`
  );
  const writePolicy = (companions) =>
    fs.writeFileSync(
      path.join(root, "policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        organization: "Ambiguous-Interactive",
        approvedLockShas: [oldSha, target],
        approvedReturnShas: [target],
        approvedDarwinReturnShas: [],
        repositories: [{ repository: "Ambiguous-Interactive/DoxReloaded" }],
        exceptions: [],
        repinExceptions: [],
        repinCompanions: companions
      })
    );
  const runRewrite = () =>
    childProcess.spawnSync(
      "bash",
      [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/DoxReloaded"],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: path.join(root, "policy.json") } }
    );

  writePolicy([
    { repository: "Ambiguous-Interactive/DoxReloaded", path: ".github/lock-action-pins.json", mode: "pin-literal" },
    { repository: "Ambiguous-Interactive/DoxReloaded", path: ".github/scripts/test-central-unity-cleanup-policy.cjs", mode: "pin-literal" }
  ]);
  const result = runRewrite();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(path.join(root, ".github", "lock-action-pins.json"), "utf8"),
    `{\n  "acquire-build-lock": "${target}"\n}\n`
  );
  assert.equal(
    fs.readFileSync(path.join(root, ".github", "scripts", "test-central-unity-cleanup-policy.cjs"), "utf8"),
    `const policyCommit = "${target}";\n`
  );

  // A .github YAML file stays refused: the workflow walk rewrites it, so a
  // second writer on the same file is a second interpretation of one pin.
  for (const yamlPath of [".github/unity-cleanup-policy.yml", ".github/workflows/unity.yml", ".github"]) {
    writePolicy([
      { repository: "Ambiguous-Interactive/DoxReloaded", path: yamlPath, mode: "pin-literal" }
    ]);
    const refused = runRewrite();
    assert.equal(refused.status, 1, `${yamlPath}: expected failure, got ${refused.status}`);
    assert.match(refused.stderr, /that is not a \.github YAML file/);
  }
});

test("consumer repin shields samples in a block scalar without shielding real pins", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-scalar-shield-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = repinOldSha;
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const lockRepository = "Ambiguous-Interactive/ambiguous-organization-build-lock";
  const workflows = path.join(root, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  const uses = (indent, action, sha, version) =>
    indent + "- uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/" +
    action + "@" + sha + " # v" + version;
  // Each case is one way a block-scalar detector can be wrong in the
  // expensive direction: marking a real pin as literal text. That reports no
  // change, the automation calls the repository already pinned, and the
  // consumer keeps a stale pin with nothing to show for it. Every header
  // spelling below is legal YAML, and the real pins must move under all of
  // them. `sample` marks the case as carrying a `uses:` line inside the
  // scalar, and `moves` is the change count the rewrite has to report.
  const cases = [
    {
      name: "a sequence item opens the scalar",
      why: "the block belongs to the MAPPING, not to the physical line, so a scalar opened by a step's first key must not shield that step's other keys",
      lines: [
        "      - name: |",
        "          Acquire the organization Unity build lock and wait for the queue.",
        "          Then run the licensed build to completion.",
        "        uses: " + lockRepository + "/.github/actions/acquire-build-lock@" + oldSha + " # v1.13.0",
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          repository: " + lockRepository,
        "          ref: " + oldSha,
        uses("      ", "release-build-lock", oldSha, "1.13.0")
      ],
      moves: 3,
      refs: 1,
      sample: false
    },
    {
      name: "an indented comment ends in a bar",
      why: "a comment is not a key, and a greedy leading indent backtracks, so the earlier pattern opened a block on one",
      lines: [
        "      # Reads the pin | and nothing else.",
        uses("      ", "acquire-build-lock", oldSha, "1.13.0"),
        uses("      ", "release-build-lock", oldSha, "1.13.0")
      ],
      moves: 2,
      refs: 0,
      sample: false
    },
    {
      name: "a sequence marker in front of a comment",
      why: "a step whose whole entry is a comment is a legal step, and the optional sequence marker backtracks so the key then accepts the comment character",
      lines: [
        "      - # policy checkout: |",
        uses("        ", "acquire-build-lock", oldSha, "1.13.0"),
        uses("      ", "release-build-lock", oldSha, "1.13.0")
      ],
      moves: 2,
      refs: 0,
      sample: false
    },
    {
      name: "a comment above a deeper block",
      why: "a comment is not a key, so it opens nothing; a shield that starts there swallows the rest of the file and the rewrite crashes",
      lines: [
        "jobs:",
        "  # The lock policy lives in the checkout below |",
        "  build:",
        "    steps:",
        uses("      ", "acquire-build-lock", oldSha, "1.13.0")
      ],
      moves: 1,
      refs: 0,
      sample: false,
      header: false
    },
    {
      name: "a quoted key holding a colon",
      why: "a quoted key may contain a colon, so a key pattern that stops at one misses the scalar",
      lines: [
        "      - \"a: b\": |",
        uses("          ", "acquire-build-lock", oldSha, "1.13.0"),
        uses("      ", "release-build-lock", oldSha, "1.13.0")
      ],
      moves: 1,
      refs: 0,
      sample: true
    },
    {
      name: "a sequence item that is a bare scalar",
      why: "the scalar can be the sequence item itself, with no key in front of it",
      lines: [
        "      - |",
        uses("          ", "acquire-build-lock", oldSha, "1.13.0"),
        uses("      ", "release-build-lock", oldSha, "1.13.0")
      ],
      moves: 1,
      refs: 0,
      sample: true
    },
    {
      name: "a tagged scalar",
      why: "a tag before the indicator is still a block scalar",
      lines: [
        "      - name: Emit",
        "        run: !!str |",
        uses("          ", "acquire-build-lock", oldSha, "1.13.0"),
        uses("      ", "release-build-lock", oldSha, "1.13.0")
      ],
      moves: 1,
      refs: 0,
      sample: true
    },
    {
      name: "an anchored scalar",
      why: "an anchor before the indicator is still a block scalar",
      lines: [
        "      - name: Emit",
        "        run: &doc |",
        uses("          ", "acquire-build-lock", oldSha, "1.13.0"),
        uses("      ", "release-build-lock", oldSha, "1.13.0")
      ],
      moves: 1,
      refs: 0,
      sample: true
    }
  ];
  const runRewrite = () =>
    childProcess.spawnSync(
      "bash",
      [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: path.join(root, "policy.json") } }
    );
  fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify({
    schemaVersion: 1,
    organization: "Ambiguous-Interactive",
    approvedLockShas: [oldSha, target],
    approvedReturnShas: [target],
    approvedDarwinReturnShas: [],
    repositories: [{ repository: "Ambiguous-Interactive/unity-helpers" }],
    exceptions: [],
    repinExceptions: [],
    repinCompanions: []
  }));
  const file = path.join(workflows, "unity.yml");
  for (const testCase of cases) {
    // A case that supplies its own document needs no header, and one that
    // starts at `jobs:` is testing the shield against the whole file.
    const prefix = testCase.header === false ? [] : ["jobs:", "  unity:", "    steps:"];
    fs.writeFileSync(file, prefix.concat(testCase.lines, [""]).join("\n"));
    const result = runRewrite();
    assert.equal(result.status, 0, testCase.name + ": " + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.changed, testCase.moves, testCase.name + ": " + testCase.why);
    assert.equal(report.refs, testCase.refs, testCase.name + ": moved ref: count");
    const rewritten = fs.readFileSync(file, "utf8");
    // Every case carries a real pin outside its scalar, so the count above is
    // the witness: a shield that swallowed a real pin would report fewer.
    assert.equal(
      (rewritten.match(new RegExp(target, "g")) || []).length,
      testCase.moves,
      testCase.name + ": the real pins did not all reach the target. " + testCase.why
    );
    // A `uses:` line inside the scalar is a sample: it stays at the old SHA,
    // and every other occurrence of that SHA is gone.
    const survivors = (rewritten.match(new RegExp(oldSha, "g")) || []).length;
    assert.equal(survivors, testCase.sample ? 1 : 0, testCase.name + ": old SHA count");
  }
});

test("the repin pull request body lists only the mutations that happened", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-body-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The body is what a reviewer reads before approving a merge, so a bullet
  // for a change the diff does not contain sends them looking for something
  // that is not there, and a doubled bullet marker renders as literal text.
  // `gh` is stubbed: this reads the body the script built and creates nothing.
  const bodyFor = (uses, refs) => {
    const captured = path.join(root, "body-" + uses + "-" + refs + ".md");
    const bin = path.join(root, "bin-" + uses + "-" + refs);
    fs.mkdirSync(bin, { recursive: true });
    const gh = path.join(bin, "gh");
    fs.writeFileSync(
      gh,
      ["#!/usr/bin/env bash",
       'for a in "$@"; do',
       '  if [ "$prev" = "--body-file" ]; then cp "$a" "' + captured + '"; fi',
       '  prev="$a"',
       "done",
       'echo "https://github.com/Ambiguous-Interactive/unity-helpers/pull/1"',
       ""].join("\n"),
      { mode: 0o755 }
    );
    // The dispatch at the end of the script would run a command, so the
    // functions are sourced from a copy that has it removed.
    const library = path.join(root, "lib-" + uses + "-" + refs + ".sh");
    fs.writeFileSync(library, fs.readFileSync(path.join(scriptsRoot, "repin-consumer-locks.sh"), "utf8").replace(/\ncase "\$\{1:-\}" in[\s\S]*$/, "\n"));
    // The arguments go through "$@" so a backtick in a file list stays text.
    const driver = path.join(bin, "driver.sh");
    fs.writeFileSync(
      driver,
      ['lock_repository_prefix="Ambiguous-Interactive/ambiguous-organization-build-lock"',
       "RUNNER_TEMP=" + JSON.stringify(root),
       "GITHUB_STEP_SUMMARY=" + JSON.stringify(path.join(root, "summary.md")),
       ". " + JSON.stringify(library),
       'open_repin_pull_request "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}"',
       ""].join("\n")
    );
    const result = childProcess.spawnSync(
      "bash",
      [driver, "Ambiguous-Interactive/unity-helpers", "repin/x", "v1.14.0",
       "abc1234567890abcdef1234567890abcdef12345678", "token",
       "- `unity.yml` (1 line)", "preserved", "companion", String(uses), String(refs)],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } }
    );
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(captured, "utf8");
  };
  for (const [uses, refs, expected, absent] of [
    [1, 0, ["- Only the `@<sha>` suffix"], []],
    [0, 1, ["- A checkout `ref:` naming"], []],
    [1, 1, ["- Only the `@<sha>` suffix", "- A checkout `ref:` naming"], []],
    [0, 0, ["- No `uses:` pin and no checkout `ref:` needed a change"], ["- Only the `@<sha>` suffix", "- A checkout `ref:` naming"]]
  ]) {
    const body = bodyFor(uses, refs);
    for (const line of expected) {
      assert.ok(body.includes(line), "uses=" + uses + " refs=" + refs + ": missing " + JSON.stringify(line) + "\n" + body);
    }
    for (const line of absent) {
      assert.ok(!body.includes(line), "uses=" + uses + " refs=" + refs + ": claims " + JSON.stringify(line) + "\n" + body);
    }
    // A bullet marker is a bullet marker, never two of them and never one
    // with nothing after it.
    assert.ok(!/^- - /m.test(body), "uses=" + uses + " refs=" + refs + ": doubled bullet\n" + body);
    assert.ok(!/^-[ \t]*\n/m.test(body), "uses=" + uses + " refs=" + refs + ": empty bullet\n" + body);
    const bullets = body.split("\n").filter((line) => line.startsWith("- ") || line.startsWith("  "));
    assert.ok(bullets.every((line) => line.trim().length > 0), "uses=" + uses + " refs=" + refs + ": blank bullet text");
  }
});

test("consumer repin reads a checkout ref: through every spelling a real step uses", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-ref-spellings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = repinOldSha;
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const lockRepository = "Ambiguous-Interactive/ambiguous-organization-build-lock";
  const workflows = path.join(root, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  const uses = (indent, action) =>
    indent + "- uses: " + lockRepository + "/.github/actions/" + action + "@" + oldSha + " # v1.13.0";
  const withBlock = (repository, ref) => [
    "        with:",
    "          repository: " + repository,
    "          ref: " + ref
  ];
  // Each case is a spelling a real workflow may use, and each one used to
  // freeze a real pin: the rewrite reported nothing to change, the
  // automation called the repository already pinned, and the stale pin had
  // no evidence against it. `moves` is the change count the rewrite has to
  // report, which is what proves nothing was left behind.
  const cases = [
    {
      name: "a comment on the with: line",
      why: "a step whose with: line carries a comment is ordinary YAML",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with: # inputs",
        "          repository: " + lockRepository,
        "          ref: " + oldSha,
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          ref: " + target
    },
    {
      name: "a quoted with: key",
      why: "a quoted key is the same key to a YAML reader and to GitHub, so a pattern that accepted only a bare word froze a real pin",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        \"with\":",
        "          repository: " + lockRepository,
        "          ref: " + oldSha,
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          ref: " + target
    },
    {
      name: "a quoted ref: key",
      why: "a quoted key is the same key to a YAML reader and to GitHub, and re-reading the key from the physical line rejected the spelling the key match accepts",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          repository: " + lockRepository,
        "          'ref': " + oldSha,
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          'ref': " + target
    },
    {
      name: "a quoted key and a space before its colon",
      why: "a quoted key may carry the same gap a bare one does",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          \"repository\" : " + lockRepository,
        "          \"ref\" : " + oldSha,
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          \"ref\" : " + target
    },
    {
      name: "a space before each colon",
      why: "YAML allows it and GitHub reads the key, so a pattern that required key: exactly froze a real pin",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with :",
        "          repository : " + lockRepository,
        "          ref : " + oldSha,
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          ref : " + target
    },
    {
      name: "a repository name in another case",
      why: "GitHub reads a repository name without regard to case, so a spelling that differs only in case names the same repository",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          repository: Ambiguous-Interactive/Ambiguous-Organization-Build-Lock",
        "          ref: " + oldSha,
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          ref: " + target
    },
    {
      name: "a ref: whose sibling keys are not a with: block",
      why: "the pattern that finds a with: block accepts any key, so the name is checked separately; a repository and ref pair under another key is not a checkout",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        env:",
        "          repository: " + lockRepository,
        "          ref: " + oldSha,
        uses("      ", "release-build-lock")
      ],
      refs: 0,
      staleSurvives: true
    },
    {
      name: "a ref: with a comment and no space before it",
      why: "YAML reads that hash as part of the plain scalar, so the value is not a commit and moving it would edit a line that is not a pin",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          repository: " + lockRepository,
        "          ref: " + oldSha + "# audited",
        uses("      ", "release-build-lock")
      ],
      refs: 0,
      staleSurvives: true
    },
    {
      name: "a with: block under a step whose name wraps onto the next line",
      why: "the continuation of a plain scalar is not a key and is not a step boundary, so the walk has to step over it",
      lines: [
        "      - name: a name long enough that the reader wraps it",
        "          onto a second line",
        "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        ...withBlock(lockRepository, oldSha),
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          ref: " + target
    },
    {
      name: "the step above the with: block opens a block scalar",
      why: "the body of a step's own env: scalar is text and not a key, and the backward walk has to step over it to reach the step that owns the block",
      lines: [
        "      - uses: azure/webapps-deploy@v3",
        "        env:",
        "          SCRIPT: |",
        "            echo not-a-key",
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        ...withBlock(lockRepository, oldSha),
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          ref: " + target
    },
    {
      name: "the last step of a file is not a checkout",
      why: "the walk runs to the end of the file, and a file that ends inside a step must not run off it",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          fetch-depth: 1",
        "      - uses: azure/webapps-deploy@v3",
        ...withBlock(lockRepository, oldSha),
        uses("      ", "release-build-lock")
      ],
      refs: 0,
      staleSurvives: true
    },
    {
      name: "a comment on the step's own uses: line",
      why: "the sibling with: line is read with its comment, so refusing one here would freeze a real pin while the run reports the repository already pinned",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # pin",
        "        with:",
        "          repository: " + lockRepository,
        "          ref: " + oldSha,
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          ref: " + target
    },
    {
      name: "a with: block written before the uses: it belongs to",
      why: "a YAML mapping is unordered and GitHub reads either order, so a walk that only reads upwards freezes a real pin",
      lines: [
        "      - with:",
        "          repository: " + lockRepository,
        "          ref: " + oldSha,
        "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          ref: " + target
    },
    {
      name: "a with: block on a reusable-workflow call",
      why: "repository and ref there are inputs of the workflow being called, and a checkout in an earlier job is not this step's anchor",
      header: false,
      lines: [
        "name: call",
        "on: push",
        "jobs:",
        "  a:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "  b:",
        "    uses: ./.github/workflows/policy.yml",
        "    with:",
        "      repository: " + lockRepository,
        "      ref: " + oldSha,
        uses("  ", "release-build-lock")
      ],
      refs: 0,
      staleSurvives: true
    },
    {
      name: "a uses: nested inside a step that is not a checkout",
      why: "every key of a block mapping shares one column, so a uses: deeper than the with: belongs to a mapping nested in the step and is not the step's own",
      lines: [
        "      - uses: azure/webapps-deploy@v3",
        "        with:",
        "          args:",
        "            uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "          repository: " + lockRepository,
        "          ref: " + oldSha,
        uses("      ", "release-build-lock")
      ],
      refs: 0,
      staleSurvives: true
    },
    {
      name: "the file ends inside a step that is not a checkout",
      why: "the walk runs to the end of the line list, and a file whose last step is the one holding the block must end the walk there",
      header: false,
      lines: [
        "jobs:",
        "  unity:",
        "    steps:",
        uses("      ", "release-build-lock"),
        "      - uses: azure/webapps-deploy@v3",
        ...withBlock(lockRepository, oldSha)
      ],
      refs: 0,
      staleSurvives: true
    },
    {
      name: "a wider gap in front of the value",
      why: "the gap in front of the value is the consumer's own spacing, and a rewrite that re-spaces it edits a byte the pin did not name",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          repository: " + lockRepository,
        "          ref:  " + oldSha,
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          ref:  " + target
    },
    {
      name: "a child of the block written as a sequence item",
      why: "the marker in front of the key is part of the line, and a rebuild from the key alone dropped the dash and turned a file that parsed into one that does not",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          - ref: " + oldSha,
        "            repository: " + lockRepository,
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          - ref: " + target
    },
    {
      name: "the block names this repository twice",
      why: "a key written twice is read as the last one, and this rule is in no position to say which of the two the reader used",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          repository: " + lockRepository,
        "          repository: Ambiguous-Interactive/unity-helpers",
        "          ref: " + oldSha,
        uses("      ", "release-build-lock")
      ],
      refs: 0,
      staleSurvives: true
    },
    {
      name: "the block names this repository twice, the other way round",
      why: "the order of the two names does not change that the block is not read",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          repository: Ambiguous-Interactive/unity-helpers",
        "          repository: " + lockRepository,
        "          ref: " + oldSha,
        uses("      ", "release-build-lock")
      ],
      refs: 0,
      staleSurvives: true
    },
    {
      name: "the block writes ref: twice",
      why: "two refs and one is not the key this rule reads",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          repository: " + lockRepository,
        "          ref: main",
        "          ref: " + oldSha,
        uses("      ", "release-build-lock")
      ],
      refs: 0,
      staleSurvives: true
    },
    {
      name: "trailing whitespace on the step's own uses: value",
      why: "the value is read without its comment and without the space behind it, so a step whose uses: line ends in a space still anchors",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1   ",
        ...withBlock(lockRepository, oldSha),
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          ref: " + target
    },
    {
      name: "a tab-indented ref: line",
      why: "the indent is carried as text and not as a width, so a block whose own indent is tabs comes back with its tabs",
      lines: [
        "\t- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "\t  with:",
        "\t    repository: " + lockRepository,
        "\t    ref: " + oldSha,
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "\t    ref: " + target
    },
    {
      name: "a tab-indented ref: line beside a space-indented sibling",
      why: "a tab-indented line is not a key of a space-indented block, and a key that is not a direct child is not this rule's to move",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          repository: " + lockRepository,
        "\t        ref: " + oldSha,
        uses("      ", "release-build-lock")
      ],
      refs: 0,
      staleSurvives: true
    },
    {
      name: "a tab in front of the value",
      why: "a tab is a legal gap after a colon, and it is the consumer's own",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          repository: " + lockRepository,
        "          ref:\t" + oldSha,
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          ref:\t" + target
    },
    {
      name: "trailing whitespace after the value",
      why: "the value is read whole, and the whitespace behind it is part of the line the consumer wrote",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          repository: " + lockRepository,
        "          ref: " + oldSha + "   ",
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          ref: " + target + "   "
    },
    {
      name: "trailing whitespace after a comment",
      why: "a comment is not the value, so the whitespace behind it survives too",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          repository: " + lockRepository,
        "          ref: " + oldSha + "  # audited  ",
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          ref: " + target + "  # audited  "
    },
    {
      name: "a comment on the ref: line, with the consumer's own gap",
      why: "a comment is a reviewer's note about the pin, and a rewrite that dropped it would delete evidence while the pin still moved",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          repository: " + lockRepository,
        "          ref: " + oldSha + "   # audited 2026-01-02",
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          ref: " + target + "   # audited 2026-01-02"
    },
    {
      name: "a single-space comment gap on the ref: line",
      why: "the gap is the consumer's own spacing, and the repin must not re-space it",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          repository: " + lockRepository,
        "          ref: " + oldSha + " # v1.13.0",
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          ref: " + target + " # v1.13.0"
    },
    {
      name: "a comment on the ref: line of a quoted key",
      why: "the comment and the key spelling are both rebuilt from the parsed line",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          repository: " + lockRepository,
        "          'ref': " + oldSha + "  # note",
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          'ref': " + target + "  # note"
    },
    {
      name: "a capital Repository and Ref key",
      why: "GitHub reads an action's with: keys without regard to case",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          Repository: " + lockRepository,
        "          Ref: " + oldSha,
        uses("      ", "release-build-lock")
      ],
      refs: 1,
      refLine: "          Ref: " + target
    }
  ];
  const runRewrite = () =>
    childProcess.spawnSync(
      "bash",
      [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: path.join(root, "policy.json") } }
    );
  fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify({
    schemaVersion: 1,
    organization: "Ambiguous-Interactive",
    approvedLockShas: [oldSha, target],
    approvedReturnShas: [target],
    approvedDarwinReturnShas: [],
    repositories: [{ repository: "Ambiguous-Interactive/unity-helpers" }],
    exceptions: [],
    repinExceptions: [],
    repinCompanions: []
  }));
  const file = path.join(workflows, "unity.yml");
  for (const testCase of cases) {
    const prefix = testCase.header === false ? [] : ["jobs:", "  unity:", "    steps:"];
    fs.writeFileSync(file, prefix.concat(testCase.lines, [""]).join("\n"));
    const result = runRewrite();
    assert.equal(result.status, 0, testCase.name + ": " + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.refs, testCase.refs, testCase.name + ": " + testCase.why);
    assert.equal(report.changed, testCase.refs + 1, testCase.name + ": " + testCase.why);
    // A count proves a pin moved; the line proves how it was rebuilt. Only the
    // SHA may change, so the key spelling, the gap before the colon, the
    // indentation and any comment have to come back out as they went in.
    const rewritten = fs.readFileSync(file, "utf8");
    if (testCase.refLine !== undefined) {
      assert.ok(
        rewritten.split("\n").includes(testCase.refLine),
        testCase.name + ": the rewritten line is not exactly " + JSON.stringify(testCase.refLine) + "\n" + rewritten
      );
    }
    const after = fs.readFileSync(file, "utf8");
    // A case that keeps a value on purpose says so; every other one must
    // leave no occurrence of the old SHA behind.
    if (!testCase.staleSurvives) {
      assert.equal(
        after.includes(oldSha),
        false,
        testCase.name + ": a stale pin survived. " + testCase.why
      );
    } else {
      // A refusal is not a partial rewrite of the block. The sibling lock pin
      // this case carries does move, so what is checked is every other line:
      // only a line that now carries the new target may differ at all, and it
      // has to have carried the old one before.
      const before = prefix.concat(testCase.lines, [""]).join("\n").split("\n");
      const now = after.split("\n");
      assert.equal(now.length, before.length, testCase.name + ": the line count changed. " + testCase.why);
      for (let index = 0; index < now.length; index += 1) {
        if (now[index] === before[index]) {
          continue;
        }
        assert.ok(
          before[index].includes(oldSha) && now[index].includes(target),
          testCase.name + ": a line changed that did not carry the pin:\n  - " +
            before[index] + "\n  + " + now[index] + "\n" + testCase.why
        );
        // The change is the SHA, and the version comment that tracks it: a
        // `uses:` pin's `# vX.Y.Z` label names the release it was pinned at, so
        // moving the SHA moves the label with it. Nothing else on the line may
        // change, and an exact comparison is what says so: a dropped marker, a
        // re-spaced key or a rewritten path all fail here, where a comparison
        // of segment counts would not.
        const expected = before[index]
          .split(oldSha).join(target)
          .replace(/# v\d+\.\d+\.\d+/, "# v1.14.0");
        assert.equal(
          now[index],
          expected,
          testCase.name + ": more than the SHA and its version comment changed on this line:\n  - " +
            before[index] + "\n  + " + now[index] + "\n  want " + expected
        );
      }
    }
  }
  // The value keeps its own case rule: an uppercase SHA is not an immutable
  // commit this rewrite will move, so the ref: stays and the other pin moves.
  fs.writeFileSync(
    file,
    [
      "jobs:",
      "  unity:",
      "    steps:",
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "        with:",
      "          repository: " + lockRepository,
      "          ref: " + oldSha.toUpperCase(),
      uses("      ", "release-build-lock"),
      ""
    ].join("\n")
  );
  const upper = runRewrite();
  assert.equal(upper.status, 0, upper.stderr);
  assert.equal(JSON.parse(upper.stdout).refs, 0, "an uppercase SHA is not moved");
});

test("consumer repin moves a checkout ref: only on a checkout step", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-ref-anchor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = repinOldSha;
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const lockRepository = "Ambiguous-Interactive/ambiguous-organization-build-lock";
  const workflows = path.join(root, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  const withBlock = (repository, ref) => [
    "        with:",
    "          repository: " + repository,
    "          ref: " + ref
  ];
  // `repository:` and `ref:` are only checkout inputs on an `actions/checkout`
  // step. A reusable-workflow call passes both to the called workflow as its
  // own inputs, and any other action is free to mean something else by them,
  // so the step is an anchor and not an assumption. Each of these is a real
  // wrong write the anchor refuses: the offered commit would change a value
  // whose meaning the rewrite does not know.
  const cases = [
    {
      name: "a reusable-workflow call",
      lines: [
        "  call:",
        "    uses: Ambiguous-Interactive/shared/.github/workflows/policy.yml@abc",
        ...withBlock(lockRepository, oldSha)
      ],
      refs: 0
    },
    {
      name: "a deploy action",
      lines: [
        "      - uses: azure/webapps-deploy@v3",
        ...withBlock(lockRepository, oldSha)
      ],
      refs: 0
    },
    {
      name: "a step below a checkout step",
      why: "the walk above stops at this step's own sequence marker, so a checkout in the step above cannot lend its anchor to a ref: that is not a checkout here",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          fetch-depth: 1",
        "      - uses: azure/webapps-deploy@v3",
        ...withBlock(lockRepository, oldSha)
      ],
      refs: 0
    },
    {
      name: "a non-checkout step with the pair, then a checkout step",
      why: "the walk has to end at the next step, and a checkout after the block is not the step the block belongs to",
      lines: [
        "      - uses: azure/webapps-deploy@v3",
        ...withBlock(lockRepository, oldSha),
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          fetch-depth: 1",
      ],
      refs: 0,
      staleSurvives: true
    },
    {
      name: "a step whose own name holds a checkout-shaped value",
      why: "the anchor is the key `uses:` and not any value that looks like a checkout, and a name is free to hold one",
      lines: [
        "      - name: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        run: echo hi",
        ...withBlock(lockRepository, oldSha)
      ],
      refs: 0,
      staleSurvives: true
    },
    {
      name: "a step whose uses: is another action at a literal commit",
      why: "an enrolled consumer checks out a different repository at a literal 40-character commit, and that step is not the checkout the anchor names",
      lines: [
        "      - uses: azure/webapps-deploy@3d3c42e5aac5ba805825da76410c181273ba90b1",
        ...withBlock(lockRepository, oldSha)
      ],
      refs: 0,
      staleSurvives: true
    },
    {
      name: "a checkout uses: whose SHA is uppercase",
      why: "the anchor takes the lowercase hexadecimal spelling the pinned form is written in, and an uppercase one is not it",
      lines: [
        "      - uses: actions/checkout@3D3C42E5AAC5BA805825DA76410C181273BA90B1",
        ...withBlock(lockRepository, oldSha)
      ],
      refs: 0,
      staleSurvives: true
    },
    {
      name: "a with: block beside the sequence item rather than in it",
      why: "a step's keys share the column of the marker line's key, so a with: written beside the item belongs to no step",
      lines: [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "      with:",
        "        repository: " + lockRepository,
        "        ref: " + oldSha,
      ],
      refs: 0,
      staleSurvives: true
    },
    {
      name: "a with: block on a job, below a checkout step",
      why: "the walk up from the block meets the step's marker first, and a marker only owns the column its own keys sit in, so a block one column left belongs to no step",
      header: false,
      lines: [
        "on: push",
        "jobs:",
        "  a:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          fetch-depth: 1",
        "    with:",
        "      repository: " + lockRepository,
        "      ref: " + oldSha,
        "  b:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: " + lockRepository + "/.github/actions/release-build-lock@" + oldSha + " # v1.13.0"
      ],
      refs: 0,
      staleSurvives: true,
      selfContained: true
    },
    {
      name: "a job with no uses: at all",
      lines: [
        "  job:",
        "    runs-on: ubuntu-latest",
        ...withBlock(lockRepository, oldSha)
      ],
      refs: 0
    }
  ];
  const runRewrite = () =>
    childProcess.spawnSync(
      "bash",
      [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: path.join(root, "policy.json") } }
    );
  fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify({
    schemaVersion: 1,
    organization: "Ambiguous-Interactive",
    approvedLockShas: [oldSha, target],
    approvedReturnShas: [target],
    approvedDarwinReturnShas: [],
    repositories: [{ repository: "Ambiguous-Interactive/unity-helpers" }],
    exceptions: [],
    repinExceptions: [],
    repinCompanions: []
  }));
  const file = path.join(workflows, "unity.yml");
  const realPin = "      - uses: " + lockRepository + "/.github/actions/release-build-lock@" + oldSha + " # v1.13.0";
  for (const testCase of cases) {
    // A self-contained case is a whole file: it carries its own header, its own
    // trailing pin, and nothing is appended to it.
    const head = testCase.selfContained ? [] : ["jobs:", "  a:", "    steps:"];
    const tail = testCase.selfContained ? [""] : [realPin, ""];
    fs.writeFileSync(file, [...head, ...testCase.lines, ...tail].join("\n"));
    const result = runRewrite();
    assert.equal(result.status, 0, testCase.name + ": " + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.refs, testCase.refs, testCase.name + ": the ref: must not move");
    assert.equal(report.uses, 1, testCase.name + ": the sibling pin still moves");
    assert.equal(
      fs.readFileSync(file, "utf8").includes(oldSha),
      true,
      testCase.name + ": the unanchored ref: is left as the consumer wrote it"
    );
  }
  // The same block on a checkout step does move, so the anchor is the
  // difference and not the block shape.
  fs.writeFileSync(
    file,
    [
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      ...withBlock(lockRepository, oldSha),
      realPin,
      ""
    ].join("\n")
  );
  const anchored = runRewrite();
  assert.equal(anchored.status, 0, anchored.stderr);
  assert.equal(JSON.parse(anchored.stdout).refs, 1, "an actions/checkout step moves the ref:");
});

test("consumer repin does not read a comment gap out of a block scalar", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-scalar-gap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = repinOldSha;
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const lockRepository = "Ambiguous-Interactive/ambiguous-organization-build-lock";
  const workflows = path.join(root, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  // A moved pin without a version comment needs a gap to add one, and the
  // only evidence is what the repository already writes. A comment gap inside
  // a block scalar is a sample's formatting, so reading it would put a gap on
  // a real pin that the consumer never wrote. With the guard the run fails
  // closed for want of evidence; without it, the run silently writes the
  // sample's gap onto both real pins.
  fs.writeFileSync(
    path.join(workflows, "unity.yml"),
    [
      "jobs:",
      "  unity:",
      "    steps:",
      `      - uses: ${lockRepository}/.github/actions/acquire-build-lock@${oldSha}`,
      "      - name: Emit",
      "        run: |",
      `          - uses: ${lockRepository}/.github/actions/return-unity-license@${oldSha}   # v1.13.0`,
      `      - uses: ${lockRepository}/.github/actions/release-build-lock@${oldSha}`
    ].join("\n")
  );
  fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify({
    schemaVersion: 1,
    organization: "Ambiguous-Interactive",
    approvedLockShas: [oldSha, target],
    approvedReturnShas: [target],
    approvedDarwinReturnShas: [],
    repositories: [{ repository: "Ambiguous-Interactive/unity-helpers" }],
    exceptions: [],
    repinExceptions: [],
    repinCompanions: []
  }));
  const result = childProcess.spawnSync(
    "bash",
    [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: path.join(root, "policy.json") } }
  );
  assert.equal(result.status, 1, `expected failure, got ${result.status}: ${result.stdout}`);
  assert.match(result.stderr, /needs a version comment[\s\S]*None of its lock pins carries/);
  assert.equal(
    fs.readFileSync(path.join(workflows, "unity.yml"), "utf8").includes(target),
    false,
    "a fail-closed run leaves every real pin untouched"
  );
});

test("consumer repin treats a workflow sample inside a block scalar as text", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-scalar-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = repinOldSha;
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const lockRepository = "Ambiguous-Interactive/ambiguous-organization-build-lock";
  const workflows = path.join(root, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  // A `run: |` body is where a workflow is written, quoted, and asserted on.
  // The sample below is the very shape this rewrite moves, embedded as text.
  // Rewriting it would edit a script instead of a pin, and the `uses:` sample
  // has the same problem the `ref:` sample does.
  const sample = [
    "      - name: Check the contract fixture",
    "        run: |",
    "          cat > expected.yml <<'YAML'",
    `          - uses: ${lockRepository}/.github/actions/acquire-build-lock@${oldSha} # v1.13.0`,
    "            with:",
    `              repository: ${lockRepository}`,
    `              ref: ${oldSha}`,
    "          YAML",
    ""
  ];
  fs.writeFileSync(
    path.join(workflows, "unity.yml"),
    [
      "jobs:",
      "  unity:",
      "    steps:",
      // The real pins, after the scalar, at a shallower indent than its body.
      // The `with:` hangs off an `actions/checkout` step because that is the
      // step the `ref:` rule is anchored on: a `repository:` and a `ref:` on
      // any other step are that step's own inputs, not a checkout of here.
      `      - uses: ${lockRepository}/.github/actions/acquire-build-lock@${oldSha} # v1.13.0`,
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "        with:",
      `          repository: ${lockRepository}`,
      `          ref: ${oldSha}`,
      "      - name: Emit a workflow",
      ...sample
    ].join("\n")
  );
  fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify({
    schemaVersion: 1,
    organization: "Ambiguous-Interactive",
    approvedLockShas: [oldSha, target],
    approvedReturnShas: [target],
    approvedDarwinReturnShas: [],
    repositories: [{ repository: "Ambiguous-Interactive/unity-helpers" }],
    exceptions: [],
    repinExceptions: [],
    repinCompanions: []
  }));
  const result = childProcess.spawnSync(
    "bash",
    [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: path.join(root, "policy.json") } }
  );
  assert.equal(result.status, 0, result.stderr);
  const rewritten = fs.readFileSync(path.join(workflows, "unity.yml"), "utf8");
  // The sample is byte-identical: both its `uses:` line and its `ref:`.
  assert.ok(
    rewritten.includes(sample.join("\n")),
    `expected the block scalar body to survive:\n${rewritten}`
  );
  // The real pins above it both moved.
  assert.ok(
    rewritten.includes(
      `      - uses: ${lockRepository}/.github/actions/acquire-build-lock@${target} # v1.14.0\n` +
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n" +
      "        with:\n" +
      `          repository: ${lockRepository}\n` +
      `          ref: ${target}\n`
    ),
    `expected the real pins to move:\n${rewritten}`
  );
  // The report counts the two mutations apart, so a caller can describe
  // exactly what changed: one `uses:` pin and one checkout `ref:`.
  assert.deepEqual(JSON.parse(result.stdout).files, [{ path: ".github/workflows/unity.yml", lines: 2 }]);
  assert.equal(JSON.parse(result.stdout).uses, 1);
  assert.equal(JSON.parse(result.stdout).refs, 1);
});

test("consumer repin moves a checkout ref: in CRLF and wide-indent workflows", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-crlf-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = repinOldSha;
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const lockRepository = "Ambiguous-Interactive/ambiguous-organization-build-lock";
  const workflows = path.join(root, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  // A workflow file may end its lines with CRLF. `split("\n")` leaves the
  // `\r` on every line, and a `$` anchor does not match before it, so a pin
  // or a ref: that is not stripped first matches nothing: the rewrite reports
  // no change, the automation closes its own offer as superseded, and the
  // consumer keeps a stale pin with no evidence that anything was missed.
  // The `ref:` is not the last line, so it carries a terminator like every
  // other. The wide indent is the other half: the block scan learns the child
  // indent from the first deeper line, so it must not assume two spaces.
  fs.writeFileSync(
    path.join(workflows, "unity.yml"),
    [
      "jobs:",
      "    unity:",
      "        steps:",
      `            - uses: ${lockRepository}/.github/actions/acquire-build-lock@${oldSha} # v1.13.0`,
      "            - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "              with:",
      `                  repository: ${lockRepository}`,
      `                  ref: ${oldSha}`,
      "                  path: .central-build-lock-policy"
    ].join("\r\n")
  );
  fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify({
    schemaVersion: 1,
    organization: "Ambiguous-Interactive",
    approvedLockShas: [oldSha, target],
    approvedReturnShas: [target],
    approvedDarwinReturnShas: [],
    repositories: [{ repository: "Ambiguous-Interactive/unity-helpers" }],
    exceptions: [],
    repinExceptions: [],
    repinCompanions: []
  }));
  const runRewrite = () =>
    childProcess.spawnSync(
      "bash",
      [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: path.join(root, "policy.json") } }
    );
  const result = runRewrite();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(path.join(workflows, "unity.yml"), "utf8"),
    [
      "jobs:",
      "    unity:",
      "        steps:",
      `            - uses: ${lockRepository}/.github/actions/acquire-build-lock@${target} # v1.14.0`,
      "            - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "              with:",
      `                  repository: ${lockRepository}`,
      `                  ref: ${target}`,
      "                  path: .central-build-lock-policy"
    ].join("\r\n"),
    "a CRLF workflow keeps CRLF, and a wide indent still matches"
  );
  assert.equal(JSON.parse(result.stdout).refs, 1, "the moved ref: is reported apart");
  const rerun = runRewrite();
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(JSON.parse(rerun.stdout).changed, 0);
});

test("consumer repin fails closed on a pin-literal companion a moved ref: cannot account for", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-ref-witness-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = repinOldSha;
  const target = "64bac446903115134dca8235410b332bc5a83547";
  // Authorized in the policy but named by no workflow: the wrong-but-plausible
  // witness a mechanical rewrite cannot tell from a stale pin constant.
  const witnessSha = "0854a7d586640e5d12e3559d789c481c232ed044";
  const lockRepository = "Ambiguous-Interactive/ambiguous-organization-build-lock";
  const workflows = path.join(root, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  // The only lock pin this repository carries is a checkout `ref:`. Its move
  // heals the companion's copy of that one SHA and nothing else, so a
  // different approved SHA standing in the companion is still unaccounted
  // for. A whole-run check would see a moved pin and skip the question.
  fs.writeFileSync(
    path.join(workflows, "unity.yml"),
    [
      "jobs:",
      "  unity:",
      "    steps:",
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "        with:",
      `          repository: ${lockRepository}`,
      `          ref: ${oldSha}`
    ].join("\n")
  );
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  const companion = path.join(root, "tests", "pin-contract.js");
  fs.writeFileSync(companion, `const policyCommit = "${witnessSha}";\n`);
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
  const runRewrite = () =>
    childProcess.spawnSync(
      "bash",
      [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/unity-helpers"],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: path.join(root, "policy.json") } }
    );

  const result = runRewrite();
  assert.equal(result.status, 1, `expected failure, got ${result.status}: ${result.stdout}`);
  assert.match(result.stderr, /still names an authorized pin that no workflow pin this rewrite removes accounts for/);
  assert.equal(
    fs.readFileSync(companion, "utf8"),
    `const policyCommit = "${witnessSha}";\n`,
    "a fail-closed run leaves the companion and the workflow untouched"
  );
  assert.equal(
    fs.readFileSync(path.join(workflows, "unity.yml"), "utf8").includes(`ref: ${target}`),
    false,
    "a fail-closed run leaves the workflow untouched"
  );

  // The same companion naming the target beside the witness is a reviewed
  // witness next to a healed constant, and rides on the ref: that moved.
  fs.writeFileSync(companion, `const policyCommit = "${witnessSha}";\nconst checked = "${target}";\n`);
  const healed = runRewrite();
  assert.equal(healed.status, 0, healed.stderr);
  assert.equal(
    fs.readFileSync(companion, "utf8"),
    `const policyCommit = "${witnessSha}";\nconst checked = "${target}";\n`
  );
  assert.equal(JSON.parse(healed.stdout).changed, 1, "only the workflow ref: moved");
});

test("consumer repin carries a companion the moved ref: accounts for", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-ref-companion-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldSha = repinOldSha;
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const lockRepository = "Ambiguous-Interactive/ambiguous-organization-build-lock";
  const workflows = path.join(root, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  // A `ref:` is a pin this repository carries, so a `pin-literal` companion
  // quoting the same commit has to heal with it. This is the DoxReloaded
  // shape: a policy checkout is the only place the release SHA is named.
  fs.writeFileSync(
    path.join(workflows, "unity.yml"),
    [
      "jobs:",
      "  unity:",
      "    steps:",
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "        with:",
      `          repository: ${lockRepository}`,
      `          ref: ${oldSha}`
    ].join("\n")
  );
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "scripts", "validate-unity-cleanup-reason-contract.py"),
    `POLICY_SHA = "${oldSha}"\n`
  );
  fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify({
    schemaVersion: 1,
    organization: "Ambiguous-Interactive",
    approvedLockShas: [oldSha, target],
    approvedReturnShas: [target],
    approvedDarwinReturnShas: [],
    repositories: [{ repository: "Ambiguous-Interactive/DoxReloaded" }],
    exceptions: [],
    repinExceptions: [],
    repinCompanions: [
      { repository: "Ambiguous-Interactive/DoxReloaded", path: "scripts/validate-unity-cleanup-reason-contract.py", mode: "pin-literal" }
    ]
  }));
  const result = childProcess.spawnSync(
    "bash",
    [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/DoxReloaded"],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: path.join(root, "policy.json") } }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(path.join(root, "scripts", "validate-unity-cleanup-reason-contract.py"), "utf8"),
    `POLICY_SHA = "${target}"\n`
  );
  assert.deepEqual(JSON.parse(result.stdout).companions, [
    { path: "scripts/validate-unity-cleanup-reason-contract.py", mode: "pin-literal", lines: 1 }
  ]);
});

test("consumer repin refuses a .github that is not a real directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-github-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const workflows = path.join(root, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  fs.writeFileSync(
    path.join(workflows, "unity.yml"),
    `- uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${repinOldSha} # v1.13.0\n`
  );
  // A committed symlink at `.github` would send the rewrite into a directory
  // outside the reviewed checkout, and the report would name paths that do
  // not exist in it. The `.github` companion class leans on this refusal, so
  // it is exercised here rather than only by hand.
  const real = path.join(root, "real-github");
  fs.mkdirSync(path.join(real, "workflows"), { recursive: true });
  fs.writeFileSync(path.join(real, "workflows", "unity.yml"), "untouched\n");
  fs.writeFileSync(
    path.join(real, "lock-action-pins.json"),
    `{"acquire-build-lock": "${repinOldSha}"}\n`
  );
  fs.rmSync(path.join(root, ".github"), { recursive: true });
  fs.symlinkSync(real, path.join(root, ".github"));
  fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify({
    schemaVersion: 1,
    organization: "Ambiguous-Interactive",
    approvedLockShas: [repinOldSha, target],
    approvedReturnShas: [target],
    approvedDarwinReturnShas: [],
    repositories: [{ repository: "Ambiguous-Interactive/DoxReloaded" }],
    exceptions: [],
    repinExceptions: [],
    repinCompanions: [
      { repository: "Ambiguous-Interactive/DoxReloaded", path: ".github/lock-action-pins.json", mode: "pin-literal" }
    ]
  }));
  const result = childProcess.spawnSync(
    "bash",
    [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", "Ambiguous-Interactive/DoxReloaded"],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: path.join(root, "policy.json") } }
  );
  assert.equal(result.status, 1, `expected failure, got ${result.status}`);
  assert.match(result.stderr, /refuse a \.github that is not a directory/);
  assert.equal(
    fs.readFileSync(path.join(real, "lock-action-pins.json"), "utf8"),
    `{"acquire-build-lock": "${repinOldSha}"}\n`,
    "a refused run writes nothing outside the reviewed checkout"
  );
  assert.equal(
    fs.readFileSync(path.join(real, "workflows", "unity.yml"), "utf8"),
    "untouched\n"
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
    `- uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@${repinOldSha} # v1.13.0\n`
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

test("consumer repin refuses a file it would write and cannot read as UTF-8", (t) => {
  const cases = [];
  for (const surface of repinReadableSurfaces) {
    for (const [description, bytes] of Object.entries(undecodableBytes)) {
      cases.push({ surface, description, bytes, moves: true });
      if (surface.stays !== null) {
        cases.push({ surface, description, bytes, moves: false });
      }
    }
  }
  for (const { surface, description, bytes, moves } of cases) {
    const label = `${surface.name} that ${moves ? "changes" : "does not change"} and carries ${description}`;
    // A fresh checkout per case: the outcome has to hold whatever else the
    // checkout carries, and a refused run must leave every byte of it alone.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-utf8-refusal-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(root, surface.path)), { recursive: true });
    // A clean workflow whose pin moves in every case, so the run has real work
    // to do and a run that stays green has still done it.
    const movedRelative = path.posix.join(".github", "workflows", "unity.yml");
    fs.writeFileSync(path.join(root, movedRelative), `- uses: ${repinActionPath}@${repinOldSha} # v1.13.0\n`);
    fs.writeFileSync(
      path.join(root, surface.path),
      Buffer.concat([
        Buffer.from(moves ? surface.moves() : surface.stays(), "utf8"),
        Buffer.from("caf\u00e9 \u2014 "),
        Buffer.from(bytes),
        Buffer.from("\n")
      ])
    );
    fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify({
      schemaVersion: 1,
      organization: "Ambiguous-Interactive",
      approvedLockShas: [repinOldSha, repinTarget],
      approvedReturnShas: [repinOldSha, repinTarget],
      approvedDarwinReturnShas: [],
      repositories: [{ repository: repinOrganization, defaultBranch: "main" }],
      exceptions: [],
      repinExceptions: [],
      repinCompanions: surface.mode === null
        ? []
        : [{ repository: repinOrganization, path: surface.path, mode: surface.mode }]
    }));
    const before = snapshotBytes(root);
    const result = childProcess.spawnSync(
      "bash",
      [
        path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins",
        root, repinTarget, "v1.14.0", repinOrganization
      ],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: path.join(root, "policy.json") } }
    );
    if (!moves) {
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      assert.equal(
        fs.readFileSync(path.join(root, movedRelative), "utf8"),
        `- uses: ${repinActionPath}@${repinTarget} # v1.14.0\n`,
        `${label}: the run must still move every other pin`
      );
    } else {
      assert.equal(result.status, 1, `${label}: expected failure, got ${result.status}: ${result.stdout}`);
      assert.match(result.stderr, /not valid UTF-8/, `${label}: ${result.stderr}`);
      assert.ok(
        result.stderr.includes(surface.path),
        `${label}: the error must name ${surface.path}: ${result.stderr}`
      );
      assert.equal(result.stdout, "", `${label}: a refused rewrite reports nothing it could offer`);
    }
    // Either way the file the rewrite refused to read keeps every byte it was
    // given: refusing and skipping are both byte-exact.
    const after = snapshotBytes(root);
    for (const [relative, bytesBefore] of Object.entries(before)) {
      // A refused run writes nothing at all, so the moving pin stays put too. A
      // green run moves it, which is the only file the assertion may skip.
      if (relative === "policy.json" || (!moves && relative === movedRelative)) {
        continue;
      }
      assert.ok(after[relative].equals(bytesBefore), `${label}: the rewrite changed ${relative}`);
    }
  }
});

test("consumer repin changes only the pin bytes of a file it can read exactly", (t) => {
  const target = "64bac446903115134dca8235410b332bc5a83547";
  const repository = "Ambiguous-Interactive/unity-helpers";
  const pinLine = (indent, sha, version) => `${indent}- uses: ${repinActionPath}@${sha} # ${version}`;
  // A file the rewrite must read and write without touching a byte the pin
  // does not name. `render` is the whole file for one pin state, so the
  // assertion is exact: the rewrite's output has to equal the fixture for the
  // target release, and nothing else.
  const fixtures = [
    {
      name: "a byte order mark in front of the pin",
      surfaces: ["a pin-lines companion"],
      render: (sha, version) => `\uFEFF${pinLine("", sha, version)}\n`
    },
    {
      name: "a byte order mark in front of the first line",
      surfaces: ["a pin-lines companion", "a workflow file"],
      render: (sha, version) => `\uFEFFname: pins\n${pinLine("      ", sha, version)}\n`
    },
    {
      name: "CRLF line endings",
      surfaces: ["a pin-lines companion", "a workflow file"],
      render: (sha, version) => `# pins\r\n${pinLine("  ", sha, version)}\r\n`
    },
    {
      name: "no line feed after the last pin",
      surfaces: ["a pin-lines companion", "a workflow file"],
      render: (sha, version) => `# pins\n${pinLine("  ", sha, version)}`
    },
    {
      name: "tab indentation",
      surfaces: ["a pin-lines companion", "a workflow file"],
      render: (sha, version) => `# pins\n\t${pinLine("", sha, version)}\n`
    },
    {
      name: "two-byte and four-byte characters beside the pin",
      surfaces: ["a pin-lines companion", "a workflow file"],
      render: (sha, version) =>
        `# caf\u00e9 \u2014 \u{1F680}\n${pinLine("  ", sha, version)}\n# caf\u00e9 \u2014 \u{1F680}\n`
    },
    {
      // A witness comment is not a version comment, so a moved pin leaves it
      // exactly as the consumer wrote it. The version in it is the consumer's
      // own evidence and never follows the release.
      name: "a witness comment on the pin line",
      surfaces: ["a pin-lines companion", "a workflow file"],
      render: (sha) => `# pins\n${pinLine("  ", sha, "v1.13.0")} reviewed 2026-01-01\n`
    },
    {
      name: "a second pin line in the same file",
      surfaces: ["a pin-lines companion", "a workflow file"],
      render: (sha, version) => `# pins\n${pinLine("  ", sha, version)}\n${pinLine("  ", sha, version)}\n`
    },
    {
      // The one surface where the base rewrite lost bytes through the mark
      // alone: the mode generates the document, so the mark has to be carried
      // aside and back on, or every run drops it. One mark and two both.
      name: "a byte order mark in front of a policy-snapshot companion",
      surfaces: ["a policy-snapshot companion"],
      render: (sha, version, marks) =>
        `${marks || ""}` +
        repinSnapshot(version === "v1.13.0" ? [repinOldSha] : [repinOldSha, repinTarget]),
      marks: ["\uFEFF", "\uFEFF\uFEFF"]
    }
  ];
  const surfaces = {
    "a pin-lines companion": { path: "docs/pins.md", mode: "pin-lines" },
    "a workflow file": { path: ".github/workflows/unity.yml", mode: null },
    "a policy-snapshot companion": { path: "docs/policy-snapshot.json", mode: "policy-snapshot" }
  };
  for (const fixture of fixtures) {
    for (const marks of fixture.marks || [null]) {
      for (const surfaceName of fixture.surfaces) {
        const surface = surfaces[surfaceName];
        const markCount = marks === null ? 0 : [...marks].length;
        const label = `${surfaceName} with ${fixture.name}` +
          (markCount === 0 ? "" : ` and ${markCount} mark(s)`);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "repin-utf8-round-trip-"));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
        fs.mkdirSync(path.dirname(path.join(root, surface.path)), { recursive: true });
        fs.writeFileSync(path.join(root, surface.path), fixture.render(repinOldSha, "v1.13.0", marks));
        fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify({
          schemaVersion: 1,
          organization: "Ambiguous-Interactive",
          approvedLockShas: [repinOldSha, target],
          approvedReturnShas: [repinOldSha, target],
          approvedDarwinReturnShas: [],
          repositories: [{ repository, defaultBranch: "main" }],
          exceptions: [],
          repinExceptions: [],
          repinCompanions: surface.mode === null
            ? []
            : [{ repository, path: surface.path, mode: surface.mode }]
        }));
        const result = childProcess.spawnSync(
          "bash",
          [path.join(scriptsRoot, "repin-consumer-locks.sh"), "rewrite-pins", root, target, "v1.14.0", repository],
          { cwd: repoRoot, encoding: "utf8", env: { ...process.env, REPIN_POLICY_PATH: path.join(root, "policy.json") } }
        );
        assert.equal(result.status, 0, `${label}: ${result.stderr}`);
        assert.equal(
          fs.readFileSync(path.join(root, surface.path), "utf8"),
          fixture.render(target, "v1.14.0", marks),
          `${label}: the rewrite must change the pin bytes and nothing else`
        );
        // The mark is read as no content and written back as no content. A
        // decoder that stripped it instead of carrying it would drop it from
        // every file the rewrite touches, which is what the base did to a
        // `policy-snapshot` companion: the mode generates the body, so the mark
        // has to survive outside it.
        const leadingMarks = (bytes) => /^\uFEFF*/.exec(bytes.toString("utf8"))[0];
        assert.equal(
          leadingMarks(fs.readFileSync(path.join(root, surface.path))),
          leadingMarks(Buffer.from(fixture.render(repinOldSha, "v1.13.0", marks), "utf8")),
          `${label}: the byte order mark must survive a rewrite`
        );
      }
    }
  }
});

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
