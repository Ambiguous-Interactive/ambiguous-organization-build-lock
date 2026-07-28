const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const repoRoot = path.join(__dirname, "..");
const toolPath = path.join(repoRoot, "tools", "llm-harness.mjs");

async function loadHarness() {
  return import(pathToFileURL(toolPath));
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llm-harness-"));
  fs.mkdirSync(path.join(root, ".llm", "skills", "example"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".llm", "context.md"),
    "# Context\n\nRead [the generated index](./index.md).\n"
  );
  fs.writeFileSync(
    path.join(root, ".llm", "skills", "example", "SKILL.md"),
    [
      "---",
      "name: example",
      "description: Exercise the harness. Use when testing example changes.",
      "---",
      "# Example",
      "",
      "Follow the evidence."
    ].join("\n") + "\n"
  );
  return root;
}

test("index generation is deterministic and detects drift", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { generateIndex, verifyRepository } = await loadHarness();

  const first = generateIndex(root);
  const second = generateIndex(root);
  assert.equal(first, second);

  fs.writeFileSync(path.join(root, ".llm", "index.md"), first);
  assert.deepEqual(verifyRepository(root, { checkPointers: false }).errors, []);
  fs.appendFileSync(path.join(root, ".llm", "index.md"), "\nmanual edit\n");
  assert.match(
    verifyRepository(root, { checkPointers: false }).errors.join("\n"),
    /generated index is stale/
  );
});

test("skill metadata is strict and recursive", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { generateIndex, verifyRepository } = await loadHarness();
  fs.writeFileSync(path.join(root, ".llm", "index.md"), generateIndex(root));

  const skill = path.join(root, ".llm", "skills", "example", "SKILL.md");
  fs.writeFileSync(skill, "---\nname: wrong\ndescription: Valid description.\n---\n");
  let errors = verifyRepository(root, { checkPointers: false }).errors.join("\n");
  assert.match(errors, /must match its directory/);

  fs.writeFileSync(skill, "---\nname: example\ndescription: \"\"\n---\n");
  errors = verifyRepository(root, { checkPointers: false }).errors.join("\n");
  assert.match(errors, /description must contain 1-1024 characters/);

  fs.writeFileSync(skill, "---\nname: example\ndescription: Valid description.\nunknown-field: value\n---\n");
  errors = verifyRepository(root, { checkPointers: false }).errors.join("\n");
  assert.match(errors, /unknown metadata: unknown-field/);
});

test("standard YAML is accepted and every skill directory has SKILL.md", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { generateIndex, verifyRepository } = await loadHarness();
  const skill = path.join(root, ".llm", "skills", "example", "SKILL.md");
  fs.writeFileSync(
    skill,
    "---\nname: example\ndescription: >\n  Exercise examples.\n  Use when requested.\nmetadata:\n  owner: team\n---\n# Example\n"
  );
  assert.match(generateIndex(root), /Exercise examples\. Use when requested\./);

  fs.mkdirSync(path.join(root, ".llm", "skills", "orphan"));
  fs.writeFileSync(
    path.join(root, ".llm", "skills", "orphan", "README.md"),
    "<!-- summary: An invalid orphan skill. -->\n# Orphan\n"
  );
  assert.match(
    verifyRepository(root, { checkPointers: false }).errors.join("\n"),
    /orphan: skill directory must contain SKILL\.md/
  );
});

test("metadata limits count Unicode characters and reject whitespace", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { generateIndex, verifyRepository } = await loadHarness();
  const skill = path.join(root, ".llm", "skills", "example", "SKILL.md");
  fs.writeFileSync(
    skill,
    `---\nname: example\ndescription: ${"😀".repeat(600)}\ncompatibility: ${"😀".repeat(300)}\n---\n# Example\n`
  );
  assert.doesNotThrow(() => generateIndex(root));

  fs.writeFileSync(skill, "---\nname: example\ndescription: \"   \"\n---\n# Example\n");
  assert.match(
    verifyRepository(root, { checkPointers: false }).errors.join("\n"),
    /description must contain 1-1024 characters/
  );
});

test("non-Markdown files are discoverable skill resources or rejected", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { generateIndex, verifyRepository } = await loadHarness();
  fs.mkdirSync(path.join(root, ".llm", "skills", "example", "scripts"));
  fs.writeFileSync(path.join(root, ".llm", "skills", "example", "scripts", "check.js"), "0;\n");
  fs.writeFileSync(path.join(root, ".llm", "skills", "example", "LICENSE.txt"), "Example\n");
  assert.match(generateIndex(root), /scripts\/check\.js/);
  assert.match(generateIndex(root), /LICENSE\.txt/);

  fs.writeFileSync(path.join(root, ".llm", "facts.json"), "{}\n");

  assert.throws(() => generateIndex(root), /non-Markdown files must be bundled inside a valid Agent Skill/);
  assert.match(
    verifyRepository(root, { checkPointers: false }).errors.join("\n"),
    /\.llm\/facts\.json: non-Markdown files must be bundled inside a valid Agent Skill/
  );
});

