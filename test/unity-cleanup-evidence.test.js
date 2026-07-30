"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const runtimePath = path.join(
  __dirname,
  "..",
  ".github",
  "dist",
  "classify-unity-cleanup-evidence.js"
);
const {
  MAX_EVIDENCE_FILES,
  MAX_EVIDENCE_TOTAL_BYTES,
  MAX_VISITED_ENTRIES,
  classifyEvidence,
  collectEvidence,
  environmentInputs,
  parseInputs,
  run
} = require(runtimePath);

const ENTITLEMENT = "[Licensing::Module] Successfully returned the entitlement license";
const ULF = "[Licensing::Client] Successfully returned ULF license with serial number : SC-REDACTED";
const PROOF = `${ENTITLEMENT}\n${ULF}\n`;
const SKIP = "[Licensing::Module] Error: Serial number unavailable for ULF return; skipping operation";

function expected(status, health, reason) {
  return {
    resourceSafe: status === "confirmed",
    cleanupStatus: status,
    health,
    reason
  };
}

test("classification precedence is fail-closed and proof is return-log scoped", async (t) => {
  const fixtures = [
    ["exact proof", 0, PROOF, [], true, true, expected("confirmed", "healthy", "cleanup-confirmed")],
    ["nonzero exact proof", 1, PROOF, [], true, true, expected("confirmed", "healthy", "cleanup-confirmed")],
    ["entitlement only", 0, `${ENTITLEMENT}\n`, [], true, true, expected("unknown", "healthy", "return-missing-positive-evidence")],
    ["ULF only", 0, `${ULF}\n`, [], true, true, expected("unknown", "healthy", "return-missing-positive-evidence")],
    ["exit zero alone", 0, "Exiting batchmode successfully now!\n", [], true, true, expected("unknown", "healthy", "return-missing-positive-evidence")],
    ["command incomplete", null, PROOF, [], false, true, expected("unknown", "healthy", "return-missing-positive-evidence")],
    ["supplemental proof", 0, "", [Buffer.from(PROOF)], true, true, expected("unknown", "healthy", "return-missing-positive-evidence")],
    ["module skip", 0, `${PROOF}${SKIP}\n`, [], true, true, expected("unknown", "healthy", "return-ulf-skipped")],
    ["module skip before proof", 0, `${SKIP}\n${PROOF}`, [], true, true, expected("unknown", "healthy", "return-ulf-skipped")],
    ["bare skip", 0, `${PROOF}Serial number unavailable for ULF return\n`, [], true, true, expected("unknown", "healthy", "return-ulf-skipped")],
    ["bare skip with suffix", 0, `${PROOF}Serial number unavailable for ULF return; skipping operation\n`, [], true, true, expected("unknown", "healthy", "return-ulf-skipped")],
    ["incidental skip phrase", 0, `${PROOF}checking for ${SKIP}\n`, [], true, true, expected("confirmed", "healthy", "cleanup-confirmed")],
    ["supplemental skip", 0, PROOF, [Buffer.from(`${SKIP}\n`)], true, true, expected("confirmed", "healthy", "cleanup-confirmed")],
    ["400006 vetoes proof", 0, `${PROOF}400006\n`, [], true, true, expected("unknown", "healthy", "unity-return-400006")],
    ["supplemental 400006", 0, PROOF, [Buffer.from("code 400006\n")], true, true, expected("unknown", "healthy", "unity-return-400006")],
    ["20113", 0, `${PROOF}20113\n`, [], true, true, expected("unknown", "healthy", "unity-20113-unclassified")],
    ["supplemental 20113", 0, PROOF, [Buffer.from("code 20113\n")], true, true, expected("unknown", "healthy", "unity-20113-unclassified")],
    ["20111 beats proof", 0, `${PROOF}20111\n`, [], true, true, expected("unknown", "blocked", "unity-account-limit-20111")],
    ["supplemental 20111", 0, PROOF, [Buffer.from("code 20111\n")], true, true, expected("unknown", "blocked", "unity-account-limit-20111")],
    ["20111 beats incomplete capture", 0, "20111\n", [], true, false, expected("unknown", "blocked", "unity-account-limit-20111")],
    ["capture incomplete", 0, PROOF, [], true, false, expected("unknown", "healthy", "return-log-truncated")],
    ["timeout", 124, PROOF, [], true, true, expected("unknown", "healthy", "return-timeout")],
    ["numeric substring is not a code", 0, `${PROOF}x201110\n`, [], true, true, expected("confirmed", "healthy", "cleanup-confirmed")]
  ];
  for (const exitCode of [137, 143, -1073741510, -1073740791]) {
    fixtures.push([
      `termination ${exitCode}`,
      exitCode,
      PROOF,
      [],
      true,
      true,
      expected("unknown", "healthy", "return-terminated")
    ]);
  }

  for (const [name, exitCode, returnText, supplemental, completed, captureComplete, want] of fixtures) {
    await t.test(name, () => {
      assert.deepEqual(
        classifyEvidence({
          exitCode,
          returnLog: Buffer.from(returnText),
          supplemental,
          commandCompleted: completed,
          captureComplete
        }),
        want
      );
    });
  }
});

