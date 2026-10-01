"use strict";

const test = require("node:test");

const {
  assert,
  childProcess,
  fs,
  gitRun,
  consumerRepinHarness,
  repinEventLog,
  releaseAuthorizationHarness,
  authorizationBranchOnRemote,
  defaultPublishedReleases,
  diagnosticHarness,
} = require("./workflow-scripts-support.js");


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
  assert.match(result.stderr, /offer list may be truncated/);
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


// The authorization script reads the reviewed policy and writes the same file
// back, so a byte it cannot decode would be committed as U+FFFD inside a pull
// request a maintainer merges.
test("release authorization refuses a policy it cannot read as UTF-8", (t) => {
  const harness = releaseAuthorizationHarness(t, {
    publishedReleases: defaultPublishedReleases(),
    authorizedTags: ["v1.14.0"],
    unreadablePolicy: true
  });

  const result = harness.run();

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /unity-enrollment-policy\.json is not valid UTF-8/);
  assert.equal(authorizationBranchOnRemote(harness, "release-authorization/v1.15.0"), "");
  assert.doesNotMatch(fs.readFileSync(harness.events, "utf8"), /gh pr create/);
  // Read as bytes: the policy still carries its own byte, so any comparison
  // through a lossy decode would see the replacement character instead.
  const policyOnDefaultBranch = childProcess.spawnSync(
    "git",
    ["show", "origin/main:unity-enrollment-policy.json"],
    { cwd: harness.work }
  ).stdout;
  assert.ok(
    policyOnDefaultBranch.includes(Buffer.from([0x89])),
    "the default branch keeps the byte the reviewed policy was seeded with"
  );
  assert.ok(
    !policyOnDefaultBranch.includes(Buffer.from([0xef, 0xbf, 0xbd])),
    "the default branch never receives a U+FFFD the reviewed policy never had"
  );
});


// The script checks out `origin/main` before it writes, so the working tree
// it starts from and the file it writes can be different files. A check that
// runs only before the checkout reads a policy the rewrite never sees.
test("release authorization re-checks the policy the checkout replaced", (t) => {
  const harness = releaseAuthorizationHarness(t, {
    publishedReleases: defaultPublishedReleases(),
    authorizedTags: ["v1.14.0"],
    unreadablePolicyOnMainOnly: true
  });

  // The working tree starts readable, so the first check passes.
  assert.doesNotMatch(
    gitRun(harness.work, "show", "HEAD:unity-enrollment-policy.json"),
    /�/,
    "the cloned policy is readable before the script runs"
  );

  const result = harness.run();

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /unity-enrollment-policy\.json is not valid UTF-8/);
  assert.equal(authorizationBranchOnRemote(harness, "release-authorization/v1.15.0"), "");
  assert.doesNotMatch(fs.readFileSync(harness.events, "utf8"), /gh pr create/);
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


// An escaped lone surrogate is valid UTF-8 and valid JSON, so the encoding
// check in this script cannot see it. A JavaScript string holds the code point,
// so this script is measured rather than assumed: the assertion is that the
// escape survives the write-back byte for byte, because a tool that preserved
// it is not a tool that can destroy it. The Go readers refuse the same file,
// and their refusal is covered in Go.
test("release authorization preserves an escaped lone surrogate it can represent", (t) => {
  const harness = releaseAuthorizationHarness(t, {
    publishedReleases: defaultPublishedReleases(),
    authorizedTags: ["v1.14.0"],
    escapedSurrogatePolicy: true
  });

  const result = harness.run();

  // Read as bytes. A lossy write-back would replace the six-byte escape with
  // the three bytes of U+FFFD, and the reviewed policy would then contain a
  // value no release ever wrote.
  const written = gitRun(harness.work, "show", "HEAD:unity-enrollment-policy.json");
  assert.ok(
    Buffer.from(written, "utf8").includes(Buffer.from("\\ud800", "utf8")),
    "the written policy keeps the escape exactly"
  );
  assert.ok(
    !Buffer.from(written, "utf8").includes(Buffer.from("�", "utf8")),
    "the written policy never gains a U+FFFD the repository never had"
  );
  // The authorization decision itself must still be right, so the newest
  // release has to be listed on the branch the script pushed.
  assert.match(result.stdout, /Authorize|v1\.15\.0|already authorized/);
  assert.doesNotMatch(fs.readFileSync(harness.events, "utf8"), /is not valid UTF-8/);
});
