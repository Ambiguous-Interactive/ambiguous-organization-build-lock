"use strict";

const test = require("node:test");

const {

  assert,
  fs,
  path,
  repinOldSha,
  gitRun,
  consumerRepinHarness,
  repinEventLog,
} = require("./workflow-scripts-support.js");

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
    `create ${harness.branchName} Repin organization lock references to v1.14.0`
  ]);
  const pushed = gitRun(
    harness.remotePath("dxmessaging"),
    "show", `${harness.branchName}:.github/workflows/unity.yml`
  );
  assert.match(pushed, new RegExp(`return-unity-license@${harness.releaseSha}`));
  const summary = fs.readFileSync(harness.summaryPath, "utf8");
  assert.match(summary, /\| `Ambiguous-Interactive\/dxmessaging` \| opened repin pull request to `v1.14.0` \(1 line\) \|/);
});

test("consumer repin fails closed on a report it cannot read the counts from", (t) => {
  // The pull request body decides which mutations to name from two counts in
  // the rewrite report. A reader that treated an absent count as zero would
  // describe a mutation the report never claimed, and the offer would go out
  // with a body a reviewer cannot check against the diff. Each report here is
  // one the script could not have produced, so the reader has to refuse it.
  for (const [name, report] of [
    ["an absent count", '{"changed":1,"files":[{"path":".github/workflows/unity.yml","lines":1}],"skipped":[],"unmatched":[],"companions":[],"unmatchedCompanions":[]}'],
    ["a null count", '{"changed":1,"uses":null,"refs":null,"files":[],"skipped":[],"unmatched":[],"companions":[],"unmatchedCompanions":[]}'],
    ["a string count", '{"changed":1,"uses":"2","refs":"1","files":[],"skipped":[],"unmatched":[],"companions":[],"unmatchedCompanions":[]}']
  ]) {
    const harness = consumerRepinHarness(t, { "dxmessaging": {}, reportOverride: report });

    const result = harness.run();

    assert.notEqual(result.status, 0, name + ": the run accepted a report it cannot read");
    assert.match(result.stderr, /could not read the rewrite counts from the report/, name);
    assert.equal(
      repinEventLog(harness).filter((event) => event.startsWith("create")).length,
      0,
      name + ": no offer may be opened from a report the run could not read"
    );
  }
});

test("consumer repin names only the mutation it made in the pull request body", (t) => {
  // One consumer per mutation shape. The checkout `ref:` moved in one and no
  // `uses:` reference did, and the reverse holds for the other. A body that
  // claimed both mutations on either offer would send a reviewer looking for
  // a line the diff does not contain.
  const harness = consumerRepinHarness(t, {
    "dxmessaging": { staleRefOnly: true },
    "unity-helpers": {}
  });

  const result = harness.run();

  assert.equal(result.status, 0, result.stderr);
  const bodyFor = (name) => fs.readFileSync(
    path.join(harness.root, "pr-state", name, "last-body.md"),
    "utf8"
  );
  // The ref:-only offer names the ref: and nothing else.
  const refOnly = bodyFor("dxmessaging");
  assert.match(refOnly, /A checkout `ref:` naming/);
  assert.doesNotMatch(refOnly, /suffix of a `uses:` reference/);
  // The uses:-only offer names the `uses:` reference and nothing else.
  const usesOnly = bodyFor("unity-helpers");
  assert.match(usesOnly, /suffix of a `uses:` reference/);
  assert.doesNotMatch(usesOnly, /A checkout `ref:` naming/);
  // The moved ref: is the only change in its offer.
  const pushed = gitRun(
    harness.remotePath("dxmessaging"),
    "show", `${harness.branchName}:.github/workflows/unity.yml`
  );
  assert.match(pushed, new RegExp(`ref: ${harness.releaseSha}`));
  assert.doesNotMatch(pushed, new RegExp(`return-unity-license@${repinOldSha}`));
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
