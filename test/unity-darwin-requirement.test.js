"use strict";

/*
  The macOS half of the Darwin trusted return (#153), in its own file because it
  is the only part of this action's suite that a macOS runner can currently run.

  `test/unity-license-return.test.js` builds its editor fixture under
  `os.tmpdir()`, which on macOS resolves beneath the symlinked `/var`. The
  action's own `assertNoReparsePath` walk correctly refuses that, so several of
  that file's cases fail on Darwin for a reason that is about the fixture and
  not about the action. Fixing it is a real improvement and it is not this
  change: see the issue linked from the pull request.

  Nothing here builds a fixture. Every case asks the operating system about the
  requirement string the action ships, using `/bin/ls` and the binaries macOS
  already has.
*/

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const {
  DARWIN_CODESIGN_PATH,
  darwinDesignatedRequirement,
  UNITY_DARWIN_TEAM_IDS
} = require("../.github/dist/return-unity-license.js");

/*
  The three cases below run the real macOS requirement compiler, so they are the
  only ones here whose verdict is not computed from an injected spawn.

  They exist because `verifyDarwinUnityEditor` maps every non-zero `codesign`
  exit to one message: "signature verification failed". A syntax error in the
  requirement text therefore reads exactly like a signature that did not match,
  and the gate would refuse every Darwin return forever while looking like it
  was doing its job. Nothing above can catch that -- each of those cases asserts
  the argv the action builds, and an argv is not a proof that the string inside
  it means anything to `csreq(5)`.

  #229's canary is the thing that settles whether `9QW8UQUTAA` is the identity on
  the Developer ID *Application* certificate. These do not settle that and do not
  try to. What they settle is the half of that answer a hosted runner can reach
  with no seat, no credential and no Unity install: that the requirement compiles,
  that it is not vacuous, and that a refusal by it is a refusal by the identity
  clause rather than by a typo.
*/

function darwinOnly(t) {
  if (process.platform !== "darwin") {
    t.skip("the macOS requirement compiler is only present on Darwin");
    return false;
  }
  return true;
}

test("the shipped darwin requirement compiles as a code signing requirement", (t) => {
  if (!darwinOnly(t)) {
    return;
  }
  const requirement = darwinDesignatedRequirement(UNITY_DARWIN_TEAM_IDS);
  const compiled = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "unity-return-csreq-")),
    "requirement.bin"
  );
  execFileSync("/usr/bin/csreq", ["-r", `=${requirement}`, "-b", compiled], {
    stdio: "ignore"
  });
  assert.ok(fs.statSync(compiled).size > 0, "csreq wrote no compiled requirement");

  // The red half: without it, a csreq that accepted anything would pass above.
  assert.throws(
    () => execFileSync(
      "/usr/bin/csreq",
      ["-r", "=anchor apple generic and certificate leaf[subject.OU] ==== \"X\"", "-b", `${compiled}.bad`],
      { stdio: "ignore" }
    )
  );
});

test("an apple-signed binary that is not Unity is refused by the requirement", (t) => {
  if (!darwinOnly(t)) {
    return;
  }
  const requirement = darwinDesignatedRequirement(UNITY_DARWIN_TEAM_IDS);

  // /bin/ls is Apple-signed, so `--verify --strict` alone passes. That is what
  // makes the refusal below attributable to the identity clause: the same binary,
  // the same flags, one added `-R`.
  execFileSync(DARWIN_CODESIGN_PATH, ["--verify", "--strict", "--", "/bin/ls"], {
    stdio: "ignore"
  });
  assert.throws(
    () => execFileSync(
      DARWIN_CODESIGN_PATH,
      ["--verify", "--strict", "-R", `=${requirement}`, "--", "/bin/ls"],
      { stdio: "ignore" }
    ),
    "an Apple-anchored binary carrying no Developer ID team satisfied the Unity requirement"
  );
});

test("the compiler keeps the reviewed team rather than dropping the clause", (t) => {
  if (!darwinOnly(t)) {
    return;
  }
  /*
    The risk this case is red against is a clause `csreq` accepts and discards.
    `/bin/ls` cannot expose it: it is a platform binary with no Developer ID
    chain, so `certificate 1[...6.2.6] exists` refuses it before the identity is
    ever consulted, and the case above would read the same whether the team
    survived compilation or not.

    So ask the compiler instead. Compile the requirement, decompile it, and read
    back what it holds -- `csreq -r <file> -t` prints the canonical text of what
    was actually stored.
  */
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "unity-return-csreq-team-"));
  const compile = (requirement, name) => {
    const target = path.join(directory, name);
    execFileSync("/usr/bin/csreq", ["-r", `=${requirement}`, "-b", target], { stdio: "ignore" });
    return target;
  };

  const [reviewedTeam] = [...UNITY_DARWIN_TEAM_IDS];
  const shipped = compile(darwinDesignatedRequirement(UNITY_DARWIN_TEAM_IDS), "shipped.bin");
  const decompiled = execFileSync("/usr/bin/csreq", ["-r", shipped, "-t"], { encoding: "utf8" });
  assert.match(
    decompiled,
    new RegExp(reviewedTeam),
    `the compiled requirement does not hold ${reviewedTeam}, so the identity clause was dropped`
  );

  // And a different team compiles to different bytes, which is what makes the
  // match above a reading of this team rather than of any team.
  const other = compile(darwinDesignatedRequirement(new Set(["AAAAAAAAAA"])), "other.bin");
  assert.notEqual(
    fs.readFileSync(shipped).toString("hex"),
    fs.readFileSync(other).toString("hex"),
    "two different reviewed teams compiled to the same requirement"
  );
});
