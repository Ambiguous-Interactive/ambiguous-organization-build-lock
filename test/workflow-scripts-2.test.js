"use strict";

const test = require("node:test");

const {
  assert,
  fs,
  gitRun,
  consumerRepinHarness,
  repinEventLog,
} = require("./workflow-scripts-support.js");


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
    `create ${harness.branchName} Repin organization lock references to v1.14.0`
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