test("bounded collection rejects unsafe evidence shapes and produces a stable digest", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-cleanup-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const returnLog = path.join(root, "return.log");
  const supplemental = path.join(root, "supplemental");
  fs.mkdirSync(supplemental);
  fs.writeFileSync(returnLog, `\uFEFF${ENTITLEMENT}\r\n${ULF}\r\n`);
  fs.writeFileSync(path.join(supplemental, "activation.log"), "activation complete\n");

  const first = collectEvidence({
    returnLogPath: returnLog,
    supplementalPaths: [supplemental],
    captureAttested: true
  });
  const second = collectEvidence({
    returnLogPath: returnLog,
    supplementalPaths: [supplemental],
    captureAttested: true
  });
  assert.equal(first.captureComplete, true);
  assert.equal(first.digest, second.digest);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    classifyEvidence({
      exitCode: 0,
      returnLog: first.returnLog,
      supplemental: first.supplemental,
      commandCompleted: true,
      captureComplete: first.captureComplete
    }),
    expected("confirmed", "healthy", "cleanup-confirmed")
  );

  await t.test("missing return log", () => {
    const result = collectEvidence({
      returnLogPath: path.join(root, "missing.log"),
      supplementalPaths: [],
      captureAttested: true
    });
    assert.equal(result.captureComplete, false);
  });

  await t.test("return directory", () => {
    const result = collectEvidence({
      returnLogPath: supplemental,
      supplementalPaths: [],
      captureAttested: true
    });
    assert.equal(result.captureComplete, false);
  });

  await t.test("symlink", { skip: process.platform === "win32" }, () => {
    const link = path.join(root, "linked.log");
    fs.symlinkSync(returnLog, link);
    const result = collectEvidence({
      returnLogPath: link,
      supplementalPaths: [],
      captureAttested: true
    });
    assert.equal(result.captureComplete, false);
  });

  await t.test("oversized return log", () => {
    const large = path.join(root, "large.log");
    fs.writeFileSync(large, Buffer.alloc(MAX_EVIDENCE_TOTAL_BYTES + 1, 65));
    const result = collectEvidence({
      returnLogPath: large,
      supplementalPaths: [],
      captureAttested: true
    });
    assert.equal(result.captureComplete, false);
    assert.equal(result.returnLog.length, 0);
  });

  await t.test("over-count supplemental files", () => {
    const many = path.join(root, "many");
    fs.mkdirSync(many);
    for (let index = 0; index < MAX_EVIDENCE_FILES; index += 1) {
      fs.writeFileSync(path.join(many, `${String(index).padStart(3, "0")}.log`), "x");
    }
    const result = collectEvidence({
      returnLogPath: returnLog,
      supplementalPaths: [many],
      captureAttested: true
    });
    assert.equal(result.captureComplete, false);
    assert.equal(result.supplemental.length, MAX_EVIDENCE_FILES - 1);
  });

  await t.test("invalid UTF-8", () => {
    const invalid = path.join(root, "invalid.log");
    fs.writeFileSync(invalid, Buffer.from([0xc3, 0x28]));
    const result = collectEvidence({
      returnLogPath: invalid,
      supplementalPaths: [],
      captureAttested: true
    });
    assert.equal(result.captureComplete, false);
  });

  await t.test("unreadable during read", () => {
    const io = {
      ...fs,
      openSync(candidate, flags) {
        if (candidate === returnLog) {
          throw new Error("simulated read failure");
        }
        return fs.openSync(candidate, flags);
      }
    };
    const result = collectEvidence({
      returnLogPath: returnLog,
      supplementalPaths: [],
      captureAttested: true,
      io
    });
    assert.equal(result.captureComplete, false);
    assert.equal(result.returnLog.length, 0);
  });

  await t.test("file identity changes during read", () => {
    let returnStats = 0;
    const io = {
      ...fs,
      lstatSync(candidate, options) {
        const stat = fs.lstatSync(candidate, options);
        if (candidate === returnLog && returnStats++ > 0) {
          return { ...stat, mtimeNs: stat.mtimeNs + 1n };
        }
        return stat;
      }
    };
    const result = collectEvidence({
      returnLogPath: returnLog,
      supplementalPaths: [],
      captureAttested: true,
      io
    });
    assert.equal(result.captureComplete, false);
    assert.equal(result.returnLog.length, 0);
  });

  await t.test("post-stat growth never expands the allocated read", () => {
    const tiny = path.join(root, "tiny.log");
    fs.writeFileSync(tiny, "x");
    let largestRequestedRead = 0;
    const io = {
      ...fs,
      readSync(descriptor, storage, offset, length) {
        largestRequestedRead = Math.max(largestRequestedRead, length);
        storage.fill(120, offset, offset + length);
        return length;
      },
      fstatSync(descriptor, options) {
        const stat = fs.fstatSync(descriptor, options);
        if (largestRequestedRead > 0) {
          return { ...stat, size: stat.size + 8_388_608n };
        }
        return stat;
      }
    };
    const result = collectEvidence({
      returnLogPath: tiny,
      supplementalPaths: [],
      captureAttested: true,
      maxFileBytes: 1,
      maxTotalBytes: 1,
      io
    });
    assert.equal(result.captureComplete, false);
    assert.ok(largestRequestedRead <= 1);
    assert.equal(result.returnLog.length, 0);
  });

  await t.test("nested directory enumeration shares one iterative global budget", () => {
    const source = path.join(root, "virtual-many");
    fs.mkdirSync(source);
    const directoryStat = fs.lstatSync(source, { bigint: true });
    const fileStat = {
      ...directoryStat,
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false
    };
    let directoryReads = 0;
    let inspectedEntries = 0;
    const io = {
      ...fs,
      lstatSync(candidate, options) {
        if (candidate === source || candidate === returnLog) {
          return fs.lstatSync(candidate, options);
        }
        inspectedEntries += 1;
        const depth = path.relative(source, candidate).split(path.sep).length;
        return depth === 1 ? directoryStat : fileStat;
      },
      opendirSync(candidate) {
        const entryLimit = 2_000;
        const rootDirectory = candidate === source;
        let localReads = 0;
        return {
          readSync() {
            directoryReads += 1;
            if (localReads >= entryLimit) {
              return null;
            }
            localReads += 1;
            return { name: rootDirectory ? `dir-${localReads}` : `${localReads}.bin` };
          },
          closeSync() {}
        };
      }
    };
    const result = collectEvidence({
      returnLogPath: returnLog,
      supplementalPaths: [source],
      captureAttested: true,
      io
    });
    assert.equal(result.captureComplete, false);
    assert.ok(directoryReads <= MAX_VISITED_ENTRIES);
    assert.ok(inspectedEntries <= MAX_VISITED_ENTRIES);
    assert.ok(result.discoveredEntries <= MAX_VISITED_ENTRIES);
    assert.ok(result.directoryReadOperations <= MAX_VISITED_ENTRIES);
    assert.ok(result.maximumBufferedEntries <= MAX_VISITED_ENTRIES);
    assert.ok(result.maximumTraversalDepth <= MAX_VISITED_ENTRIES);
    assert.equal(result.supplemental.length, 0);
  });

  await t.test("non-ASCII filenames use locale-independent digest ordering", () => {
    const orderedRoot = path.join(root, "ordered");
    const orderedReturn = path.join(root, "ordered-return.log");
    fs.mkdirSync(orderedRoot);
    fs.writeFileSync(orderedReturn, "return\n");
    fs.writeFileSync(path.join(orderedRoot, "z.log"), "ascii-z\n");
    fs.writeFileSync(path.join(orderedRoot, "ä.log"), "non-ascii\n");
    const result = collectEvidence({
      returnLogPath: orderedReturn,
      supplementalPaths: [orderedRoot],
      captureAttested: true
    });
    assert.equal(result.captureComplete, true);
    assert.deepEqual(
      result.supplemental.map((payload) => payload.toString("utf8")),
      ["ascii-z\n", "non-ascii\n"]
    );
    assert.equal(
      result.digest,
      "48f0d9dc5935053db94d4ec3f421ecc8fce510749ff70edbdfc79fe48a8f5625"
    );
  });
});

