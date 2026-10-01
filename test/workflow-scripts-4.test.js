"use strict";

const test = require("node:test");

const {
  assert,
  fs,
  path,
  gitRun,
  consumerRepinHarness,
  repinEventLog,
} = require("./workflow-scripts-support.js");


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
    `create ${harness.branchName} Repin organization lock references to v1.14.0`
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
