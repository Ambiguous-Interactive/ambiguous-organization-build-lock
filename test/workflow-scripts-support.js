// Shared fixtures for the workflow shell entrypoints.
//
// `node --test` runs each file in its own process and those processes at the
// same time, but it runs the tests inside one file one after another. The 75
// top-level statements here used to sit in one file, which took eighteen and a
// half seconds and made it the longest single step in the local verification and
// in the Linux CI job.
//
// Nothing in this file is a test. The helpers and the case tables live here so
// the split moves no assertion and no rationale comment.
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

// A finding reaches an operator through the run summary, because the drift
// issue is a separate place to look. A finding a green run does not name is a
// finding the run hides, which is what issue #325 records. Both summary writers
// share this table, so one data-driven case covers the merge-policy and the Unity
// enrollment artifact. Each script names its own audit and its own inventory, so
// those labels differ.
const auditSummaryCases = [
  {
    script: "merge-policy-audit.sh",
    label: "merge policy",
    inventoryLabel: "Observed required checks",
    cleanLine: "The merge policy audit is complete and clean. No drift is open.",
    incompleteLine: "The merge policy audit is incomplete; merge-gate status is unknown.",
    unreadableNotice: "could not be published; the run proves nothing about drift.",
    driftCode: "unexpected-required-check-source",
    retrievalCode: "merge-policy-retrieval-incomplete",
    cause: "ruleset 17663217 response is not valid UTF-8"
  },
  {
    script: "unity-enrollment-audit.sh",
    label: "Unity enrollment",
    inventoryLabel: "Active jobs",
    cleanLine: "The Unity enrollment audit is complete and clean. No drift is open.",
    incompleteLine: "The Unity enrollment audit is incomplete; policy status is unknown.",
    unreadableNotice: "could not be published; the run proves nothing about drift.",
    driftCode: "unapproved-lock-ref",
    retrievalCode: "repository-retrieval-incomplete",
    cause: "load exact snapshot: policy file scripts/unity/editor-check.ps1 at 0123456789abcdef is not valid UTF-8"
  }
];

// An artifact the summary step cannot publish is evidence it did not read. No
// green run may claim a verdict from it. Two different lines report that, one for
// the shape gate and one for the drift table, so the assertion is the phrase they
// share. Only some of these fixtures can reach
// the step from a shipped analyzer: a null `findings` key, a finding with no
// repository, and a reason code with a line break. The rest cannot, because Go
// refuses to decode them. They stay as defence in depth against a reader that
// becomes more permissive than the writers are.
const unreadableAudits = [
  { name: "no findings key", audit: { repositories: [], inventory: [], complete: true } },
  { name: "a null findings key", audit: { repositories: [], inventory: [], findings: null, complete: true } },
  { name: "a findings key that is not an array", audit: { repositories: [], inventory: [], findings: {}, complete: true } },
  { name: "a finding that is not an object", audit: { repositories: [], inventory: [], findings: ["nope"], complete: true } },
  { name: "a finding without a repository", audit: { repositories: [], inventory: [], findings: [{ code: "unapproved-lock-ref" }], complete: true } },
  {
    // A reason code reaches a workflow command, so one carrying a line break
    // could forge a second command.
    name: "a reason code with a line break",
    audit: {
      repositories: [],
      inventory: [],
      findings: [{ repository: "Ambiguous-Interactive/example", code: "unapproved-lock-ref\n::error::forged" }],
      complete: true
    }
  },
  {
    name: "a reason code that is not a string",
    audit: {
      repositories: [],
      inventory: [],
      findings: [{ repository: "Ambiguous-Interactive/example", code: 7 }],
      complete: true
    }
  },
  {
    name: "a cause that is not a string",
    audit: {
      repositories: [],
      inventory: [],
      findings: [{ repository: "Ambiguous-Interactive/example", code: "unapproved-lock-ref", cause: 7 }],
      complete: true
    }
  }
];

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

// Every file under the temporary root, read as bytes.
function snapshotBytes(root, prefix = "") {
  const snapshot = {};
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      Object.assign(snapshot, snapshotBytes(root, relative));
    } else {
      snapshot[relative] = fs.readFileSync(path.join(root, relative));
    }
  }
  return snapshot;
}

const repinActionPath =
  "Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock";