test("input parsing rejects contradictions and malformed typed values", () => {
  assert.deepEqual(parseInputs({
    "return-log-path": "/tmp/return.log",
    "return-command-completed": "false",
    "return-exit-code": "",
    "evidence-capture-complete": "true",
    "supplemental-evidence-paths": " /tmp/a.log \n\n/tmp/b.log\n"
  }), {
    returnLogPath: "/tmp/return.log",
    commandCompleted: false,
    exitCode: null,
    captureAttested: true,
    supplementalPaths: ["/tmp/a.log", "/tmp/b.log"],
    returnLogDigest: ""
  });
  assert.throws(() => parseInputs({
    "return-log-path": "/tmp/return.log",
    "return-command-completed": "true",
    "return-exit-code": "",
    "evidence-capture-complete": "true"
  }), /return-exit-code/);
  assert.throws(() => parseInputs({
    "return-log-path": "/tmp/return.log",
    "return-command-completed": "no",
    "return-exit-code": "0",
    "evidence-capture-complete": "true"
  }), /literal true or false/);
  assert.throws(() => parseInputs({
    "return-log-path": "/tmp/return.log",
    "return-command-completed": "false",
    "return-exit-code": "0",
    "evidence-capture-complete": "true"
  }), /must be absent/);
});

test("GitHub action input environment preserves hyphenated input names", () => {
  assert.deepEqual(environmentInputs({
    "INPUT_RETURN-LOG-PATH": "/tmp/return.log",
    "INPUT_RETURN-COMMAND-COMPLETED": "true",
    "INPUT_RETURN-EXIT-CODE": "0",
    "INPUT_EVIDENCE-CAPTURE-COMPLETE": "true",
    "INPUT_RETURN-LOG-DIGEST": "a".repeat(64),
    "INPUT_SUPPLEMENTAL-EVIDENCE-PATHS": "/tmp/evidence.log"
  }), {
    "return-log-path": "/tmp/return.log",
    "return-command-completed": "true",
    "return-exit-code": "0",
    "evidence-capture-complete": "true",
    "return-log-digest": "a".repeat(64),
    "supplemental-evidence-paths": "/tmp/evidence.log"
  });
});

