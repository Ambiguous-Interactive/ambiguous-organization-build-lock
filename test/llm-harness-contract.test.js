const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const repoRoot = path.join(__dirname, "..");
const toolPath = path.join(repoRoot, "tools", "llm-harness.mjs");

async function loadHarness() {
  return import(pathToFileURL(toolPath));
}

function assertAffirmativeContract(text, expectedSentence, contradictions = []) {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  const normalizedSentence = expectedSentence.replace(/\s+/g, " ").trim();
  assert.ok(
    normalizedText.includes(normalizedSentence),
    `missing affirmative contract: ${normalizedSentence}`
  );
  for (const contradiction of contradictions) {
    assert.doesNotMatch(text, contradiction);
  }
}

test("affirmative contract checks reject contradictory policy text", () => {
  assert.throws(
    () => assertAffirmativeContract(
      "The analysis is mandatory for substantial work. The analysis is optional for substantial work.",
      "The analysis is mandatory for substantial work.",
      [/\banalysis\s+is\s+optional\s+for substantial work\b/i]
    ),
    /analysis\s+is\s+optional/i
  );
});

test("repository harness is complete and current", async () => {
  const { verifyRepository } = await loadHarness();
  const result = verifyRepository(repoRoot);
  assert.deepEqual(result.errors, []);
});

test("progress records are explicitly public and sanitized", () => {
  const context = fs.readFileSync(path.join(repoRoot, ".llm", "context.md"), "utf8");
  assert.match(
    context,
    /Treat `progress\/` records as public audit evidence:[\s\S]*never credential literals, raw logs, personal data, or live lock\s+state\./
  );
});