// Every file the rewrite reads so that it can write one back: the workflow
// walk and each of the three companion modes. A file it never reads cannot
// carry a pin it would write back, so it is not in this list. `moves` is the
// content the rewrite would change, and `stays` the content it would leave
// alone; the difference between them is the whole contract, so each surface
// carries both.
const repinSnapshot = (lockShas) => `${JSON.stringify({
  schemaVersion: 1,
  organization: "Ambiguous-Interactive",
  approvedLockShas: lockShas,
  approvedReturnShas: [repinOldSha, repinTarget],
  approvedDarwinReturnShas: []
}, null, 2)}\n`;

const repinReadableSurfaces = [
  {
    name: "a workflow file",
    path: ".github/workflows/second.yml",
    mode: null,
    moves: () => `  - uses: ${repinActionPath}@${repinOldSha} # v1.13.0\n`,
    stays: () => "# a note\n"
  },
  {
    name: "a pin-lines companion",
    path: "docs/pin-lines.md",
    mode: "pin-lines",
    moves: () => `  - uses: ${repinActionPath}@${repinOldSha} # v1.13.0\n`,
    stays: () => "# a note\n"
  },
  {
    name: "a pin-literal companion",
    path: "docs/pin-literal.json",
    mode: "pin-literal",
    moves: () => `{"acquire-build-lock": "${repinOldSha}"}\n`,
    stays: () => '{"acquire-build-lock": "not-a-pin"}\n'
  },
  {
    name: "a policy-snapshot companion",
    path: "docs/policy-snapshot.json",
    mode: "policy-snapshot",
    moves: () => repinSnapshot([repinOldSha]),
    // No `stays`: the mode generates the whole document, and a decoded
    // snapshot carrying U+FFFD can never equal generated JSON that has none,
    // so this surface has no file the rewrite would leave alone.
    stays: null
  }
];

// A byte sequence Node's UTF-8 decoder cannot read. Each one becomes U+FFFD,
// which is three bytes, so a rewrite that writes such a file back both
// destroys the byte and grows the file while the report counts only the pins
// it moved.
const undecodableBytes = {
  "a lone Latin-1 byte": [0x89],
  "an overlong encoding": [0xc0, 0x80],
  "an encoded lone surrogate": [0xed, 0xa0, 0x80],
  "a truncated sequence": [0xe2, 0x9c]
};

const repinOldSha = "300501e91c9bec81bb9b5a977c22aa5bb2d9b649";