test("nested SKILL.md files remain resources of their top-level skill", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { generateIndex, verifyRepository } = await loadHarness();
  const nestedSkill = path.join(
    root,
    ".llm",
    "skills",
    "example",
    "references",
    "SKILL.md"
  );
  fs.mkdirSync(path.dirname(nestedSkill), { recursive: true });
  fs.writeFileSync(nestedSkill, "# Referenced skill-shaped document\n");

  const index = generateIndex(root);
  assert.match(index, /## Skill Resources[\s\S]*references\/SKILL\.md/);
  const skillsSection = index.match(/## Skills\n[\s\S]*$/)[0];
  assert.doesNotMatch(skillsSection, /references\/SKILL\.md/);
  fs.writeFileSync(path.join(root, ".llm", "index.md"), index);
  assert.deepEqual(verifyRepository(root, { checkPointers: false }).errors, []);
});

test("line counting treats 300 as valid and 301 as invalid", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { countLines, verifyRepository, generateIndex } = await loadHarness();
  const skill = path.join(root, ".llm", "skills", "example", "SKILL.md");

  assert.equal(countLines("one\r\ntwo"), 2);
  assert.equal(countLines("one\n"), 1);
  fs.appendFileSync(skill, "line\r\n".repeat(293));
  assert.equal(countLines(fs.readFileSync(skill, "utf8")), 300);
  fs.writeFileSync(path.join(root, ".llm", "index.md"), generateIndex(root));
  assert.doesNotMatch(
    verifyRepository(root, { checkPointers: false }).errors.join("\n"),
    /exceeds 300/
  );
  fs.appendFileSync(skill, "line\n");
  assert.match(
    verifyRepository(root, { checkPointers: false }).errors.join("\n"),
    /301 lines exceeds 300/
  );
});

test("progress records reject credential-shaped literals without echoing them", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { generateIndex, verifyRepository } = await loadHarness();
  fs.writeFileSync(path.join(root, ".llm", "index.md"), generateIndex(root));
  fs.mkdirSync(path.join(root, "progress"));
  const record = path.join(root, "progress", "session-001-example.md");

  const credentials = [
    ["GitHub token", ["ghp", "_", "A".repeat(24)].join("")],
    [
      "underscore-containing GitHub token",
      ["ghp", "_", "A".repeat(10), "_", "B".repeat(12)].join("")
    ],
    ["underscore-ending GitHub token", ["ghp", "_", "C".repeat(19), "_"].join("")],
    ["AWS access key", ["AKIA", "B".repeat(16)].join("")],
    ["private key", "-----BEGIN PRIVATE KEY-----"],
    ["credential assignment", "UNITY_SERIAL=ABCD-1234-EFGH-5678"],
    ["lowercase assignment", "password=correcthorsebatterystaple"],
    ["angle-wrapped assignment", "UNITY_SERIAL=<ABCD-1234-EFGH-5678>"],
    ["none-prefixed assignment", "password=none_correcthorsebatterystaple"],
    ["unknown-prefixed assignment", "password=unknown-correcthorsebatterystaple"],
    ["hyphen-ending GitLab token", `glpat-${"A".repeat(19)}-`],
    ["hyphen-ending Slack token", `xoxb-${"B".repeat(9)}-`],
    ["hyphen-ending OpenAI token", `sk-${"C".repeat(19)}-`],
    [
      "hyphen-ending JWT",
      `eyJ${"D".repeat(8)}.${"E".repeat(8)}.${"F".repeat(7)}-`
    ]
  ];
  for (const [name, credential] of credentials) {
    fs.writeFileSync(record, `# Session 001\n\nAccidentally retained ${credential}.\n`);
    const errors = verifyRepository(root, { checkPointers: false }).errors.join("\n");
    assert.match(
      errors,
      /progress\/session-001-example\.md: credential-shaped literal/,
      name
    );
    assert.ok(!errors.includes(credential), `${name} must not be echoed`);
  }

  const binaryCredential = ["github_pat", "_", "C".repeat(24)].join("");
  fs.writeFileSync(record, Buffer.concat([
    Buffer.from([0]),
    Buffer.from(binaryCredential)
  ]));
  let errors = verifyRepository(root, { checkPointers: false }).errors.join("\n");
  assert.match(errors, /credential-shaped literal/, "NUL-containing file");
  assert.ok(!errors.includes(binaryCredential), "binary credential must not be echoed");

  fs.writeFileSync(record, [
    "# Session 001",
    "",
    "Use `${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}`.",
    "Record `UNITY_SERIAL=<redacted>`, `API_TOKEN=$API_TOKEN`, and",
    "`password=REDACTED-VALUE`, `secret=[placeholder]`, and `token=***`.",
    "Workflow examples may use `GITHUB_TOKEN=${{github.token}}` or",
    "`GH_TOKEN=${{ github.token }}`."
  ].join("\n") + "\n");
  errors = verifyRepository(root, { checkPointers: false }).errors.join("\n");
  assert.doesNotMatch(errors, /credential-shaped literal/);
});