test("substantial work requires an evidence-backed improvement and review contract", () => {
  const context = fs.readFileSync(path.join(repoRoot, ".llm", "context.md"), "utf8");
  const skill = fs.readFileSync(
    path.join(repoRoot, ".llm", "skills", "continuous-improvement", "SKILL.md"),
    "utf8"
  );
  const taskTemplate = fs.readFileSync(path.join(repoRoot, ".llm", "tasks", "README.md"), "utf8");

  assertAffirmativeContract(
    context,
    "For substantial work, use the independent review and remediation loop defined by the continuous-improvement skill.",
    [/\bfor substantial work,\s+(?:do not|need not|never)\s+use the independent review/i]
  );
  assertAffirmativeContract(
    context,
    "After substantial work, run the [continuous-improvement skill](./skills/continuous-improvement/SKILL.md): analyze evidence and root causes, then promote durable learning into the narrowest authoritative LLM resource or record why none should be stored.",
    [/\bafter substantial work,\s+(?:do not|need not|never)\s+run the\s+\[?continuous-improvement/i]
  );
  assertAffirmativeContract(
    skill,
    "The analysis is mandatory for substantial work; a knowledge edit is mandatory only when the evidence supports one.",
    [
      /\banalysis\s+(?:is|remains|shall be|must be)\s+(?:not|never)\s+mandatory\b/i,
      /\banalysis\s+(?:is|remains)\s+optional\s+for substantial work\b/i
    ]
  );
  assertAffirmativeContract(
    skill,
    "For substantial work, use distinct agents for implementation, review, and remediation when the environment supports agents, the task can be handed off safely, and enough independent agents are available.",
    [
      /\b(?:do not|need not|must not|never)\s+use distinct agents\b/i,
      /\bthe same agent\s+(?:may|can|should|must)\s+(?:perform|handle)\s+(?:implementation,\s*)?review,\s*and remediation\b/i
    ]
  );
  assertAffirmativeContract(
    skill,
    "If findings exist, a remediator who is distinct from that reviewer evaluates each finding, implements justified fixes, and records the disposition of rejected recommendations.",
    [/\ba remediator\s+(?:need not|does not have to|may not)\s+be distinct from (?:that|the) reviewer\b/i]
  );
  assertAffirmativeContract(
    skill,
    "Send the revised result to an independent reviewer and repeat until every reviewer in the latest review round reports no actionable findings.",
    [/\b(?:do not|need not|never)\s+repeat until every reviewer\b/i]
  );
  for (const requiredContract of [
    /two independently maintained surfaces/i,
    /one surface changed, but the work was operationally risky/i,
    /remediator who is distinct from that reviewer/i,
    /until every reviewer in the latest review round reports no actionable findings/i,
    /main thread as explicitly separated implementation, adversarial\s+review, and remediation passes/si,
    /Record why the fallback was used/i,
    /Do not substitute a claim of perfection/i,
    /procedural and auditable handoff contract/i,
    /cannot\s+prove agent identity, independence, review quality/si,
    /exempt/i,
    /observed fact/i,
    /root cause/i,
    /no durable learning/i,
    /node tools\/llm-harness\.mjs generate/,
    /node tools\/llm-harness\.mjs check/
  ]) {
    assert.match(skill, requiredContract);
  }
  assert.match(taskTemplate, /Knowledge retention/);
  assert.match(taskTemplate, /Evidence:/);
  assert.match(taskTemplate, /Promotion decision:/);
  assert.match(taskTemplate, /Implementer:/);
  assert.match(taskTemplate, /Reviewer and evidence:/);
  assert.match(taskTemplate, /Remediator and dispositions:/);
  assert.match(taskTemplate, /Main-thread fallback reason/);
  assert.match(taskTemplate, /automated checks can\s+verify their structure, but not reviewer independence/si);
});

test("engineering workflows encode investigation, planning, review, and test risk gates", () => {
  const readSkill = (name) =>
    fs.readFileSync(path.join(repoRoot, ".llm", "skills", name, "SKILL.md"), "utf8");
  const investigation = readSkill("investigation");
  const planning = readSkill("architecture-and-plan-review");
  const review = readSkill("adversarial-review");
  const testing = readSkill("testing-and-validation");
  const improvement = readSkill("continuous-improvement");
  const taskTemplate = fs.readFileSync(path.join(repoRoot, ".llm", "tasks", "README.md"), "utf8");

  assertAffirmativeContract(
    investigation,
    "State one falsifiable hypothesis at a time, including the predicted observation and evidence that would disprove it.",
    [/\bstate\s+(?:multiple|more than one)\s+(?:falsifiable\s+)?hypotheses?\s+at a time\b/i]
  );
  assertAffirmativeContract(
    investigation,
    "First add or identify a regression test that fails before the fix and passes after it.",
    [/\ba regression test\s+(?:need not|does not have to)\s+fail before the fix\b/i]
  );
  for (const contract of [
    /deterministic reproduction|reproduction status/i,
    /three falsified hypotheses/i,
    /cannot reproduce/i
  ]) {
    assert.match(investigation, contract);
  }
  for (const contract of [
    /existing (code|mechanism|solution)/i,
    /affected-surface map/i,
    /state.*data flow/i,
    /failure and recovery/i,
    /rollback|reversib/i,
    /test.*verification map/i
  ]) {
    assert.match(planning, contract);
  }
  for (const contract of [
    /acceptance criteria.*invariants/is,
    /intent.*diff/i,
    /motivating.*file.*line/is,
    /both sides.*race|both sides.*contract/is,
    /open question/i,
    /full affected files/i
  ]) {
    assert.match(review, contract);
  }
  assertAffirmativeContract(
    review,
    "Start with fresh context to reduce anchoring. Before reading the implementer's rationale, claimed root cause, or conclusions:",
    [/\bstart with (?:the )?implementer's rationale\s+(?:instead of|before)\s+fresh context\b/i]
  );
  for (const contract of [
    /positive/i,
    /negative/i,
    /error/i,
    /boundary.*extreme/i,
    /concurren/i,
    /cancellation/i,
    /recovery/i,
    /inject.*clock.*random.*sleep.*I\/O/is,
    /central invariant|entire unsafe (shape|class)/i
  ]) {
    assert.match(testing, contract);
  }
  assertAffirmativeContract(testing, "Do not use real sleep in tests.", [
    /\b(?:may|can|should|must)\s+use real sleep in tests\b/i,
    /\breal sleep in tests\s+is\s+(?:allowed|acceptable|recommended|required)\b/i
  ]);
  assertAffirmativeContract(
    testing,
    "A mandatory test must pass on the first attempt. Repetition is a diagnostic for flakes, never a retry-based green gate; any divergent run is evidence of nondeterminism.",
    [
      /\bmandatory test\s+(?:need not|does not have to|may fail and still)\s+pass on the first attempt\b/i,
      /\brepetition\s+(?:is|may be|can be)\s+a retry-based green gate\b/i,
      /\bretry-based green gate\s+is\s+(?:allowed|acceptable)\b/i
    ]
  );
  assertAffirmativeContract(
    improvement,
    "Discard stale results and perform fresh verification after any remediation, against the revised state before re-review.",
    [/\b(?:reuse|retain|accept)\s+stale results\b/i, /\bskip fresh verification after (?:any )?remediation\b/i]
  );
  assert.match(taskTemplate, /Risk and path matrix/);
  assert.match(taskTemplate, /Reproduction status/);
  assert.match(taskTemplate, /Unverifiable|Open questions/);
});

test("vendor files remain thin canonical pointers", async () => {
  const { POINTERS, pointerContent } = await loadHarness();
  for (const pointer of POINTERS) {
    const content = fs.readFileSync(path.join(repoRoot, pointer.path), "utf8");
    assert.equal(content, pointerContent(pointer), `${pointer.path} must remain canonical`);
  }
});

test("CI, devcontainer, and the executable hook share the canonical check", () => {
  const command = "node tools/llm-harness.mjs check";
  const ci = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const verify = fs.readFileSync(
    path.join(repoRoot, ".devcontainer", "scripts", "verify.sh"),
    "utf8"
  );
  const hookPath = path.join(repoRoot, ".githooks", "pre-commit");
  const hook = fs.readFileSync(hookPath, "utf8");

  assert.ok(ci.includes(command));
  assert.ok(verify.includes(command));
  assert.ok(hook.includes('tools/llm-harness.mjs" check'));
  assert.ok(hook.includes("git checkout-index --all"));
  assert.ok(hook.includes('check --root "${staged_tree}"'));
  assert.notEqual(fs.statSync(hookPath).mode & 0o111, 0, "pre-commit hook must be executable");
});