const repinTarget = "64bac446903115134dca8235410b332bc5a83547";

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
  // Every enrolled consumer carries a `# vX.Y.Z` comment on its lock pins, so
  // the seeded checkout does too: a pin without one has no comment spacing to
  // copy and the rewrite correctly fails closed. The single space matches
  // unity-helpers and DxMessaging, whose Prettier and contract tests reject a
  // wider gap.
  const writePin = (sha, version) => fs.writeFileSync(
    path.join(workflows, "unity.yml"),
    `- uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/return-unity-license@${sha} # ${version}\n`
  );
  writePin(state.atTarget ? releaseSha : repinOldSha, state.atTarget ? "v1.14.0" : "v1.13.0");
  if (state.staleRefOnly) {
    // A checkout `ref:` this repository names is the same pin spelled a
    // second way. A consumer can reach this state on its own: Dependabot
    // moves a `uses:` line and never a `ref:`, so the `uses:` pin reaches the
    // target first and the policy checkout is left behind.
    fs.writeFileSync(
      path.join(workflows, "unity.yml"),
      [
        `- uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/return-unity-license@${releaseSha} # v1.14.0`,
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "        with:",
        "          repository: Ambiguous-Interactive/ambiguous-organization-build-lock",
        `          ref: ${repinOldSha}`,
        ""
      ].join("\n")
    );
  }
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
    // A branch a current run pushed already carries the repinned pin, so its
    // content has to match what this run would produce exactly.
    writePin(releaseSha, "v1.14.0");
    gitRun(seed, "add", "-A");
    gitRun(seed, "commit", "-m", "chore: repin organization lock references to v1.14.0");
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
    if (name === "reportOverride") {
      continue;
    }
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
  for (const [name, state] of Object.entries(consumerStates)) {
    if (name === "reportOverride") {
      continue;
    }
    if (state.companions) {
      policy.repinCompanions = [...(policy.repinCompanions || []), ...state.companions];
    }
  }
  const policyPath = path.join(root, "unity-enrollment-policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(policy));

  const shims = path.join(root, "shims");
  fs.mkdirSync(shims);
  if (consumerStates.reportOverride) {
    // The rewrite is a `node` call on PATH, so a shim can hand the caller a
    // report the script could not have produced. The mutation it stands in
    // for is the count reader treating an absent field as a count of zero,
    // which would let the pull request body describe a mutation the report
    // never claimed.
    writeExecutable(path.join(shims, "node"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "cat <<'REPORT'",
      consumerStates.reportOverride,
      "REPORT",
      ""
    ].join("\n"));
  }
  const events = path.join(root, "events.log");
  const prState = path.join(root, "pr-state");
  fs.writeFileSync(events, "");
  fs.mkdirSync(prState, { recursive: true });
  for (const [name, state] of Object.entries(consumerStates)) {
    if (name === "reportOverride") {
      continue;
    }
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
  prCreateStatus = "0",
  unreadablePolicy = false,
  unreadablePolicyOnMainOnly = false,
  escapedSurrogatePolicy = false
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
  const policy = {
    schemaVersion: 1,
    approvedLockShas: authorizedShas,
    approvedReturnShas: authorizedShas,
    approvedDarwinReturnShas: [],
    repositories: [],
    exceptions: []
  };
  if (escapedSurrogatePolicy) {
    // An escaped lone surrogate is valid UTF-8 and valid JSON, and a JavaScript
    // string can hold it, so this seeds the shape the Go readers refuse and the
    // Node readers are measured against.
    const escaped = JSON.stringify(policy).replace(
      `"repositories":[]`,
      `"note":"\\ud800","repositories":[]`
    );
    if (!escaped.includes("\\ud800")) {
      throw new Error("escaped-surrogate fixture is missing from the policy");
    }
    fs.writeFileSync(path.join(seed, "unity-enrollment-policy.json"), escaped);
  } else if (!unreadablePolicy) {
    fs.writeFileSync(path.join(seed, "unity-enrollment-policy.json"), JSON.stringify(policy));
  } else {
    // One raw byte inside a string value, so the file is still JSON to a
    // reader that cannot decode it and only a strict decode refuses it. The
    // free-text `note` field is where a reviewed policy would carry a stray
    // byte, and no other field changes behaviour when it does.
    const marker = "UNREADABLE-BYTE";
    const bytes = Buffer.from(JSON.stringify({ ...policy, note: `caf${marker}-note` }), "utf8");
    bytes[bytes.indexOf(marker)] = 0x89;
    fs.writeFileSync(path.join(seed, "unity-enrollment-policy.json"), bytes);
  }
  gitRun(seed, "add", "-A");
  gitRun(seed, "commit", "-m", "policy");
  gitRun(seed, "push", "-q", "origin", "main");
  const pushedTags = ["v1.12.1", "v1.14.0", "v1.15.0"].filter((tag) => tag !== omitTag);
  gitRun(seed, "push", "-q", "origin", "main", ...pushedTags.map((tag) => `refs/tags/${tag}`));

  gitRun(root, "clone", "-q", remotePath, work);

  if (unreadablePolicyOnMainOnly) {
    // Advance the remote default branch after the clone, so the working tree
    // holds a readable policy while `origin/main` holds one the script cannot
    // read. The script checks out `origin/main` before it writes, so only a
    // check that runs after the checkout can see this file.
    const marker = "UNREADABLE-BYTE";
    const advanced = Buffer.from(
      JSON.stringify({ ...policy, note: `caf${marker}-note` }),
      "utf8"
    );
    advanced[advanced.indexOf(marker)] = 0x89;
    fs.writeFileSync(path.join(seed, "unity-enrollment-policy.json"), advanced);
    gitRun(seed, "commit", "-aqm", "policy this script cannot read");
    gitRun(seed, "push", "-q", "origin", "main");
    gitRun(work, "fetch", "-q", "origin");
  }

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

module.exports = {
  writeExecutable,
  assert,
  childProcess,
  fs,
  os,
  path,
  repoRoot,
  scriptsRoot,
  runScript,
  shellCheckInstallHarness,
  auditSummaryCases,
  unreadableAudits,
  headRevalidationHarness,
  runHeadRevalidation,
  readHeadRevalidationEvents,
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
  releaseAuthorizationHarness,
  authorizationBranchOnRemote,
  defaultPublishedReleases,
  diagnosticHarness,
};