test("action run emits only typed outputs and never prints evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-cleanup-run-"));
  const outputPath = path.join(root, "output.txt");
  const returnLog = path.join(root, "return.log");
  const secretMarker = "SC-DO-NOT-PRINT";
  fs.writeFileSync(returnLog, `${ENTITLEMENT}\n[Licensing::Client] Successfully returned ULF license with serial number : ${secretMarker}\n`);
  const messages = [];
  try {
    const result = run({
      inputs: {
        "return-log-path": returnLog,
        "return-command-completed": "true",
        "return-exit-code": "0",
        "evidence-capture-complete": "true",
        "return-log-digest": crypto
          .createHash("sha256")
          .update(fs.readFileSync(returnLog))
          .digest("hex"),
        "supplemental-evidence-paths": ""
      },
      outputPath,
      log: (message) => messages.push(message)
    });
    assert.equal(result.reason, "cleanup-confirmed");
    const outputs = fs.readFileSync(outputPath, "utf8");
    assert.match(outputs, /^resource-safe=true$/m);
    assert.match(outputs, /^classification-complete=true$/m);
    assert.doesNotMatch(outputs, new RegExp(secretMarker));
    assert.doesNotMatch(messages.join("\n"), new RegExp(secretMarker));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy return evidence remains classifiable without the central digest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-cleanup-legacy-"));
  const outputPath = path.join(root, "output.txt");
  const returnLog = path.join(root, "return.log");
  try {
    fs.writeFileSync(returnLog, PROOF);
    const result = run({
      inputs: {
        "return-log-path": returnLog,
        "return-command-completed": "true",
        "return-exit-code": "0",
        "evidence-capture-complete": "true",
        "supplemental-evidence-paths": ""
      },
      outputPath,
      log: () => {}
    });
    assert.equal(result.reason, "cleanup-confirmed");
    assert.equal(result.resourceSafe, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("classifier rejects return-log replacement against the linked digest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-cleanup-digest-"));
  const outputPath = path.join(root, "output.txt");
  const returnLog = path.join(root, "return.log");
  try {
    fs.writeFileSync(returnLog, PROOF);
    const digest = crypto.createHash("sha256").update(PROOF).digest("hex");
    fs.writeFileSync(returnLog, `${PROOF}replacement\n`);
    assert.throws(() => run({
      inputs: {
        "return-log-path": returnLog,
        "return-command-completed": "true",
        "return-exit-code": "0",
        "evidence-capture-complete": "true",
        "return-log-digest": digest,
        "supplemental-evidence-paths": ""
      },
      outputPath,
      log: () => {}
    }), /digest does not match/);
    assert.match(fs.readFileSync(outputPath, "utf8"), /classification-complete=false/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
