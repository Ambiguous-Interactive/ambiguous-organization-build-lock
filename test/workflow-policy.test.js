const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");
const workflowsRoot = path.join(repoRoot, ".github", "workflows");
const policyTextExtensions = new Set([".js", ".json", ".md", ".yml", ".yaml"]);
const unparsedJobsName = "<unparsed-flow-jobs>";
const expectedWorkflowJobs = new Map([
  ["auto-release.yml", ["release"]],
  ["ci.yml", ["validate"]],
  ["consumer-policy-audit.yml", ["audit"]],
  ["dependabot-auto-merge.yml", ["dependabot"]],
  ["reap-stale-locks.yml", ["reap"]]
]);
const expectedConsumerPolicySnapshots = [
  ["Ambiguous-Interactive/unity-helpers", "consumers/unity-helpers", "af34f6f0234119100dde525d77c4a9f04315e736"],
  ["Ambiguous-Interactive/DxMessaging", "consumers/DxMessaging", "282e38d156ff7611c68354e8f22aca275cb3b077"],
  ["Ambiguous-Interactive/DoxReloaded", "consumers/DoxReloaded", "41177409036293a16c525017a571fe46d56f5325"],
  ["Ambiguous-Interactive/IshoBoy", "consumers/IshoBoy", "3d8d4d9f6526aef2baa4a488024f5e79cd937a08"],
  ["Ambiguous-Interactive/qora-redux", "consumers/qora-redux", "c9a1da99f06f9426fa6bc909e398effbc972ad44"],
  ["Ambiguous-Interactive/DepartmentOfArrangements", "consumers/DepartmentOfArrangements", "70d7a3a6ba66f3703ac427be099d694cd64550ce"],
  ["Ambiguous-Interactive/unity-builder", "consumers/unity-builder", "bb2ff53bc0855f97da41a71c93bf0f4b37e60efa"]
];
const expectedCurrentHeadGuardSHA = "8e1cf892f5ee710908fc14f09b3c8033edcb74f9";
const expectedWorkflowRunScriptSignatures = new Map([
  [
    "auto-release.yml",
    ['git config user.name "github-actions[bot]"\ngit config user.email "41898282+github-actions[bot]@users.noreply.github.com"']
  ],
  [
    "ci.yml",
    [
      'for action_file in .github/dist/*.js; do\nnode --check "${action_file}"',
      "set -euo pipefail\ngo run -mod=readonly github.com/rhysd/actionlint/cmd/actionlint -color",
      "node --test test/*.test.js",
      'go mod tidy -diff\ngo test ./...'
    ]
  ],
  [
    "consumer-policy-audit.yml",
    [
      "set -euo pipefail\nif ! [[ \"${SOURCE_HEAD_REPOSITORY}\" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||",
      "go run ./cmd/resolve-consumer-policy-candidate\n--event \"${SOURCE_EVENT}\"",
      "go run ./cmd/validate-consumer-policy-manifest\n--git-dir \"${CANDIDATE_GIT_DIR}\"",
      "set -euo pipefail\nverify_head() {",
      "set -euo pipefail\ngo run ./cmd/audit-cancellation-policy --git-dir ../consumers/unity-helpers --repository Ambiguous-Interactive/unity-helpers --sha \"${{ steps.manifest.outputs.unity_helpers_sha }}\" --required-guard-sha 8e1cf892f5ee710908fc14f09b3c8033edcb74f9",
      "set -euo pipefail\nverify_head() {",
      "set -euo pipefail\nlive_identity_ok=false"
    ]
  ],
  [
    "dependabot-auto-merge.yml",
    [
      "set -euo pipefail\nskip() {",
      "set -euo pipefail\n# Poll for up to ~13.3 minutes, leaving headroom under the 15 minute job timeout.",
      'set -euo pipefail\npr_json="$(gh api "repos/${REPOSITORY}/pulls/${PR_NUMBER}")"'
    ]
  ],
  ["reap-stale-locks.yml", []]
]);
const expectedActionlintModule = "github.com/rhysd/actionlint";
const expectedActionlintCommand = `${expectedActionlintModule}/cmd/actionlint`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readWorkflow(name) {
  return fs.readFileSync(path.join(workflowsRoot, name), "utf8");
}

function listWorkflows() {
  return fs
    .readdirSync(workflowsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.name);
}

test("all remote workflow actions are pinned to immutable commit SHAs", () => {
  for (const workflowName of listWorkflows()) {
    const workflow = readWorkflow(workflowName);
    for (const match of workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
      const reference = match[1];
      if (reference.startsWith("./")) continue;
      assert.match(
        reference,
        /^[^/@\s]+\/[^/@\s]+(?:\/[^@\s]+)?@[a-f0-9]{40}$/,
        `${workflowName} must pin ${reference} to a full immutable commit SHA`
      );
    }
  }
});

function listPolicyTextFiles(root = repoRoot) {
  return childProcess
    .execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((file) => policyTextExtensions.has(path.extname(file).toLowerCase()))
    .map((file) => path.join(root, file));
}

function stripYamlComment(value) {
  let quote = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (quote) {
      if (quote === "\"" && char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (char === "#" && (index === 0 || /[ \t]/.test(value[index - 1]))) {
      return value.slice(0, index).trim();
    }
  }

  return value.trim();
}

function stripOptionalYamlQuotes(value) {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2] : trimmed;
}

function yamlScalarValue(value) {
  return stripOptionalYamlQuotes(stripYamlNodeDecorators(stripYamlComment(value)));
}

function yamlExplicitNodeValue(value) {
  const stripped = stripYamlNodeDecorators(stripYamlComment(value));
  const explicitNode = /^[?:][ \t]+(.+)$/.exec(stripped);
  return explicitNode ? stripYamlNodeDecorators(stripYamlComment(explicitNode[1])) : stripped;
}

function yamlMappingKeyValue(value) {
  return stripOptionalYamlQuotes(yamlExplicitNodeValue(value));
}

function stripYamlNodeDecorators(value) {
  let rest = value.trim();

  for (;;) {
    const decorator = /^(?:&[A-Za-z0-9_.-]+|!![A-Za-z0-9_.:/-]+|![A-Za-z0-9_.:/-]+|!<[^>]+>)(?:\s+|$)/.exec(rest);
    if (!decorator) {
      return rest;
    }
    rest = rest.slice(decorator[0].length).trimStart();
  }
}

function yamlNodeValue(value) {
  const stripped = stripYamlNodeDecorators(value);
  return stripped === value.trim() ? value.trim() : stripped;
}

function lineIndent(line) {
  return /^ */.exec(line)[0].length;
}

function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
}

function isYamlBlockScalar(value) {
  return /^[|>](?:(?:[+-]?[1-9])|(?:[1-9][+-]?)|[+-])?\s*(?:#.*)?$/.test(value.trim());
}

function isBlankOrComment(line) {
  return /^[ \t]*(?:#.*)?$/.test(line);
}

function findMappingBlockEnd(lines, startIndex, parentIndent) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (!isBlankOrComment(lines[index]) && lineIndent(lines[index]) <= parentIndent) {
      return index;
    }
  }
  return lines.length;
}

function findBlockScalarEnd(lines, startIndex, parentIndent) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (!isBlankLine(lines[index]) && lineIndent(lines[index]) <= parentIndent) {
      return index;
    }
  }
  return lines.length;
}

function splitTopLevel(value) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (quote) {
      if (quote === "\"" && char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (char === "[" || char === "{") {
      depth += 1;
      continue;
    }

    if (char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (char === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  const finalPart = value.slice(start).trim();
  if (finalPart || parts.length > 0) {
    parts.push(finalPart);
  }
  return parts.filter((part) => part.length > 0);
}

function findTopLevelColon(value) {
  let depth = 0;
  let quote = null;
  let tag = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (tag) {
      if (char === ">") {
        tag = false;
      }
      continue;
    }

    if (quote) {
      if (quote === "\"" && char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (char === "!" && value[index + 1] === "<") {
      tag = true;
      index += 1;
      continue;
    }

    if (char === "[" || char === "{") {
      depth += 1;
      continue;
    }

    if (char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (char === ":" && depth === 0) {
      return index;
    }
  }

  return -1;
}

function flowBalance(value) {
  let depth = 0;
  let quote = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (quote) {
      if (quote === "\"" && char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (char === "[" || char === "{") {
      depth += 1;
      continue;
    }

    if (char === "]" || char === "}") {
      depth -= 1;
    }
  }

  return depth;
}

function collectFlowNodeText(lines, startIndex, endIndex, firstValue) {
  const collected = [firstValue];
  let depth = flowBalance(stripYamlFlowComments(collected.join("\n")));

  for (let index = startIndex + 1; depth > 0 && index < lines.length; index += 1) {
    const line = lines[index];
    if (index >= endIndex && !/^[}\]]/.test(stripYamlFlowComments(line).trimStart())) {
      break;
    }

    collected.push(line);
    depth = flowBalance(stripYamlFlowComments(collected.join("\n")));
  }

  return collected.join("\n").trimEnd();
}

function stripYamlFlowComments(value) {
  let quote = null;
  let result = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (quote) {
      result += char;
      if (quote === "\"" && char === "\\") {
        index += 1;
        if (index < value.length) {
          result += value[index];
        }
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      result += char;
      continue;
    }

    if (char === "#" && (index === 0 || /[ \t]/.test(value[index - 1]))) {
      while (index < value.length && value[index] !== "\n" && value[index] !== "\r") {
        index += 1;
      }
      if (index < value.length) {
        result += value[index];
      }
      continue;
    }

    result += char;
  }

  return result.trim();
}

function parseFlowSequence(value) {
  const trimmed = stripYamlNodeDecorators(stripYamlFlowComments(value));
  if (flowBalance(trimmed) !== 0) {
    return null;
  }
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }

  const body = trimmed.slice(1, -1).trim();
  if (!body) {
    return [];
  }
  return splitTopLevel(body);
}

function parseFlowMapEntries(value) {
  const trimmed = stripYamlNodeDecorators(stripYamlFlowComments(value));
  if (flowBalance(trimmed) !== 0) {
    return null;
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  const body = trimmed.slice(1, -1).trim();
  if (!body) {
    return [];
  }

  const entries = [];
  for (const part of splitTopLevel(body)) {
    const colon = findTopLevelColon(part);
    if (colon === -1) {
      return null;
    }

    const rawKey = part.slice(0, colon).trim();
    entries.push({
      rawKey,
      key: yamlMappingKeyValue(rawKey),
      value: part.slice(colon + 1).trim()
    });
  }
  return entries;
}

function parseFlowMap(value) {
  const entries = parseFlowMapEntries(value);
  if (!entries) {
    return null;
  }

  const mapping = {};
  for (const entry of entries) {
    mapping[entry.key] = entry.value;
  }
  return mapping;
}

function normalizeYamlScalarMapValues(mapping) {
  return Object.fromEntries(Object.entries(mapping).map(([key, value]) => [key, yamlScalarValue(value)]));
}

function parseYamlKeyText(text) {
  const normalizedText = stripYamlNodeDecorators(text);
  if (normalizedText.startsWith("?")) {
    const body = normalizedText.slice(1).trimStart();
    const colon = findTopLevelColon(body);
    if (colon === -1) {
      const rawKey = `? ${body}`;
      return {
        rawKey,
        key: yamlMappingKeyValue(rawKey),
        value: "",
        explicit: true,
        explicitValueMissing: true
      };
    }

    const rawKey = `? ${body.slice(0, colon).trim()}`;
    return {
      rawKey,
      key: yamlMappingKeyValue(rawKey),
      value: yamlNodeValue(stripYamlComment(body.slice(colon + 1))),
      explicit: true,
      explicitValueMissing: false
    };
  }

  const entry = /^((?:"(?:[^"\\]|\\.)*"|'[^']*'|\*[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+)):[ \t]*(.*)$/.exec(normalizedText);
  if (!entry) {
    return null;
  }

  return {
    rawKey: entry[1],
    key: yamlScalarValue(entry[1]),
    value: yamlNodeValue(stripYamlComment(entry[2]))
  };
}

function explicitMappingValue(lines, startIndex, endIndex, parentIndent) {
  for (let index = startIndex; index < endIndex; index += 1) {
    const line = lines[index];
    if (isBlankOrComment(line)) {
      continue;
    }

    const indent = lineIndent(line);
    if (indent < parentIndent) {
      return null;
    }

    const value = yamlNodeValue(stripYamlComment(line.slice(indent)));
    const entry = /^:[ \t]*(.*)$/.exec(value);
    return entry ? { index, indent, value: yamlNodeValue(stripYamlComment(entry[1])) } : null;
  }
  return null;
}

function explicitMappingValueAfterLine(lines, index, endIndex, parentIndent) {
  const inlineEntry = /^:[ \t]*(.*)$/.exec(yamlNodeValue(stripYamlComment(lines[index].slice(lineIndent(lines[index])))));
  if (inlineEntry) {
    return {
      index,
      indent: lineIndent(lines[index]),
      value: yamlNodeValue(stripYamlComment(inlineEntry[1]))
    };
  }
  return explicitMappingValue(lines, index + 1, endIndex, parentIndent);
}

function parseYamlKeyLine(line) {
  const indent = lineIndent(line);
  const entry = parseYamlKeyText(line.slice(indent));
  return entry && { ...entry, index: null, indent };
}

function parseSequenceItem(line) {
  const item = /^( *)-(?:[ \t]+(.*))?$/.exec(line);
  if (!item) {
    return null;
  }

  return {
    index: null,
    indent: item[1].length,
    value: yamlNodeValue(stripYamlComment(item[2] || ""))
  };
}

function directMappingEntries(lines, startIndex, endIndex, parentIndent) {
  const firstChild = directChildValue(lines, startIndex, endIndex, parentIndent);
  if (firstChild && isFlowLike(firstChild.value)) {
    const entry = parseYamlKeyLine(lines[firstChild.index]);
    return entry && entry.indent === firstChild.indent ? [{ ...entry, index: firstChild.index }] : [];
  }

  let childIndent = null;
  for (let index = startIndex; index < endIndex; index += 1) {
    const line = lines[index];
    if (isBlankOrComment(line)) {
      continue;
    }

    const entry = parseYamlKeyLine(line);
    if (!entry || entry.indent <= parentIndent) {
      continue;
    }
    if (isFlowLike(entry.value)) {
      childIndent = childIndent === null ? entry.indent : Math.min(childIndent, entry.indent);
      break;
    }

    childIndent = childIndent === null ? entry.indent : Math.min(childIndent, entry.indent);
  }

  if (childIndent === null) {
    return [];
  }

  const entries = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const entry = parseYamlKeyLine(lines[index]);
    if (entry && entry.indent === childIndent) {
      const explicitValue =
        entry.explicit && entry.explicitValueMissing
          ? explicitMappingValue(lines, index + 1, endIndex, entry.indent)
          : null;
      entries.push({
        ...entry,
        index,
        value: explicitValue ? explicitValue.value : entry.value,
        valueIndex: explicitValue ? explicitValue.index : index,
        valueIndent: explicitValue ? explicitValue.indent : entry.indent
      });
    }
  }
  return entries;
}

function directSequenceItems(lines, startIndex, endIndex, parentIndent) {
  let childIndent = null;
  for (let index = startIndex; index < endIndex; index += 1) {
    const line = lines[index];
    if (isBlankOrComment(line)) {
      continue;
    }

    const item = parseSequenceItem(line);
    if (!item || item.indent <= parentIndent) {
      continue;
    }
    if (isFlowLike(item.value)) {
      childIndent = childIndent === null ? item.indent : Math.min(childIndent, item.indent);
      break;
    }

    childIndent = childIndent === null ? item.indent : Math.min(childIndent, item.indent);
  }

  if (childIndent === null) {
    return [];
  }

  const items = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const item = parseSequenceItem(lines[index]);
    if (item && item.indent === childIndent) {
      items.push({ ...item, index });
    }
  }
  return items;
}

function directChildValue(lines, startIndex, endIndex, parentIndent) {
  for (let index = startIndex; index < endIndex; index += 1) {
    const line = lines[index];
    if (isBlankOrComment(line)) {
      continue;
    }

    const indent = lineIndent(line);
    if (indent <= parentIndent) {
      return null;
    }

    return {
      index,
      indent,
      value: yamlNodeValue(stripYamlComment(line.slice(indent)))
    };
  }
  return null;
}

function blockText(lines, startIndex, endIndex) {
  return lines.slice(startIndex, endIndex).join("\n");
}

function isFlowSequenceLike(value) {
  return stripYamlNodeDecorators(stripYamlComment(value)).startsWith("[");
}

function isFlowMapLike(value) {
  return stripYamlNodeDecorators(stripYamlComment(value)).startsWith("{");
}

function isFlowLike(value) {
  const stripped = stripYamlNodeDecorators(stripYamlComment(value));
  return stripped.startsWith("[") || stripped.startsWith("{");
}

function isYamlAlias(value) {
  return /^\*[A-Za-z0-9_.-]+$/.test(yamlExplicitNodeValue(value));
}

function findTopLevelMappingEntry(lines, key) {
  for (let index = 0; index < lines.length; index += 1) {
    if (isBlankOrComment(lines[index]) || lineIndent(lines[index]) !== 0) {
      continue;
    }

    const entry = parseYamlKeyLine(lines[index]);
    if (entry && entry.key === key) {
      const explicitValue =
        entry.explicit && entry.explicitValueMissing ? explicitMappingValue(lines, index + 1, lines.length, entry.indent) : null;
      return {
        ...entry,
        index,
        value: explicitValue ? explicitValue.value : entry.value,
        valueIndex: explicitValue ? explicitValue.index : index,
        valueIndent: explicitValue ? explicitValue.indent : entry.indent
      };
    }
  }
  return null;
}

function mappingValueBlock(lines, entry) {
  const valueIndex = entry.valueIndex ?? entry.index;
  const valueIndent = entry.valueIndent ?? entry.indent;
  const childStart = valueIndex === entry.index ? entry.index + 1 : valueIndex + 1;
  const childIndent = valueIndex === entry.index ? entry.indent : valueIndent;
  return {
    end: findMappingBlockEnd(lines, childStart, childIndent),
    indent: childIndent,
    start: childStart
  };
}

function permissionsFromFlowMap(value) {
  const flowMap = parseFlowMap(value);
  if (!flowMap) {
    return null;
  }

  const permissions = new Map();
  for (const [name, level] of Object.entries(flowMap)) {
    const permissionLevel = permissionLevelFromScalar(level);
    if (!permissionLevel) {
      return new Map();
    }
    permissions.set(name, permissionLevel);
  }
  return permissions;
}

function permissionLevelFromScalar(value) {
  const level = yamlScalarValue(value);
  return /^(?:read|write|none)$/.test(level) ? level : null;
}

function permissionsFromBlock(text, indent) {
  const lines = text.split(/\r?\n/);
  let declaration = null;
  for (const [index, line] of lines.entries()) {
    const entry = parseYamlKeyLine(line);
    if (entry && entry.indent === indent && entry.key === "permissions") {
      const explicitValue =
        entry.explicit && entry.explicitValueMissing ? explicitMappingValue(lines, index + 1, lines.length, entry.indent) : null;
      declaration = {
        ...entry,
        index,
        value: explicitValue ? explicitValue.value : entry.value,
        valueIndex: explicitValue ? explicitValue.index : index,
        valueIndent: explicitValue ? explicitValue.indent : entry.indent
      };
      break;
    }
  }

  if (!declaration) {
    return null;
  }

  const value = declaration.value;
  if (value) {
    const scalar = yamlScalarValue(value);
    if (scalar === "write-all") {
      return new Map([["*", "write"]]);
    }
    if (scalar === "read-all") {
      return new Map([["*", "read"]]);
    }

    const flowMap = permissionsFromFlowMap(value);
    return flowMap || new Map();
  }

  const block = mappingValueBlock(lines, declaration);
  const blockEnd = block.end;
  const child = directChildValue(lines, block.start, blockEnd, block.indent);
  if (child && isFlowMapLike(child.value)) {
    const flowText = collectFlowNodeText(lines, child.index, blockEnd, child.value);
    return permissionsFromFlowMap(flowText) || new Map();
  }

  const entries = directMappingEntries(lines, block.start, blockEnd, block.indent);
  if (entries.length === 0) {
    return new Map();
  }

  const permissions = new Map();
  for (const entry of entries) {
    const permissionLevel = permissionLevelFromScalar(entry.value);
    if (!permissionLevel) {
      return new Map();
    }
    permissions.set(entry.key, permissionLevel);
  }
  return permissions;
}

function hasPermission(permissions, name, required) {
  if (!permissions) {
    return false;
  }
  const level = permissions.get(name) || permissions.get("*") || "none";
  return level === required || (required === "read" && level === "write");
}

function hasEffectivePermission(workflowText, jobText, name, required) {
  if (/^<unparsed-flow-jobs>\n/.test(jobText)) {
    return false;
  }

  const jobHeader = jobText.split(/\r?\n/).find((line) => !isBlankOrComment(line));
  const jobPermissions = permissionsFromBlock(jobText, jobHeader ? lineIndent(jobHeader) + 2 : 4);
  if (jobPermissions) {
    return hasPermission(jobPermissions, name, required);
  }
  return hasPermission(permissionsFromBlock(workflowText, 0), name, required);
}

function workflowHasTrigger(text, trigger) {
  const lines = text.split(/\r?\n/);
  const onEntry = findTopLevelMappingEntry(lines, "on");
  if (!onEntry) {
    return false;
  }

  if (onEntry.value) {
    const valueIndex = onEntry.valueIndex ?? onEntry.index;
    const valueIndent = onEntry.valueIndent ?? onEntry.indent;
    const onEnd = findMappingBlockEnd(lines, valueIndex + 1, valueIndent);
    const onValue = isFlowLike(onEntry.value) ? collectFlowNodeText(lines, valueIndex, onEnd, onEntry.value) : onEntry.value;
    const flowMap = parseFlowMap(onValue);
    if (flowMap) {
      return Object.prototype.hasOwnProperty.call(flowMap, trigger);
    }

    const flowSequence = parseFlowSequence(onValue);
    if (flowSequence) {
      return flowSequence.some((item) => yamlScalarValue(item) === trigger);
    }

    return yamlScalarValue(onValue) === trigger;
  }

  const onBlock = mappingValueBlock(lines, onEntry);
  const onEnd = onBlock.end;
  const mappingEntries = directMappingEntries(lines, onBlock.start, onEnd, onBlock.indent);
  const sequenceItems = directSequenceItems(lines, onBlock.start, onEnd, onBlock.indent);
  if (mappingEntries.length > 0 || sequenceItems.length > 0) {
    return (
      mappingEntries.some((entry) => entry.key === trigger) ||
      sequenceItems.some((item) => yamlScalarValue(item.value) === trigger)
    );
  }

  const child = directChildValue(lines, onBlock.start, onEnd, onBlock.indent);
  if (!child) {
    return false;
  }

  const childText = blockText(lines, child.index, onEnd);
  const flowMap = parseFlowMap(childText);
  if (flowMap) {
    return Object.prototype.hasOwnProperty.call(flowMap, trigger);
  }

  const flowSequence = parseFlowSequence(childText);
  if (flowSequence) {
    return flowSequence.some((item) => yamlScalarValue(item) === trigger);
  }

  return true;
}

function workflowConcurrency(text) {
  const lines = text.split(/\r?\n/);
  const concurrencyEntry = findTopLevelMappingEntry(lines, "concurrency");
  if (!concurrencyEntry) {
    return null;
  }

  if (concurrencyEntry.value) {
    const valueIndex = concurrencyEntry.valueIndex ?? concurrencyEntry.index;
    const valueIndent = concurrencyEntry.valueIndent ?? concurrencyEntry.indent;
    const end = findMappingBlockEnd(lines, valueIndex + 1, valueIndent);
    const value = isFlowLike(concurrencyEntry.value)
      ? collectFlowNodeText(lines, valueIndex, end, concurrencyEntry.value)
      : concurrencyEntry.value;
    const flowMap = parseFlowMap(value);
    return flowMap ? normalizeYamlScalarMapValues(flowMap) : { group: value };
  }

  const concurrency = {};
  const concurrencyBlock = mappingValueBlock(lines, concurrencyEntry);
  const end = concurrencyBlock.end;
  for (const entry of directMappingEntries(lines, concurrencyBlock.start, end, concurrencyBlock.indent)) {
    concurrency[entry.key] = yamlScalarValue(entry.value);
  }
  if (Object.keys(concurrency).length > 0) {
    return concurrency;
  }

  const child = directChildValue(lines, concurrencyBlock.start, end, concurrencyBlock.indent);
  if (!child) {
    return concurrency;
  }
  const flowMap = parseFlowMap(blockText(lines, child.index, end));
  return flowMap ? normalizeYamlScalarMapValues(flowMap) : {};
}

function hasStableConcurrencyGroup(concurrency) {
  if (!concurrency || !concurrency.group) {
    return false;
  }

  const group = yamlScalarValue(concurrency.group);
  return /^[A-Za-z0-9_.-]+$/.test(group) || /^\$\{\{\s*github\.workflow\s*\}\}$/.test(group);
}

function jobSections(text) {
  const lines = text.split(/\r?\n/);
  const jobsEntry = findTopLevelMappingEntry(lines, "jobs");
  if (!jobsEntry) {
    return [];
  }
  if (jobsEntry.value) {
    const valueIndex = jobsEntry.valueIndex ?? jobsEntry.index;
    const valueIndent = jobsEntry.valueIndent ?? jobsEntry.indent;
    const jobsEnd = findMappingBlockEnd(lines, valueIndex + 1, valueIndent);
    const value = isFlowMapLike(jobsEntry.value) ? collectFlowNodeText(lines, valueIndex, jobsEnd, jobsEntry.value) : jobsEntry.value;
    return [{ name: unparsedJobsName, text: `${unparsedJobsName}\n${value}` }];
  }

  const jobsBlock = mappingValueBlock(lines, jobsEntry);
  const jobsEnd = jobsBlock.end;
  const starts = directMappingEntries(lines, jobsBlock.start, jobsEnd, jobsBlock.indent);
  if (starts.length === 0) {
    const child = directChildValue(lines, jobsBlock.start, jobsEnd, jobsBlock.indent);
    return child ? [{ name: unparsedJobsName, text: `${unparsedJobsName}\n${blockText(lines, child.index, jobsEnd)}` }] : [];
  }
  if (starts.length === 1 && isFlowMapLike(starts[0].value)) {
    return [{ name: unparsedJobsName, text: `${unparsedJobsName}\n${blockText(lines, starts[0].index, jobsEnd)}` }];
  }

  return starts.map((start, index) => {
    const next = starts[index + 1];
    const end = next ? next.index : jobsEnd;
    const child = directChildValue(lines, start.index + 1, end, start.indent);
    const unparsedFlowBody = isFlowMapLike(start.value) || (child && isFlowMapLike(child.value));
    const jobText = lines.slice(start.index, end).join("\n");
    return {
      name: start.key,
      text: unparsedFlowBody ? `${unparsedJobsName}\n${jobText}` : jobText
    };
  });
}

function collectRunScript(lines, index, parentIndent, value) {
  if (isYamlAlias(value)) {
    return {
      section: { line: index + 1, text: blockText(lines, 0, lines.length) },
      nextIndex: index + 1
    };
  }

  if (!isYamlBlockScalar(value)) {
    return {
      section: { line: index + 1, text: stripOptionalYamlQuotes(value) },
      nextIndex: index + 1
    };
  }

  const nextIndex = findBlockScalarEnd(lines, index + 1, parentIndent);
  return {
    section: { line: index + 1, text: lines.slice(index + 1, nextIndex).join("\n") },
    nextIndex
  };
}

function collectRunScriptsFromFlowSteps(value, line, sections, fallbackText = value) {
  const items = parseFlowSequence(value);
  if (!items) {
    return false;
  }

  for (const item of items) {
    if (isYamlAlias(item)) {
      sections.push({ line, text: fallbackText });
      continue;
    }

    const flowStep = parseFlowMap(item);
    if (flowStep && Object.prototype.hasOwnProperty.call(flowStep, "run")) {
      sections.push({ line, text: isYamlAlias(flowStep.run) ? value : yamlScalarValue(flowStep.run) });
    }
  }
  return true;
}

function collectRunScriptFromStepItem(lines, item, stepEnd, sections) {
  if (isYamlAlias(item.value)) {
    sections.push({ line: item.index + 1, text: blockText(lines, 0, lines.length) });
    return;
  }

  let propertyStart = item.index + 1;
  const inlineFlowStep = parseFlowMap(item.value);
  if (inlineFlowStep) {
    if (Object.prototype.hasOwnProperty.call(inlineFlowStep, "run")) {
      sections.push({ line: item.index + 1, text: yamlScalarValue(inlineFlowStep.run) });
    }
    return;
  }

  const inlineEntry = parseYamlKeyText(item.value);
  if (inlineEntry) {
    const inlineEntryIndent = item.indent + 2;
    if (inlineEntry.key === "run") {
      const explicitValue =
        inlineEntry.explicit && inlineEntry.explicitValueMissing
          ? explicitMappingValue(lines, item.index + 1, stepEnd, item.indent)
          : null;
      const result = collectRunScript(
        lines,
        explicitValue ? explicitValue.index : item.index,
        explicitValue ? explicitValue.indent : inlineEntryIndent,
        explicitValue ? explicitValue.value : inlineEntry.value
      );
      sections.push(result.section);
      return;
    }

    if (isYamlBlockScalar(inlineEntry.value)) {
      propertyStart = findBlockScalarEnd(lines, item.index + 1, inlineEntryIndent);
    }
  }

  for (const entry of directMappingEntries(lines, propertyStart, stepEnd, item.indent)) {
    if (entry.key !== "run") {
      continue;
    }

    const result = collectRunScript(lines, entry.valueIndex ?? entry.index, entry.valueIndent ?? entry.indent, entry.value);
    sections.push(result.section);
  }
}

function collectRunScriptsFromStepsBlock(lines, startIndex, endIndex, stepsIndent, sections) {
  const stepItems = directSequenceItems(lines, startIndex, endIndex, stepsIndent);
  for (const [index, item] of stepItems.entries()) {
    const next = stepItems[index + 1];
    collectRunScriptFromStepItem(lines, item, next ? next.index : endIndex, sections);
  }
}

function runScriptSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  const jobsEntry = findTopLevelMappingEntry(lines, "jobs");
  if (!jobsEntry) {
    return sections;
  }
  if (jobsEntry.value) {
    const valueIndex = jobsEntry.valueIndex ?? jobsEntry.index;
    const valueIndent = jobsEntry.valueIndent ?? jobsEntry.indent;
    const jobsEnd = findMappingBlockEnd(lines, valueIndex + 1, valueIndent);
    const value = isFlowMapLike(jobsEntry.value) ? collectFlowNodeText(lines, valueIndex, jobsEnd, jobsEntry.value) : jobsEntry.value;
    return [{ line: valueIndex + 1, text: value }];
  }

  const jobsBlock = mappingValueBlock(lines, jobsEntry);
  const jobsEnd = jobsBlock.end;
  const jobEntries = directMappingEntries(lines, jobsBlock.start, jobsEnd, jobsBlock.indent);
  if (jobEntries.length === 0) {
    const child = directChildValue(lines, jobsBlock.start, jobsEnd, jobsBlock.indent);
    return child ? [{ line: child.index + 1, text: blockText(lines, child.index, jobsEnd) }] : sections;
  }
  if (jobEntries.length === 1 && isFlowMapLike(jobEntries[0].value)) {
    return [{ line: jobEntries[0].index + 1, text: blockText(lines, jobEntries[0].index, jobsEnd) }];
  }

  for (const job of jobEntries) {
    const jobEnd = findMappingBlockEnd(lines, job.index + 1, job.indent);
    const jobChild = directChildValue(lines, job.index + 1, jobEnd, job.indent);
    if (isFlowMapLike(job.value) || (jobChild && isFlowMapLike(jobChild.value))) {
      sections.push({ line: job.index + 1, text: blockText(lines, job.index, jobEnd) });
      continue;
    }

    for (const entry of directMappingEntries(lines, job.index + 1, jobEnd, job.indent)) {
      if (entry.key !== "steps") {
        continue;
      }

      const stepsEnd = findMappingBlockEnd(lines, entry.index + 1, entry.indent);
      if (isYamlAlias(entry.value)) {
        sections.push({ line: entry.index + 1, text });
        continue;
      }

      const entryValue = isFlowSequenceLike(entry.value) ? collectFlowNodeText(lines, entry.index, stepsEnd, entry.value) : entry.value;
      if (collectRunScriptsFromFlowSteps(entryValue, entry.index + 1, sections, text)) {
        continue;
      }

      const child = directChildValue(lines, entry.index + 1, stepsEnd, entry.indent);
      if (child && isYamlAlias(child.value)) {
        sections.push({ line: child.index + 1, text });
        continue;
      }

      const childText = child ? blockText(lines, child.index, stepsEnd) : "";
      if (child && collectRunScriptsFromFlowSteps(childText, child.index + 1, sections, text)) {
        continue;
      }
      if (child && isFlowSequenceLike(child.value)) {
        sections.push({ line: child.index + 1, text: childText });
        continue;
      }

      collectRunScriptsFromStepsBlock(lines, entry.index + 1, Math.min(stepsEnd, jobEnd), entry.indent, sections);
    }
  }

  return sections;
}

function nestedScalarMap(lines, entry, endIndex) {
  if (entry.value) {
    const flowMap = parseFlowMap(entry.value);
    return flowMap ? normalizeYamlScalarMapValues(flowMap) : {};
  }

  const block = mappingValueBlock(lines, entry);
  const nestedEnd = Math.min(block.end, endIndex);
  const values = {};
  for (const child of directMappingEntries(lines, block.start, nestedEnd, block.indent)) {
    values[child.key] = yamlScalarValue(child.value);
  }
  return values;
}

function workflowStepProperty(lines, entry, stepEnd) {
  if (entry.key === "run") {
    const result = collectRunScript(
      lines,
      entry.valueIndex ?? entry.index,
      entry.valueIndent ?? entry.indent,
      entry.value
    );
    return result.section.text;
  }
  if (entry.key === "with" || entry.key === "env") {
    return nestedScalarMap(lines, entry, stepEnd);
  }
  return entry.value ? yamlScalarValue(entry.value) : nestedScalarMap(lines, entry, stepEnd);
}

function workflowStepMap(lines, item, stepEnd) {
  const step = { line: item.index + 1 };
  const inlineFlowStep = parseFlowMap(item.value);
  if (inlineFlowStep) {
    return { ...step, ...normalizeYamlScalarMapValues(inlineFlowStep) };
  }

  const inlineEntry = parseYamlKeyText(item.value);
  if (inlineEntry) {
    step[inlineEntry.key] = yamlScalarValue(inlineEntry.value);
  }

  for (const entry of directMappingEntries(lines, item.index + 1, stepEnd, item.indent)) {
    step[entry.key] = workflowStepProperty(lines, entry, stepEnd);
  }
  return step;
}

function workflowJobStepMaps(text, jobName) {
  const lines = text.split(/\r?\n/);
  const jobsEntry = findTopLevelMappingEntry(lines, "jobs");
  assert.ok(jobsEntry, "workflow must define a top-level jobs block");

  const jobsBlock = mappingValueBlock(lines, jobsEntry);
  const jobEntries = directMappingEntries(lines, jobsBlock.start, jobsBlock.end, jobsBlock.indent);
  const jobIndex = jobEntries.findIndex((entry) => entry.key === jobName);
  assert.notEqual(jobIndex, -1, `workflow must define job ${jobName}`);

  const job = jobEntries[jobIndex];
  const jobEnd = jobEntries[jobIndex + 1] ? jobEntries[jobIndex + 1].index : jobsBlock.end;
  const stepsEntry = directMappingEntries(lines, job.index + 1, jobEnd, job.indent).find((entry) => entry.key === "steps");
  assert.ok(stepsEntry, `job ${jobName} must define steps`);

  const stepsEnd = Math.min(findMappingBlockEnd(lines, stepsEntry.index + 1, stepsEntry.indent), jobEnd);
  const stepItems = directSequenceItems(lines, stepsEntry.index + 1, stepsEnd, stepsEntry.indent);
  return stepItems.map((item, index) => workflowStepMap(lines, item, stepItems[index + 1]?.index || stepsEnd));
}

function workflowJobPropertyNames(text, jobName) {
  const lines = text.split(/\r?\n/);
  const jobsEntry = findTopLevelMappingEntry(lines, "jobs");
  assert.ok(jobsEntry, "workflow must define a top-level jobs block");
  const jobsBlock = mappingValueBlock(lines, jobsEntry);
  const jobEntries = directMappingEntries(lines, jobsBlock.start, jobsBlock.end, jobsBlock.indent);
  const jobIndex = jobEntries.findIndex((entry) => entry.key === jobName);
  assert.notEqual(jobIndex, -1, `workflow must define job ${jobName}`);
  const job = jobEntries[jobIndex];
  const jobEnd = jobEntries[jobIndex + 1] ? jobEntries[jobIndex + 1].index : jobsBlock.end;
  return directMappingEntries(lines, job.index + 1, jobEnd, job.indent).map((entry) => entry.key);
}

function isGithubReleasePlugin(plugin) {
  return plugin === "@semantic-release/github" || (Array.isArray(plugin) && plugin[0] === "@semantic-release/github");
}

test("all checked GitHub workflows expose expected parsable jobs", () => {
  assert.deepEqual(listWorkflows().sort(), [...expectedWorkflowJobs.keys()].sort());

  for (const [workflow, expectedJobs] of expectedWorkflowJobs) {
    assert.deepEqual(
      jobSections(readWorkflow(workflow)).map((job) => job.name),
      expectedJobs,
      `${workflow} must keep expected job structure visible to repository policy tests`
    );
  }
});

function runScriptSignature(section) {
  return section.text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join("\n");
}

test("workflow run script scanner covers every expected workflow run step", () => {
  assert.deepEqual(listWorkflows().sort(), [...expectedWorkflowRunScriptSignatures.keys()].sort());

  for (const [workflow, expectedSignatures] of expectedWorkflowRunScriptSignatures) {
    assert.deepEqual(
      runScriptSections(readWorkflow(workflow)).map(runScriptSignature),
      expectedSignatures,
      `${workflow} run-script policy coverage must stay aligned with checked workflow run steps`
    );
  }
});

function normalizedRunLines(run) {
  return run
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
}

function assertLocalCIWorkflow(workflow) {
  assert.deepEqual(workflowJobPropertyNames(workflow, "validate"), ["name", "runs-on", "steps"]);
  const steps = workflowJobStepMaps(workflow, "validate");
  const checkoutReference = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
  const primaryCheckout = steps.find((step) => step.name === "Checkout");
  assert.ok(primaryCheckout, "CI must check out its own source");
  assert.equal(primaryCheckout.uses, checkoutReference);
  assert.deepEqual(primaryCheckout.with, { "persist-credentials": "false" });
  const enrollmentStep = steps.find((step) => step.name === "Run enrollment policy tests");
  assert.ok(enrollmentStep, "CI must run analyzer tests");
  assert.deepEqual(Object.keys(enrollmentStep).sort(), ["line", "name", "run"]);
  assert.deepEqual(normalizedRunLines(enrollmentStep.run), ["go mod tidy -diff", "go test ./..."]);
  assert.doesNotMatch(workflow, /secrets\.|consumer-policy|policy commit/, "ordinary CI must remain local and secretless");
}

function assertPrivilegedConsumerPolicyWorkflow(workflow) {
  assert.match(
    workflow,
    /^name: Consumer cancellation policy audit\n\non:\n  workflow_run:\n    workflows: \[Build lock CI\]\n    types: \[completed\]\n\npermissions:\n  checks: write\n  contents: read\n  pull-requests: read\n\nconcurrency:\n  group: consumer-policy-\$\{\{ github\.event\.workflow_run\.head_repository\.id \}\}-\$\{\{ github\.event\.workflow_run\.head_branch \}\}\n  cancel-in-progress: true\n\njobs:\n  audit:\n    name: Consumer cancellation policy audit\n    if: >-\n      github\.event\.workflow_run\.path == '\.github\/workflows\/ci\.yml' &&\n      \(github\.event\.workflow_run\.event == 'pull_request' \|\|\n      \(github\.event\.workflow_run\.event == 'push' && github\.event\.workflow_run\.head_branch == 'main'\)\)\n    runs-on: ubuntu-latest\n    timeout-minutes: 60\n    steps:/,
    "privileged workflow triggers and permissions must retain their exact trusted shape"
  );
  assert.deepEqual(workflowJobPropertyNames(workflow, "audit"), ["name", "if", "runs-on", "timeout-minutes", "steps"]);
  const steps = workflowJobStepMaps(workflow, "audit");
  assert.deepEqual(
    steps.map((step) => step.name),
    [
      "Record exact source candidate identity",
      "Checkout trusted policy code",
      "Setup Go from trusted dependency metadata",
      "Resolve current candidate association",
      "Checkout candidate manifest object",
      "Validate candidate manifest from exact Git object",
      "Mint repository-scoped read token",
      "Verify manifest pins current consumer heads",
      "Checkout unity-helpers policy commit",
      "Checkout DxMessaging policy commit",
      "Checkout unity-builder policy commit",
      "Checkout DoxReloaded policy commit",
      "Checkout IshoBoy policy commit",
      "Checkout qora-redux policy commit",
      "Checkout DepartmentOfArrangements policy commit",
      "Audit exact consumer commits with trusted analyzer",
      "Revalidate current consumer heads",
      "Publish terminal candidate policy check"
    ],
    "privileged workflow must not admit unreviewed steps"
  );
  const candidateIdentity = steps.find((step) => step.name === "Record exact source candidate identity");
  assert.deepEqual(Object.keys(candidateIdentity).sort(), ["env", "id", "line", "name", "run", "shell"]);
  assert.equal(candidateIdentity.id, "candidate");
  assert.equal(candidateIdentity.shell, "bash");
  assert.deepEqual(candidateIdentity.env, {
    SOURCE_HEAD_REPOSITORY: "${{ github.event.workflow_run.head_repository.full_name }}",
    SOURCE_HEAD_REPOSITORY_ID: "${{ github.event.workflow_run.head_repository.id }}",
    SOURCE_HEAD_SHA: "${{ github.event.workflow_run.head_sha }}"
  });
  assert.deepEqual(normalizedRunLines(candidateIdentity.run), [
    "set -euo pipefail",
    'if ! [[ "${SOURCE_HEAD_REPOSITORY}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||',
    '! [[ "${SOURCE_HEAD_REPOSITORY_ID}" =~ ^[1-9][0-9]*$ ]] ||',
    '! [[ "${SOURCE_HEAD_SHA}" =~ ^[0-9a-f]{40}$ ]]; then',
    'echo "::error::The completed source run has an invalid candidate identity."',
    "exit 1",
    "fi",
    "{",
    'echo "candidate-identifiable=true"',
    'echo "repository=${SOURCE_HEAD_REPOSITORY}"',
    'echo "sha=${SOURCE_HEAD_SHA}"',
    '} >> "${GITHUB_OUTPUT}"'
  ]);
  const checkoutReference = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
  const trusted = steps.find((step) => step.name === "Checkout trusted policy code");
  assert.deepEqual(Object.keys(trusted).sort(), ["if", "line", "name", "uses", "with"]);
  assert.equal(trusted.uses, checkoutReference);
  assert.equal(trusted.if, "${{ steps.candidate.outputs.candidate-identifiable == 'true' }}");
  assert.deepEqual(trusted.with, {
    ref: "${{ github.workflow_sha }}",
    path: "trusted",
    "persist-credentials": "false",
    lfs: "false",
    submodules: "false"
  });
  const setupGo = steps.find((step) => step.name === "Setup Go from trusted dependency metadata");
  assert.deepEqual(Object.keys(setupGo).sort(), ["if", "line", "name", "uses", "with"]);
  assert.equal(setupGo.if, "${{ steps.candidate.outputs.candidate-identifiable == 'true' }}");
  assert.equal(setupGo.uses, "actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16");
  assert.deepEqual(setupGo.with, {
    "go-version-file": "trusted/go.mod",
    cache: "false"
  });
  const association = steps.find((step) => step.name === "Resolve current candidate association");
  assert.deepEqual(Object.keys(association).sort(), ["env", "id", "if", "line", "name", "run", "working-directory"]);
  assert.equal(association.id, "association");
  assert.equal(association.if, "${{ steps.candidate.outputs.candidate-identifiable == 'true' }}");
  assert.equal(association["working-directory"], "trusted");
  assert.deepEqual(association.env, {
    GH_TOKEN: "${{ github.token }}",
    SOURCE_EVENT: "${{ github.event.workflow_run.event }}",
    SOURCE_HEAD_BRANCH: "${{ github.event.workflow_run.head_branch }}",
    SOURCE_HEAD_REPOSITORY: "${{ github.event.workflow_run.head_repository.full_name }}",
    SOURCE_HEAD_REPOSITORY_ID: "${{ github.event.workflow_run.head_repository.id }}",
    SOURCE_HEAD_SHA: "${{ github.event.workflow_run.head_sha }}",
    BASE_REPOSITORY_ID: "${{ github.repository_id }}"
  });
  assert.deepEqual(normalizedRunLines(association.run), [
    "go run ./cmd/resolve-consumer-policy-candidate",
    '--event "${SOURCE_EVENT}"',
    '--repository "${GITHUB_REPOSITORY}"',
    '--repository-id "${BASE_REPOSITORY_ID}"',
    '--head-repository "${SOURCE_HEAD_REPOSITORY}"',
    '--head-repository-id "${SOURCE_HEAD_REPOSITORY_ID}"',
    '--head-sha "${SOURCE_HEAD_SHA}"',
    '--head-branch "${SOURCE_HEAD_BRANCH}"',
    '--github-output "${GITHUB_OUTPUT}"'
  ]);
  const candidate = steps.find((step) => step.name === "Checkout candidate manifest object");
  assert.deepEqual(Object.keys(candidate).sort(), ["if", "line", "name", "uses", "with"]);
  assert.equal(candidate.uses, checkoutReference);
  assert.equal(candidate.if, "${{ steps.association.outputs.should-audit == 'true' }}");
  assert.deepEqual(candidate.with, {
    "allow-unsafe-pr-checkout": "true",
    repository: "${{ steps.candidate.outputs.repository }}",
    ref: "${{ steps.candidate.outputs.sha }}",
    path: "candidate",
    token: "${{ github.token }}",
    "persist-credentials": "false",
    lfs: "false",
    submodules: "false",
    "sparse-checkout": "consumer-policy.json",
    "sparse-checkout-cone-mode": "false"
  });
  const parser = steps.find((step) => step.name === "Validate candidate manifest from exact Git object");
  assert.deepEqual(Object.keys(parser).sort(), ["env", "id", "if", "line", "name", "run", "working-directory"]);
  assert.equal(parser.if, "${{ steps.association.outputs.should-audit == 'true' }}");
  assert.equal(parser["working-directory"], "trusted");
  assert.deepEqual(normalizedRunLines(parser.run), [
    "go run ./cmd/validate-consumer-policy-manifest",
    '--git-dir "${CANDIDATE_GIT_DIR}"',
    '--sha "${CANDIDATE_SHA}"',
    '--github-output "${GITHUB_OUTPUT}"'
  ]);
  assert.deepEqual(parser.env, {
    CANDIDATE_GIT_DIR: "../candidate/.git",
    CANDIDATE_SHA: "${{ steps.candidate.outputs.sha }}"
  });

  const token = steps.find((step) => step.name === "Mint repository-scoped read token");
  assert.deepEqual(Object.keys(token).sort(), ["id", "if", "line", "name", "uses", "with"]);
  assert.equal(token.id, "consumer-token");
  assert.equal(token.if, "${{ steps.association.outputs.should-audit == 'true' && steps.manifest.outcome == 'success' }}");
  assert.equal(token.uses, "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1");
  assert.deepEqual(token.with, {
    "app-id": "${{ secrets.BUILD_LOCK_POLICY_READER_APP_ID }}",
    "private-key": "${{ secrets.BUILD_LOCK_POLICY_READER_APP_PRIVATE_KEY }}",
    owner: "Ambiguous-Interactive",
    repositories: "unity-helpers,DxMessaging,DoxReloaded,IshoBoy,qora-redux,DepartmentOfArrangements,unity-builder",
    "permission-contents": "read"
  });

  const expectedHeadEnvironment = {
    GH_TOKEN: "${{ steps.consumer-token.outputs.token }}",
    UNITY_HELPERS_SHA: "${{ steps.manifest.outputs.unity_helpers_sha }}",
    DX_MESSAGING_SHA: "${{ steps.manifest.outputs.dx_messaging_sha }}",
    DOX_RELOADED_SHA: "${{ steps.manifest.outputs.dox_reloaded_sha }}",
    ISHO_BOY_SHA: "${{ steps.manifest.outputs.isho_boy_sha }}",
    QORA_REDUX_SHA: "${{ steps.manifest.outputs.qora_redux_sha }}",
    DEPARTMENT_OF_ARRANGEMENTS_SHA: "${{ steps.manifest.outputs.department_of_arrangements_sha }}",
    UNITY_BUILDER_SHA: "${{ steps.manifest.outputs.unity_builder_sha }}"
  };
  const expectedHeadCalls = [
    'verify_head Ambiguous-Interactive/unity-helpers "${UNITY_HELPERS_SHA}"',
    'verify_head Ambiguous-Interactive/DxMessaging "${DX_MESSAGING_SHA}"',
    'verify_head Ambiguous-Interactive/DoxReloaded "${DOX_RELOADED_SHA}"',
    'verify_head Ambiguous-Interactive/IshoBoy "${ISHO_BOY_SHA}"',
    'verify_head Ambiguous-Interactive/qora-redux "${QORA_REDUX_SHA}"',
    'verify_head Ambiguous-Interactive/DepartmentOfArrangements "${DEPARTMENT_OF_ARRANGEMENTS_SHA}"',
    'verify_head Ambiguous-Interactive/unity-builder "${UNITY_BUILDER_SHA}"'
  ];
  const assertHeadVerification = (step, id, condition, diagnostic) => {
    assert.deepEqual(Object.keys(step).sort(), ["env", "id", "if", "line", "name", "run", "shell"]);
    assert.equal(step.id, id);
    assert.equal(step.if, condition);
    assert.equal(step.shell, "bash");
    assert.deepEqual(step.env, expectedHeadEnvironment);
    assert.deepEqual(normalizedRunLines(step.run), [
      "set -euo pipefail",
      "verify_head() {",
      'local repository="$1"',
      'local expected_sha="$2"',
      "local default_branch",
      "local current_sha",
      'default_branch="$(gh api "repos/${repository}" --jq .default_branch)"',
      'current_sha="$(gh api "repos/${repository}/commits/${default_branch}" --jq .sha)"',
      'if [ "${current_sha}" != "${expected_sha}" ]; then',
      `echo "::error::\${repository} ${diagnostic}"`,
      "return 1",
      "fi",
      "}",
      ...expectedHeadCalls
    ]);
  };
  assertHeadVerification(
    steps.find((step) => step.name === "Verify manifest pins current consumer heads"),
    "initial-heads",
    "${{ steps.consumer-token.outcome == 'success' }}",
    "policy pin is not its current default-branch head."
  );
  assertHeadVerification(
    steps.find((step) => step.name === "Revalidate current consumer heads"),
    "final-heads",
    "${{ steps.audit.outcome == 'success' }}",
    "advanced during the policy audit."
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "consumer-policy.json"), "utf8"));
  assert.deepEqual(
    Object.entries(manifest).sort(([left], [right]) => left.localeCompare(right)),
    expectedConsumerPolicySnapshots.map(([repository, , sha]) => [repository, sha]).sort(([left], [right]) => left.localeCompare(right)),
    "candidate manifest must exactly match the reviewed consumer inventory"
  );

  const consumerCheckouts = steps.filter((step) => String(step.name || "").endsWith(" policy commit"));
  assert.equal(consumerCheckouts.length, expectedConsumerPolicySnapshots.length);
  const outputByRepository = new Map([
    ["Ambiguous-Interactive/unity-helpers", "unity_helpers_sha"],
    ["Ambiguous-Interactive/DxMessaging", "dx_messaging_sha"],
    ["Ambiguous-Interactive/DoxReloaded", "dox_reloaded_sha"],
    ["Ambiguous-Interactive/IshoBoy", "isho_boy_sha"],
    ["Ambiguous-Interactive/qora-redux", "qora_redux_sha"],
    ["Ambiguous-Interactive/DepartmentOfArrangements", "department_of_arrangements_sha"],
    ["Ambiguous-Interactive/unity-builder", "unity_builder_sha"]
  ]);
  for (const [repository, directory] of expectedConsumerPolicySnapshots) {
    const step = consumerCheckouts.find((candidateStep) => candidateStep.with.repository === repository);
    assert.ok(step, `missing checkout for ${repository}`);
    assert.deepEqual(Object.keys(step).sort(), ["if", "line", "name", "uses", "with"]);
    assert.equal(step.if, "${{ steps.initial-heads.outcome == 'success' }}");
    assert.equal(step.uses, checkoutReference);
    const expectedWith = {
      repository,
      ref: `\${{ steps.manifest.outputs.${outputByRepository.get(repository)} }}`,
      path: directory,
      token: "${{ steps.consumer-token.outputs.token }}",
      "persist-credentials": "false",
      lfs: "false",
      submodules: "false"
    };
    assert.deepEqual(step.with, expectedWith, `${repository} checkout must retain exact immutable least-privilege inputs`);
  }
  for (const step of steps.filter((candidateStep) => candidateStep.run)) {
    assert.notEqual(step["working-directory"], "candidate", "candidate code must never execute");
    assert.equal(String(step["working-directory"] || "trusted").includes("consumers/"), false, "consumer code must never execute");
  }
  const audit = steps.find((step) => step.name === "Audit exact consumer commits with trusted analyzer");
  assert.deepEqual(Object.keys(audit).sort(), ["id", "if", "line", "name", "run", "shell", "working-directory"]);
  assert.equal(audit.id, "audit");
  assert.equal(audit.if, "${{ steps.initial-heads.outcome == 'success' }}");
  assert.equal(audit.shell, "bash");
  assert.equal(audit["working-directory"], "trusted");
  assert.deepEqual(normalizedRunLines(audit.run), [
    "set -euo pipefail",
    ...expectedConsumerPolicySnapshots.map(([repository, directory]) => {
      const output = outputByRepository.get(repository);
      return `go run ./cmd/audit-cancellation-policy --git-dir ../${directory} --repository ${repository} --sha "\${{ steps.manifest.outputs.${output} }}" --required-guard-sha ${expectedCurrentHeadGuardSHA}`;
    })
  ]);

  const publish = steps.find((step) => step.name === "Publish terminal candidate policy check");
  assert.deepEqual(Object.keys(publish).sort(), ["env", "if", "line", "name", "run", "shell"]);
  assert.equal(publish.if, "${{ always() && steps.candidate.outputs.candidate-identifiable == 'true' }}");
  assert.equal(publish.shell, "bash");
  assert.deepEqual(publish.env, {
    GH_TOKEN: "${{ github.token }}",
    SOURCE_EVENT: "${{ github.event.workflow_run.event }}",
    CANDIDATE_SHA: "${{ steps.candidate.outputs.sha }}",
    PR_NUMBER: "${{ steps.association.outputs.pr-number }}",
    AUDIT_OUTCOME: "${{ steps.audit.outcome }}",
    HEADS_OUTCOME: "${{ steps.final-heads.outcome }}",
    SHOULD_AUDIT: "${{ steps.association.outputs.should-audit }}",
    SOURCE_HEAD_REPOSITORY_ID: "${{ github.event.workflow_run.head_repository.id }}",
    BASE_REPOSITORY_ID: "${{ github.repository_id }}",
    CHECK_NAME: "Consumer cancellation policy audit"
  });
  assert.deepEqual(normalizedRunLines(publish.run), [
    "set -euo pipefail",
    "live_identity_ok=false",
    'if [ "${SOURCE_EVENT}" = "pull_request" ] && [ -n "${PR_NUMBER}" ]; then',
    'if pr_json="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}")" &&',
    '[ "$(jq -r \'.state\' <<<"${pr_json}")" = "open" ] &&',
    '[ "$(jq -r \'.base.ref\' <<<"${pr_json}")" = "main" ] &&',
    '[ "$(jq -r \'.base.repo.id\' <<<"${pr_json}")" = "${BASE_REPOSITORY_ID}" ] &&',
    '[ "$(jq -r \'.head.repo.id\' <<<"${pr_json}")" = "${SOURCE_HEAD_REPOSITORY_ID}" ] &&',
    '[ "$(jq -r \'.head.sha\' <<<"${pr_json}")" = "${CANDIDATE_SHA}" ]; then',
    "live_identity_ok=true",
    "else",
    'echo "::error::Pull request identity changed during the policy audit."',
    "fi",
    'elif [ "${SOURCE_EVENT}" = "push" ]; then',
    "live_identity_ok=true",
    "fi",
    "conclusion=failure",
    'if [ "${SHOULD_AUDIT}" = "true" ] && [ "${AUDIT_OUTCOME}" = "success" ] &&',
    '[ "${HEADS_OUTCOME}" = "success" ] && [ "${live_identity_ok}" = "true" ]; then',
    "conclusion=success",
    "fi",
    'gh api --method POST "repos/${GITHUB_REPOSITORY}/check-runs" \\',
    '-H "Accept: application/vnd.github+json" \\',
    '-f name="${CHECK_NAME}" \\',
    '-f head_sha="${CANDIDATE_SHA}" \\',
    "-f status=completed \\",
    '-f conclusion="${conclusion}" \\',
    '-f completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \\',
    '-f details_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \\',
    '-f external_id="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"'
  ]);
}

test("ordinary CI stays local while the trusted workflow audits the complete consumer inventory", () => {
  assertLocalCIWorkflow(readWorkflow("ci.yml"));
  assertPrivilegedConsumerPolicyWorkflow(readWorkflow("consumer-policy-audit.yml"));
});

test("consumer policy jobs reject fail-open job controls", () => {
  for (const property of ["continue-on-error: true", "if: false"]) {
    const mutated = readWorkflow("consumer-policy-audit.yml").replace(
      "    runs-on: ubuntu-latest",
      `    ${property}\n    runs-on: ubuntu-latest`
    );
    assert.throws(
      () => assertPrivilegedConsumerPolicyWorkflow(mutated),
      undefined,
      `audit job must reject ${property}`
    );
  }
});

test("privileged consumer audit rejects trust-boundary mutations", () => {
  const workflow = readWorkflow("consumer-policy-audit.yml");
  const mutations = [
    ["workflow_run:", "pull_request_target:"],
    ["workflow_run.path == '.github/workflows/ci.yml'", "workflow_run.path != '.github/workflows/ci.yml'"],
    ['--repository-id "${BASE_REPOSITORY_ID}"', '--repository-id "${SOURCE_HEAD_REPOSITORY_ID}"'],
    ["ref: ${{ github.workflow_sha }}", "ref: ${{ github.sha }}"],
    ["cache: false", "cache: true"],
    ["CANDIDATE_SHA: ${{ steps.candidate.outputs.sha }}", "CANDIDATE_SHA: ${{ github.sha }}"],
    ["BUILD_LOCK_POLICY_READER_APP_ID", "BUILD_LOCK_READER_APP_ID"],
    ["CHECK_NAME: Consumer cancellation policy audit", "CHECK_NAME: Build lock audit"],
    ['-f head_sha="${CANDIDATE_SHA}"', '-f head_sha="${GITHUB_SHA}"'],
    ["-f status=completed", "-f status=in_progress"],
    ['-f conclusion="${conclusion}"', "-f conclusion=neutral"],
    ["actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16", "attacker/setup-go@0123456789abcdef0123456789abcdef01234567"],
    [
      "uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7\n        with:\n          repository: Ambiguous-Interactive/unity-helpers",
      "uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7\n        env:\n          NODE_OPTIONS: --require candidate/payload.js\n        with:\n          repository: Ambiguous-Interactive/unity-helpers"
    ]
  ];

  for (const [search, replacement] of mutations) {
    assert.ok(workflow.includes(search), `mutation fixture must contain ${search}`);
    assert.throws(
      () => assertPrivilegedConsumerPolicyWorkflow(workflow.replace(search, replacement)),
      undefined,
      `privileged contract must reject ${replacement}`
    );
  }
});

test("CI actionlint step uses a Dependabot-upgradable Go module pin", () => {
  const text = readWorkflow("ci.yml");
  const goMod = fs.readFileSync(path.join(repoRoot, "go.mod"), "utf8");
  const dependabot = fs.readFileSync(path.join(repoRoot, ".github", "dependabot.yml"), "utf8");
  const steps = workflowJobStepMaps(text, "validate");
  const lintStep = steps.find((step) => step.name === "Lint GitHub Actions workflows");
  const setupGoStep = steps.find((step) => /^actions\/setup-go@[a-f0-9]{40}$/.test(step.uses || ""));
  const lintScript = runScriptSections(text).find((section) => section.text.includes(`go run -mod=readonly ${expectedActionlintCommand}`));
  const actionlintRequire = new RegExp(
    `^[ \\t]*(?:require[ \\t]+)?${escapeRegExp(expectedActionlintModule)} (v\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\\s+// indirect)?$`,
    "m"
  ).exec(goMod);

  assert.ok(lintStep, "CI must keep a named actionlint workflow lint step");
  assert.equal(lintStep.uses, undefined, "CI actionlint must not use a Docker-based action");
  assert.equal(lintStep.shell, "bash", "CI actionlint must run under bash for strict shell options");
  assert.ok(setupGoStep, "CI must install Go explicitly before running module-pinned actionlint");
  assert.deepEqual(setupGoStep.with, { "go-version-file": "go.mod", cache: "true" });
  assert.ok(lintScript, "CI actionlint run script must stay visible to policy scanning");

  assert.doesNotMatch(text, /docker:\/\/rhysd\/actionlint/i, "CI actionlint must not depend on Docker pulls");
  assert.doesNotMatch(text, /https:\/\/github\.com\/rhysd\/actionlint\/releases\/download/i, "CI actionlint must not pin an opaque release URL");
  assert.doesNotMatch(text, /actionlint_\$\{version\}_checksums\.txt/, "CI actionlint must not require manual checksum updates");
  assert.doesNotMatch(text, new RegExp(`${escapeRegExp(expectedActionlintCommand)}@`), "CI must take actionlint's version from go.mod");
  assert.match(lintScript.text, /set -euo pipefail/, "CI actionlint must fail on unset variables and pipeline errors");
  assert.match(lintScript.text, new RegExp(`^\\s*go run -mod=readonly ${escapeRegExp(expectedActionlintCommand)} -color\\s*$`, "m"));
  assert.ok(actionlintRequire, "go.mod must pin actionlint with a semantic module version");
  assert.match(goMod, new RegExp(`^tool ${escapeRegExp(expectedActionlintCommand)}$`, "m"), "go.mod must keep the actionlint command dependency live as a Go tool");
  assert.match(dependabot, /package-ecosystem:\s*"gomod"/, "Dependabot must watch the Go module that pins actionlint");
  assert.match(dependabot, /directory:\s*"\/"/, "Dependabot gomod updates must target the root go.mod");
  assert.match(dependabot, new RegExp(`allow:[\\s\\S]*dependency-name: "${escapeRegExp(expectedActionlintModule)}"`), "Dependabot gomod updates must focus on the actionlint tool pin");
  assert.match(dependabot, new RegExp(`groups:[\\s\\S]*- "${escapeRegExp(expectedActionlintModule)}"`), "Dependabot grouping must include actionlint");
});

test("workflow step parser handles compact with and env maps", () => {
  const workflow = `
jobs:
  reap:
    steps:
      - uses: ./.github/actions/reap-stale-locks
        with: { lock-name: wallstop-organization-builds }
        env: { BUILD_LOCK_TOKEN: "\${{ secrets.ORG_BUILD_LOCK_TOKEN }}" }
`;

  assert.deepEqual(workflowJobStepMaps(workflow, "reap"), [
    {
      line: 5,
      uses: "./.github/actions/reap-stale-locks",
      with: { "lock-name": "wallstop-organization-builds" },
      env: { BUILD_LOCK_TOKEN: "${{ secrets.ORG_BUILD_LOCK_TOKEN }}" }
    }
  ]);
});

function policySensitiveAliasLines(text) {
  const lines = text.split(/\r?\n/);
  const aliases = [];
  let pendingStepsIndent = null;
  let blockScalarParentIndent = null;

  function flowValueHasPolicyAlias(value) {
    if (isYamlAlias(value)) {
      return true;
    }

    const flowMapEntries = parseFlowMapEntries(value);
    if (flowMapEntries) {
      return flowMapEntries.some((entry) => isYamlAlias(entry.rawKey) || flowValueHasPolicyAlias(entry.value));
    }

    const flowItems = parseFlowSequence(value) || [];
    return flowItems.some((item) => flowValueHasPolicyAlias(item));
  }

  for (const [index, line] of lines.entries()) {
    const indent = lineIndent(line);
    if (blockScalarParentIndent !== null) {
      if (isBlankLine(line) || indent > blockScalarParentIndent) {
        continue;
      }
      blockScalarParentIndent = null;
    }

    const stripped = stripYamlComment(line);
    if (!stripped) {
      continue;
    }

    if (pendingStepsIndent !== null && indent > pendingStepsIndent && /^\s*\*[A-Za-z0-9_.-]+\s*$/.test(stripped)) {
      aliases.push(index + 1);
    }
    if (pendingStepsIndent !== null && indent <= pendingStepsIndent) {
      pendingStepsIndent = null;
    }

    const explicitValueLine = /^:[ \t]*/.test(stripped);
    const explicitLineValue = explicitValueLine
      ? explicitMappingValueAfterLine(lines, index, lines.length, indent)
      : null;
    if (explicitLineValue && isYamlBlockScalar(explicitLineValue.value)) {
      blockScalarParentIndent = explicitLineValue.indent;
      continue;
    }

    const parsedKey = parseYamlKeyLine(line);
    const explicitKeyValue =
      parsedKey && parsedKey.explicit && parsedKey.explicitValueMissing
        ? explicitMappingValue(lines, index + 1, lines.length, parsedKey.indent)
        : null;
    const key = parsedKey
      ? {
          ...parsedKey,
          value: explicitKeyValue ? explicitKeyValue.value : parsedKey.value,
          valueIndex: explicitKeyValue ? explicitKeyValue.index : index,
          valueIndent: explicitKeyValue ? explicitKeyValue.indent : parsedKey.indent
        }
      : null;
    if (key && isYamlAlias(key.rawKey)) {
      aliases.push(index + 1);
    }
    if (key && ["run", "steps", "uses"].includes(key.key) && isYamlAlias(key.value)) {
      aliases.push(index + 1);
    }
    if (key && flowValueHasPolicyAlias(key.value)) {
      aliases.push(index + 1);
    }
    if (key && isFlowLike(key.value)) {
      const flowText = collectFlowNodeText(lines, index, findMappingBlockEnd(lines, index + 1, key.indent), key.value);
      if (flowValueHasPolicyAlias(flowText)) {
        aliases.push(index + 1);
      }
    }

    const sequence = parseSequenceItem(line);
    if (sequence && isYamlAlias(sequence.value)) {
      aliases.push(index + 1);
    }

    const sequenceKey = sequence && parseYamlKeyText(sequence.value);
    if (sequenceKey && isYamlAlias(sequenceKey.rawKey)) {
      aliases.push(index + 1);
    }
    if (sequenceKey && isYamlAlias(sequenceKey.value)) {
      aliases.push(index + 1);
    }

    if (sequence && flowValueHasPolicyAlias(sequence.value)) {
      aliases.push(index + 1);
    }
    if (sequence && isFlowLike(sequence.value)) {
      const flowText = collectFlowNodeText(lines, index, findMappingBlockEnd(lines, index + 1, sequence.indent), sequence.value);
      if (flowValueHasPolicyAlias(flowText)) {
        aliases.push(index + 1);
      }
    }

    if (flowValueHasPolicyAlias(stripped)) {
      aliases.push(index + 1);
    }
    if (isFlowLike(stripped)) {
      const flowText = collectFlowNodeText(lines, index, findMappingBlockEnd(lines, index + 1, indent), stripped);
      if (flowValueHasPolicyAlias(flowText)) {
        aliases.push(index + 1);
      }
    }

    if (key && key.key === "steps" && !key.value) {
      pendingStepsIndent = key.indent;
    }
    if (key && isYamlBlockScalar(key.value)) {
      const keyValueIndent = key.valueIndent ?? key.indent;
      blockScalarParentIndent = keyValueIndent;
    } else if (sequenceKey && isYamlBlockScalar(sequenceKey.value)) {
      const explicitValue =
        sequenceKey.explicit && sequenceKey.explicitValueMissing
          ? explicitMappingValue(lines, sequence.index + 1, lines.length, sequence.indent)
          : null;
      blockScalarParentIndent = explicitValue ? explicitValue.indent : sequence.indent + 2;
    } else if (sequence && isYamlBlockScalar(sequence.value)) {
      blockScalarParentIndent = sequence.indent;
    }
  }

  return [...new Set(aliases)];
}

test("Dependabot Actions API polling retains actions read permission", () => {
  const workflow = readWorkflow("dependabot-auto-merge.yml");
  const job = jobSections(workflow).find((candidate) => candidate.name === "dependabot");
  assert.ok(job, "Dependabot workflow must keep its trusted polling job");
  assert.ok(hasEffectivePermission(workflow, job.text, "actions", "read"));
  assert.match(job.text, /gh api "repos\/\$\{REPOSITORY\}\/actions\/workflows\/\$\{CI_WORKFLOW_FILE\}"/);
  assert.match(job.text, /gh api -X GET "repos\/\$\{REPOSITORY\}\/actions\/runs"/);
});

test("permission parser handles flow maps and fails closed on narrowed job overrides", () => {
  const workflow = `
permissions:
  contents: write
  issues: write
  pull-requests: write
jobs: # workflow jobs
  "release": # publish
    permissions: { contents: write }
    steps:
      - uses: cycjimmy/semantic-release-action@v5
  complete:
    permissions: { contents: write, issues: write, pull-requests: write }
    steps:
      - uses: cycjimmy/semantic-release-action@v5
  unparsed:
    permissions: maybe
    steps:
      - uses: cycjimmy/semantic-release-action@v5
  commented:
    permissions: # valid block map with a trailing declaration comment
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: cycjimmy/semantic-release-action@v5
`;
  const jobs = Object.fromEntries(jobSections(workflow).map((job) => [job.name, job]));

  assert.equal(hasEffectivePermission(workflow, jobs.release.text, "contents", "write"), true);
  assert.equal(hasEffectivePermission(workflow, jobs.release.text, "issues", "write"), false);
  assert.equal(hasEffectivePermission(workflow, jobs.release.text, "pull-requests", "write"), false);
  assert.equal(hasEffectivePermission(workflow, jobs.complete.text, "contents", "write"), true);
  assert.equal(hasEffectivePermission(workflow, jobs.complete.text, "issues", "write"), true);
  assert.equal(hasEffectivePermission(workflow, jobs.complete.text, "pull-requests", "write"), true);
  assert.equal(hasEffectivePermission(workflow, jobs.unparsed.text, "contents", "write"), false);
  assert.equal(hasEffectivePermission(workflow, jobs.commented.text, "contents", "write"), true);
  assert.equal(hasEffectivePermission(workflow, jobs.commented.text, "issues", "write"), true);
  assert.equal(hasEffectivePermission(workflow, jobs.commented.text, "pull-requests", "write"), true);
});

test("permission parser normalizes quoted and decorated YAML scalars", () => {
  const workflow = `
permissions: !!str "read-all"
jobs:
  inherited:
    steps:
      - uses: cycjimmy/semantic-release-action@v5
  flow:
    permissions: { "contents": "write", issues: !!str 'write', pull-requests: &flow_pr write }
    steps:
      - uses: cycjimmy/semantic-release-action@v5
  block:
    permissions:
      !!str contents: "write" # valid decorated key and quoted scalar with a trailing comment
      "issues": !!str write

      # Blank lines and comments inside the map must not stop permission parsing.
      pull-requests: &block_pr 'write'
    steps:
      - uses: cycjimmy/semantic-release-action@v5
  decorated-block:
    permissions: &decorated_permissions
      contents: write
      issues: !!str "write"
      pull-requests: 'write'
    steps:
      - uses: cycjimmy/semantic-release-action@v5
  decorated-child-flow:
    permissions: !!map
      {
        contents: "write",
        issues: write,
        pull-requests: !!str write
      }
    steps:
      - uses: cycjimmy/semantic-release-action@v5
  invalid-flow:
    permissions: { contents: "write", issues: admin, pull-requests: write }
    steps:
      - uses: cycjimmy/semantic-release-action@v5
  invalid-block:
    permissions:
      contents: write
      issues: admin
      pull-requests: write
    steps:
      - uses: cycjimmy/semantic-release-action@v5
`;
  const jobs = Object.fromEntries(jobSections(workflow).map((job) => [job.name, job]));

  assert.equal(hasEffectivePermission(workflow, jobs.inherited.text, "contents", "read"), true);
  assert.equal(hasEffectivePermission(workflow, jobs.inherited.text, "contents", "write"), false);

  for (const jobName of ["flow", "block", "decorated-block", "decorated-child-flow"]) {
    assert.equal(hasEffectivePermission(workflow, jobs[jobName].text, "contents", "write"), true, `${jobName} contents`);
    assert.equal(hasEffectivePermission(workflow, jobs[jobName].text, "issues", "write"), true, `${jobName} issues`);
    assert.equal(
      hasEffectivePermission(workflow, jobs[jobName].text, "pull-requests", "write"),
      true,
      `${jobName} pull requests`
    );
  }

  for (const jobName of ["invalid-flow", "invalid-block"]) {
    assert.equal(hasEffectivePermission(workflow, jobs[jobName].text, "contents", "write"), false, `${jobName} contents`);
    assert.equal(hasEffectivePermission(workflow, jobs[jobName].text, "issues", "write"), false, `${jobName} issues`);
    assert.equal(
      hasEffectivePermission(workflow, jobs[jobName].text, "pull-requests", "write"),
      false,
      `${jobName} pull requests`
    );
  }
});

test("workflow run scripts pass secrets through env instead of expression interpolation", () => {
  const tokenExpression = /\$\{\{\s*(?:secrets\.[A-Za-z0-9_]+|github\.token)\s*\}\}/i;

  for (const workflow of listWorkflows()) {
    const text = readWorkflow(workflow);
    for (const section of runScriptSections(text)) {
      assert.doesNotMatch(
        section.text,
        tokenExpression,
        `${workflow}:${section.line} must not interpolate GitHub token contexts directly into a run script; pass them through env instead`
      );
    }
  }
});

test("workflow policy rejects YAML aliases in workflow values", () => {
  const aliased = `
dangerous_run: &dangerous_run echo \${{ secrets.FOO }}
dangerous_steps: &dangerous_steps
  - uses: cycjimmy/semantic-release-action@v5
dangerous_step: &dangerous_step
  run: echo \${{ github.token }}
dangerous_env: &dangerous_env
  TOKEN: \${{ secrets.FOO }}
dangerous_permission: &dangerous_permission write
dangerous_key: &dangerous_key run
jobs:
  run-alias:
    steps:
      - run: *dangerous_run
      - { run: *dangerous_run }
      - uses: *dangerous_action
      - "run": *dangerous_run
      - "uses": *dangerous_action
      - { "run": *dangerous_run, "uses": *dangerous_action }
  steps-alias:
    steps: *dangerous_steps
  quoted-steps-alias:
    "steps": *dangerous_steps
  flow-steps-alias:
    steps: [{ "run": *dangerous_run }, { "uses": *dangerous_action }]
  flow-whole-step-alias:
    steps: [*dangerous_step]
  multiline-flow-steps-alias:
    steps: [
      { "run": *dangerous_run },
      { "uses": *dangerous_action }
    ]
  nested-flow-job-alias:
    jobs: { release: { runs-on: ubuntu-latest, steps: [{ run: *dangerous_run }, { uses: *dangerous_action }] } }
  block-whole-step-alias:
    steps:
      - *dangerous_step
  steps-child-alias:
    steps:
      *dangerous_steps
  env-alias:
    env: *dangerous_env
    steps:
      - run: echo safe
  permission-flow-alias:
    permissions: { contents: *dangerous_permission }
    steps:
      - run: echo safe
  block-alias-key:
    *dangerous_key: echo \${{ secrets.FOO }}
    steps:
      - run: echo safe
  sequence-inline-alias-key:
    steps:
      - *dangerous_key: echo \${{ secrets.FOO }}
  sequence-inline-value-alias:
    steps:
      - env: *dangerous_env
        run: echo safe
  flow-alias-key:
    steps: [{ *dangerous_key: echo \${{ secrets.FOO }} }]
  explicit-block-alias-key:
    ? *dangerous_key
    : echo \${{ secrets.FOO }}
    steps:
      - run: echo safe
  explicit-block-alias-value:
    ? run
    : *dangerous_run
    steps:
      - run: echo safe
  explicit-flow-alias-key:
    steps: [{ ? *dangerous_key : echo \${{ secrets.FOO }} }]
  explicit-flow-alias-value:
    steps: [{ ? run : *dangerous_run }]
`;

  assert.deepEqual(
    policySensitiveAliasLines(aliased),
    [14, 15, 16, 17, 18, 19, 21, 23, 25, 27, 29, 31, 34, 37, 40, 42, 46, 50, 55, 58, 61, 63, 68, 69, 73, 75]
  );

  for (const workflow of listWorkflows()) {
    const aliases = policySensitiveAliasLines(readWorkflow(workflow));
    assert.deepEqual(aliases, [], `${workflow} must not use YAML aliases in workflow YAML`);
  }
});

test("workflow policy allows quoted alias-looking scalars", () => {
  const workflow = `
jobs:
  validate:
    steps: [{ run: "*not_an_alias" }]
  release:
    steps:
      - run: '*also_not_an_alias'
  quoted-key:
    steps:
      - "*not_an_alias": echo ignored
      - { "*also_not_an_alias": echo ignored }
  quoted-explicit-key:
    steps:
      - ? "*not_an_alias"
        : echo ignored
`;

  assert.deepEqual(policySensitiveAliasLines(workflow), []);
  assert.deepEqual(
    runScriptSections(workflow).map((section) => section.text),
    ["*not_an_alias", "*also_not_an_alias"]
  );
});

test("workflow policy ignores alias-looking text inside block scalars", () => {
  const workflow = `
jobs:
  example:
    steps:
      - run: |
          ? *not_yaml_alias_key
          : *not_yaml_alias_value
`;

  assert.deepEqual(policySensitiveAliasLines(workflow), []);
});

test("workflow policy ignores alias-looking text inside explicit block scalars", () => {
  const workflow = `
jobs:
  example:
    steps:
      - ? run
        : |
          *not_yaml_alias
  env-block:
    ? env
    : |
      *not_yaml_alias
    steps:
      - run: echo safe
`;

  assert.deepEqual(policySensitiveAliasLines(workflow), []);
});

test("workflow run script parser handles chomped block scalars", () => {
  const sections = runScriptSections(`
jobs:
  example:
    steps:
      - run: |- # keep policy coverage when YAML comments follow the block header
          echo one
      - run: >2+
          echo two
      - run: |2
          echo indented
      - run: echo three
`);

  assert.deepEqual(
    sections.map((section) => section.text.trim()),
    ["echo one", "echo two", "echo indented", "echo three"]
  );
});

test("workflow run script parser does not rescan consumed block scalar lines", () => {
  const sections = runScriptSections(`
jobs:
  example:
    steps:
      - run: |
          cat > generated-workflow.yml <<'YAML'
          run: echo \${{ env.EXAMPLE_VALUE }}
          - run: echo also fake
          YAML
      - run: echo done
`);

  assert.deepEqual(
    sections.map((section) => section.text.trim()),
    [
      "cat > generated-workflow.yml <<'YAML'\n          run: echo ${{ env.EXAMPLE_VALUE }}\n          - run: echo also fake\n          YAML",
      "echo done"
    ]
  );
});

test("workflow run script parser ignores non-run block scalar contents", () => {
  const sections = runScriptSections(`
jobs:
  example:
    env:
      GENERATED_WORKFLOW: |
        run: echo fake
        - run: echo also fake
    steps:
      - run: echo real
`);

  assert.deepEqual(
    sections.map((section) => section.text.trim()),
    ["echo real"]
  );
});

test("workflow run script parser treats outdented comments as block scalar terminators", () => {
  const sections = runScriptSections(`
jobs:
  example:
    steps:
      - run: |
          echo real
          # kept as script content
      # run: echo fake
      - run: echo done
`);

  assert.deepEqual(
    sections.map((section) => section.text.trim()),
    ["echo real\n          # kept as script content", "echo done"]
  );
});

test("workflow run script parser only collects run keys from workflow steps", () => {
  const sections = runScriptSections(`
run: echo top-level fake
jobs:
  example:
    env:
      run: echo job-env fake
    steps:
      - name: nested values
        env:
          run: echo step-env fake
        with:
          run: echo step-with fake
          values:
            - run: echo nested-array fake
        run: echo real
      - run: echo inline real
`);

  assert.deepEqual(
    sections.map((section) => section.text.trim()),
    ["echo real", "echo inline real"]
  );
});

test("workflow run script parser handles valid step YAML variants", () => {
  const sections = runScriptSections(`
jobs:
    wide-indent:
      steps: &wide_steps # anchors and nonstandard indentation are valid YAML
        -
          run: echo nested-dash
        - name: block mapping step
          run: echo block-mapping
    tagged:
      steps: !!seq
        - run: echo tagged-sequence
    flow:
      steps: [{ run: echo flow-one }, { name: flow step, run: echo flow-two }]
`);

  assert.deepEqual(
    sections.map((section) => section.text.trim()),
    ["echo nested-dash", "echo block-mapping", "echo tagged-sequence", "echo flow-one", "echo flow-two"]
  );
});

test("workflow run script parser handles explicit flow mapping keys", () => {
  const sections = runScriptSections(`
jobs:
  explicit-flow:
    steps: [{ ? run : "echo explicit flow" }]
`);

  assert.deepEqual(
    sections.map((section) => section.text.trim()),
    ["echo explicit flow"]
  );
});

test("workflow run script parser handles explicit block mapping keys", () => {
  const sections = runScriptSections(`
jobs:
  explicit-block:
    steps:
      - ? run
        : echo explicit block
      - ? run : echo explicit inline
`);

  assert.deepEqual(
    sections.map((section) => section.text.trim()),
    ["echo explicit block", "echo explicit inline"]
  );
});

test("workflow run script parser handles indented child flow steps", () => {
  const sections = runScriptSections(`
jobs:
  tagged-flow:
    steps:
      !!seq [{ run: "echo tagged child" }]
  anchored-flow:
    steps:
      &steps [{ run: "echo anchored child # \${{ secrets.FOO }}" }]
`);

  assert.deepEqual(
    sections.map((section) => section.text.trim()),
    ["echo tagged child", "echo anchored child # ${{ secrets.FOO }}"]
  );
});

test("workflow run script parser handles multiline child flow steps", () => {
  const sections = runScriptSections(`
jobs:
  multiline-flow:
    steps:
      &steps [
        { run: "echo \${{ secrets.FOO }}" }
      ]
`);

  assert.deepEqual(
    sections.map((section) => section.text.trim()),
    ["echo ${{ secrets.FOO }}"]
  );
});

test("workflow run script parser handles same-line-open multiline flow steps", () => {
  const sections = runScriptSections(`
jobs:
  multiline-flow:
    steps: !!seq [
      { run: "echo \${{ secrets.FOO }}" }
    ]
`);

  assert.deepEqual(
    sections.map((section) => section.text.trim()),
    ["echo ${{ secrets.FOO }}"]
  );
});

test("workflow run script parser handles commented multiline flow steps", () => {
  const sections = runScriptSections(`
jobs:
  multiline-flow:
    steps: [
      { run: "echo safe" }, # keep parsing after comments
      { run: "echo # \${{ secrets.FOO }}" }
    ]
`);

  assert.deepEqual(
    sections.map((section) => section.text.trim()),
    ["echo safe", "echo # ${{ secrets.FOO }}"]
  );
});

test("workflow run script parser fails closed on flow run aliases", () => {
  const sections = runScriptSections(`
dangerous_run: &dangerous_run echo \${{ secrets.FOO }}
jobs:
  example:
    steps: [{ run: *dangerous_run }]
`);

  assert.deepEqual(
    sections.map((section) => section.text.trim()),
    ["[{ run: *dangerous_run }]"]
  );
});

test("workflow run script parser fails closed on whole-step aliases", () => {
  const sections = runScriptSections(`
dangerous_step: &dangerous_step
  run: echo \${{ github.token }}
jobs:
  flow:
    steps: [*dangerous_step]
  block:
    steps:
      - *dangerous_step
`);

  assert.deepEqual(
    sections.map((section) => section.text.includes("github.token")),
    [true, true]
  );
});

test("workflow run script parser preserves quoted comment characters", () => {
  const sections = runScriptSections(`
jobs:
  example:
    steps:
      - run: "echo # \${{ secrets.FOO }}"
      - run: 'echo # \${{ github.token }}'
      - run: echo before # YAML comment
  flow:
    steps: [{ run: "echo # \${{ secrets.BAR }}" }]
`);

  assert.deepEqual(
    sections.map((section) => section.text.trim()),
    ["echo # ${{ secrets.FOO }}", "echo # ${{ github.token }}", "echo before", "echo # ${{ secrets.BAR }}"]
  );
});

test("workflow run script parser ignores step block scalar contents", () => {
  const sections = runScriptSections(`
jobs:
  example:
    steps:
      - name: |
          run: echo inline-name-fake
        run: echo inline-name-real
      -
        name: |
          run: echo nested-name-fake
        run: echo nested-name-real
`);

  assert.deepEqual(
    sections.map((section) => section.text.trim()),
    ["echo inline-name-real", "echo nested-name-real"]
  );
});

test("workflow policy scanners fail closed on flow-style jobs", () => {
  const workflow = `
jobs: { validate: { runs-on: ubuntu-latest, steps: [{ run: "echo \${{ secrets.FOO }}" }] } }
`;

  assert.deepEqual(jobSections(workflow), [
    {
      name: unparsedJobsName,
      text: '<unparsed-flow-jobs>\n{ validate: { runs-on: ubuntu-latest, steps: [{ run: "echo ${{ secrets.FOO }}" }] } }'
    }
  ]);
  assert.deepEqual(runScriptSections(workflow), [
    {
      line: 2,
      text: '{ validate: { runs-on: ubuntu-latest, steps: [{ run: "echo ${{ secrets.FOO }}" }] } }'
    }
  ]);
});

test("workflow policy scanners fail closed on indented child flow-style jobs", () => {
  const workflow = `
jobs:
  { validate: { runs-on: ubuntu-latest, steps: [{ run: "echo \${{ secrets.FOO }}" }] } }
`;

  assert.deepEqual(jobSections(workflow).map((section) => ({ ...section, text: section.text.trimEnd() })), [
    {
      name: unparsedJobsName,
      text: '<unparsed-flow-jobs>\n  { validate: { runs-on: ubuntu-latest, steps: [{ run: "echo ${{ secrets.FOO }}" }] } }'
    }
  ]);
  assert.deepEqual(runScriptSections(workflow).map((section) => ({ ...section, text: section.text.trimEnd() })), [
    {
      line: 3,
      text: '  { validate: { runs-on: ubuntu-latest, steps: [{ run: "echo ${{ secrets.FOO }}" }] } }'
    }
  ]);
});

test("workflow policy scanners fail closed on multiline child flow-style jobs", () => {
  const workflow = `
jobs:
  { release: {
      runs-on: ubuntu-latest,
      steps: [{ run: "echo \${{ secrets.FOO }}" }]
    } }
`;

  assert.deepEqual(jobSections(workflow).map((section) => ({ ...section, text: section.text.trimEnd() })), [
    {
      name: unparsedJobsName,
      text: '<unparsed-flow-jobs>\n  { release: {\n      runs-on: ubuntu-latest,\n      steps: [{ run: "echo ${{ secrets.FOO }}" }]\n    } }'
    }
  ]);
  assert.deepEqual(runScriptSections(workflow).map((section) => ({ ...section, text: section.text.trimEnd() })), [
    {
      line: 3,
      text: '  { release: {\n      runs-on: ubuntu-latest,\n      steps: [{ run: "echo ${{ secrets.FOO }}" }]\n    } }'
    }
  ]);
});

test("workflow policy scanners handle decorator-only jobs values", () => {
  const blockWorkflow = `
jobs: !!map
  release:
    steps:
      - run: echo block
`;
  const flowWorkflow = `
jobs: !!map
  { release: {
      runs-on: ubuntu-latest,
      steps: [{ run: "echo \${{ secrets.FOO }}" }]
    } }
`;

  assert.deepEqual(jobSections(blockWorkflow).map((section) => section.name), ["release"]);
  assert.deepEqual(
    runScriptSections(blockWorkflow).map((section) => section.text.trim()),
    ["echo block"]
  );
  assert.deepEqual(jobSections(flowWorkflow).map((section) => ({ ...section, text: section.text.trimEnd() })), [
    {
      name: unparsedJobsName,
      text: '<unparsed-flow-jobs>\n  { release: {\n      runs-on: ubuntu-latest,\n      steps: [{ run: "echo ${{ secrets.FOO }}" }]\n    } }'
    }
  ]);
  assert.deepEqual(runScriptSections(flowWorkflow).map((section) => ({ ...section, text: section.text.trimEnd() })), [
    {
      line: 3,
      text: '  { release: {\n      runs-on: ubuntu-latest,\n      steps: [{ run: "echo ${{ secrets.FOO }}" }]\n    } }'
    }
  ]);
});

test("workflow policy scanners fail closed on same-line-open multiline flow-style jobs", () => {
  const workflow = `
jobs: !!map {
  release: {
    runs-on: ubuntu-latest,
    steps: [{ run: "echo \${{ secrets.FOO }}" }]
  }
}
`;

  assert.deepEqual(jobSections(workflow), [
    {
      name: unparsedJobsName,
      text: '<unparsed-flow-jobs>\n{\n  release: {\n    runs-on: ubuntu-latest,\n    steps: [{ run: "echo ${{ secrets.FOO }}" }]\n  }\n}'
    }
  ]);
  assert.deepEqual(runScriptSections(workflow), [
    {
      line: 2,
      text: '{\n  release: {\n    runs-on: ubuntu-latest,\n    steps: [{ run: "echo ${{ secrets.FOO }}" }]\n  }\n}'
    }
  ]);
});

test("workflow policy scanners do not consume sibling keys after unclosed flow-style jobs", () => {
  const workflow = `
jobs: !!map {
  release: {
    runs-on: ubuntu-latest,
    steps: [{ run: "echo \${{ secrets.FOO }}" }]
  }
on: [workflow_dispatch]
`;

  const jobs = jobSections(workflow);
  assert.equal(jobs.length, 1);
  assert.match(jobs[0].text, /^<unparsed-flow-jobs>\n/);
  assert.doesNotMatch(jobs[0].text, /workflow_dispatch/);
  assert.equal(workflowHasTrigger(workflow, "workflow_dispatch"), true);
  assert.deepEqual(runScriptSections(workflow), [
    {
      line: 2,
      text: '{\n  release: {\n    runs-on: ubuntu-latest,\n    steps: [{ run: "echo ${{ secrets.FOO }}" }]\n  }'
    }
  ]);
});

test("workflow flow parsers fail closed on unclosed flow maps", () => {
  const workflow = `
on: { workflow_dispatch: {}
concurrency: { group: auto-release, cancel-in-progress: false }
jobs: {}
`;

  assert.equal(workflowHasTrigger(workflow, "workflow_dispatch"), false);
  assert.deepEqual(workflowConcurrency(workflow), {
    group: "auto-release",
    "cancel-in-progress": "false"
  });
});

test("permission policy fails closed on flow-style jobs", () => {
  const workflow = `
permissions: { contents: write, issues: write, pull-requests: write }
jobs: { release: { permissions: { contents: write }, steps: [{ uses: cycjimmy/semantic-release-action@v5 }] } }
`;
  const jobs = jobSections(workflow);

  assert.equal(hasEffectivePermission(workflow, jobs[0].text, "contents", "write"), false);
  assert.equal(hasEffectivePermission(workflow, jobs[0].text, "issues", "write"), false);
  assert.equal(hasEffectivePermission(workflow, jobs[0].text, "pull-requests", "write"), false);
});

test("permission policy fails closed on indented child flow-style jobs", () => {
  const workflow = `
permissions: { contents: write, issues: write, pull-requests: write }
jobs:
  { release: { permissions: { contents: write }, steps: [{ uses: cycjimmy/semantic-release-action@v5 }] } }
`;
  const jobs = jobSections(workflow);

  assert.equal(hasEffectivePermission(workflow, jobs[0].text, "contents", "write"), false);
  assert.equal(hasEffectivePermission(workflow, jobs[0].text, "issues", "write"), false);
  assert.equal(hasEffectivePermission(workflow, jobs[0].text, "pull-requests", "write"), false);
});

test("workflow policies fail closed on per-job decorated flow maps", () => {
  const workflow = `
permissions: { contents: write, issues: write, pull-requests: write }
jobs:
  release: !!map
    { permissions: { contents: write }, runs-on: ubuntu-latest, steps: [{ run: "echo \${{ secrets.FOO }}" }, { uses: cycjimmy/semantic-release-action@v5 }] }
`;
  const jobs = jobSections(workflow);

  assert.deepEqual(jobs.map((job) => job.name), ["release"]);
  assert.match(jobs[0].text, /^<unparsed-flow-jobs>\n/);
  assert.match(jobs[0].text, /semantic-release-action@v5/);
  assert.deepEqual(
    runScriptSections(workflow).map((section) => section.text.trim()),
    [
      'release: !!map\n    { permissions: { contents: write }, runs-on: ubuntu-latest, steps: [{ run: "echo ${{ secrets.FOO }}" }, { uses: cycjimmy/semantic-release-action@v5 }] }'
    ]
  );
  assert.equal(hasEffectivePermission(workflow, jobs[0].text, "contents", "write"), false);
  assert.equal(hasEffectivePermission(workflow, jobs[0].text, "issues", "write"), false);
  assert.equal(hasEffectivePermission(workflow, jobs[0].text, "pull-requests", "write"), false);
});

test("job parser stops at the end of the jobs block", () => {
  const sections = jobSections(`
name: Example
jobs:
  validate:
    steps:
      - run: echo validate
env:
  semantic-release: "not a job"
  another: value
`);

  assert.deepEqual(
    sections.map((section) => section.name),
    ["validate"]
  );
});

test("repository text files do not contain token-bearing GitHub HTTPS URLs", () => {
  const tokenExpression = /\$\{\{\s*(?:secrets\.[A-Za-z0-9_]+|github\.token)\s*\}\}/i;
  const credentialedGitHubTokenUser = new RegExp("x-access-" + "token", "i");
  const credentialedGithubUrl = /\bhttps:\/\/[^/\s"'`]+@github\.com(?:\b|[/:])/i;

  for (const file of listPolicyTextFiles()) {
    const relativeFile = path.relative(repoRoot, file);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const location = `${relativeFile}:${index + 1}`;
      assert.doesNotMatch(
        line,
        credentialedGitHubTokenUser,
        `${location} must not use credentialed GitHub token usernames; use checkout's authenticated origin or env-based auth instead`
      );
      assert.ok(
        !(/\bhttps?:\/\//i.test(line) && tokenExpression.test(line)),
        `${location} must not interpolate GitHub token contexts into URLs`
      );
      assert.doesNotMatch(
        line,
        credentialedGithubUrl,
        `${location} must not embed credentials in GitHub HTTPS URLs`
      );
    }
  }
});

test("scheduled manual concurrency groups reject event-specific expressions", () => {
  assert.equal(hasStableConcurrencyGroup({ group: "auto-release" }), true);
  assert.equal(hasStableConcurrencyGroup({ group: "'auto-release'" }), true);
  assert.equal(hasStableConcurrencyGroup({ group: "!!str auto-release" }), true);
  assert.equal(hasStableConcurrencyGroup({ group: '"${{ github.workflow }}"' }), true);
  assert.equal(hasStableConcurrencyGroup({ group: "${{ github.workflow }}" }), true);
  assert.equal(hasStableConcurrencyGroup({ group: "${{ github.ref }}" }), false);
  assert.equal(hasStableConcurrencyGroup({ group: "${{ github.event.schedule || github.run_id }}" }), false);
  assert.equal(hasStableConcurrencyGroup({ group: "release-${{ github.run_number }}" }), false);
});

test("workflow trigger and concurrency parsers handle compact forms", () => {
  const compactBlock = `
on:
  !!str workflow_dispatch: {}
  schedule: [{ cron: "17 3 * * *" }]
concurrency: { group: auto-release, cancel-in-progress: false }
jobs: {}
`;
  const flowOn = `
on: { !!str workflow_dispatch: {}, schedule: [{ cron: "17 3 * * *" }] }
concurrency:
    group: \${{ github.workflow }}
    cancel-in-progress: false
jobs: {}
`;
  const flowSequenceOn = `
on: [!!str workflow_dispatch, schedule]
concurrency: !!map { group: !!str auto-release, cancel-in-progress: !!bool false }
jobs: {}
`;
  const childFlowOn = `
on:
  &events { workflow_dispatch: {}, schedule: [{ cron: "17 3 * * *" }] }
concurrency:
  !!map { group: auto-release, cancel-in-progress: false }
jobs: {}
`;
  const decoratedChildBlock = `
on: !!map
  workflow_dispatch: {}
  schedule: [{ cron: "17 3 * * *" }]
concurrency: !!map
  group: auto-release
  cancel-in-progress: false
jobs: {}
`;
  const decoratedMultilineFlow = `
on: !!map
  { workflow_dispatch: {},
    schedule: [{ cron: "17 3 * * *" }] }
concurrency: !!map
  { group: auto-release,
    cancel-in-progress: false }
jobs: {}
`;
  const sameLineOpenMultilineFlow = `
on: !!map {
  !!str workflow_dispatch: {}, # keep parsing after comments
  schedule: [{ cron: "17 3 * * *" }]
}
concurrency: !!map {
  group: !!str auto-release, # keep parsing after comments
  cancel-in-progress: !!bool false
}
jobs: {}
`;
  const explicitFlowKeys = `
on: { ? workflow_dispatch : {}, ? schedule : [{ cron: "17 3 * * *" }] }
concurrency: { ? group : auto-release, ? cancel-in-progress : false }
jobs: {}
`;
  const explicitBlockKeys = `
on:
  ? workflow_dispatch
  : {}
  ? schedule
  : [{ cron: "17 3 * * *" }]
concurrency:
  ? group
  : auto-release
  ? cancel-in-progress
  : false
jobs: {}
`;

  assert.equal(workflowHasTrigger(compactBlock, "workflow_dispatch"), true);
  assert.equal(workflowHasTrigger(compactBlock, "schedule"), true);
  assert.deepEqual(workflowConcurrency(compactBlock), {
    group: "auto-release",
    "cancel-in-progress": "false"
  });

  assert.equal(workflowHasTrigger(flowOn, "workflow_dispatch"), true);
  assert.equal(workflowHasTrigger(flowOn, "schedule"), true);
  assert.deepEqual(workflowConcurrency(flowOn), {
    group: "${{ github.workflow }}",
    "cancel-in-progress": "false"
  });

  assert.equal(workflowHasTrigger(flowSequenceOn, "workflow_dispatch"), true);
  assert.equal(workflowHasTrigger(flowSequenceOn, "schedule"), true);
  assert.equal(workflowHasTrigger(flowSequenceOn, "pull_request"), false);
  assert.deepEqual(workflowConcurrency(flowSequenceOn), {
    group: "auto-release",
    "cancel-in-progress": "false"
  });

  assert.equal(workflowHasTrigger(childFlowOn, "workflow_dispatch"), true);
  assert.equal(workflowHasTrigger(childFlowOn, "schedule"), true);
  assert.deepEqual(workflowConcurrency(childFlowOn), {
    group: "auto-release",
    "cancel-in-progress": "false"
  });

  assert.equal(workflowHasTrigger(decoratedChildBlock, "workflow_dispatch"), true);
  assert.equal(workflowHasTrigger(decoratedChildBlock, "schedule"), true);
  assert.deepEqual(workflowConcurrency(decoratedChildBlock), {
    group: "auto-release",
    "cancel-in-progress": "false"
  });

  assert.equal(workflowHasTrigger(decoratedMultilineFlow, "workflow_dispatch"), true);
  assert.equal(workflowHasTrigger(decoratedMultilineFlow, "schedule"), true);
  assert.equal(workflowHasTrigger(decoratedMultilineFlow, "pull_request"), false);
  assert.deepEqual(workflowConcurrency(decoratedMultilineFlow), {
    group: "auto-release",
    "cancel-in-progress": "false"
  });

  assert.equal(workflowHasTrigger(sameLineOpenMultilineFlow, "workflow_dispatch"), true);
  assert.equal(workflowHasTrigger(sameLineOpenMultilineFlow, "schedule"), true);
  assert.equal(workflowHasTrigger(sameLineOpenMultilineFlow, "pull_request"), false);
  assert.deepEqual(workflowConcurrency(sameLineOpenMultilineFlow), {
    group: "auto-release",
    "cancel-in-progress": "false"
  });

  assert.equal(workflowHasTrigger(explicitFlowKeys, "workflow_dispatch"), true);
  assert.equal(workflowHasTrigger(explicitFlowKeys, "schedule"), true);
  assert.equal(workflowHasTrigger(explicitFlowKeys, "pull_request"), false);
  assert.deepEqual(workflowConcurrency(explicitFlowKeys), {
    group: "auto-release",
    "cancel-in-progress": "false"
  });

  assert.equal(workflowHasTrigger(explicitBlockKeys, "workflow_dispatch"), true);
  assert.equal(workflowHasTrigger(explicitBlockKeys, "schedule"), true);
  assert.equal(workflowHasTrigger(explicitBlockKeys, "pull_request"), false);
  assert.deepEqual(workflowConcurrency(explicitBlockKeys), {
    group: "auto-release",
    "cancel-in-progress": "false"
  });
});

test("workflow policy scanners handle top-level explicit mappings", () => {
  const workflow = `
? "on"
: [workflow_dispatch, schedule]
? permissions
:
  contents: read
? concurrency
: { group: "\${{ github.ref }}", cancel-in-progress: false }
? jobs
:
  release:
    permissions:
      contents: write
    steps:
      - run: echo \${{ secrets.FOO }}
`;
  const jobs = jobSections(workflow);

  assert.equal(workflowHasTrigger(workflow, "workflow_dispatch"), true);
  assert.equal(workflowHasTrigger(workflow, "schedule"), true);
  assert.deepEqual(workflowConcurrency(workflow), {
    group: "${{ github.ref }}",
    "cancel-in-progress": "false"
  });
  assert.deepEqual(jobs.map((job) => job.name), ["release"]);
  assert.deepEqual(
    runScriptSections(workflow).map((section) => section.text.trim()),
    ["echo ${{ secrets.FOO }}"]
  );
  assert.equal(hasEffectivePermission(workflow, jobs[0].text, "contents", "write"), true);
});

test("scheduled manual workflows declare stable concurrency", () => {
  const checkedWorkflows = [];

  for (const workflow of listWorkflows()) {
    const text = readWorkflow(workflow);
    if (!workflowHasTrigger(text, "schedule") || !workflowHasTrigger(text, "workflow_dispatch")) {
      continue;
    }

    checkedWorkflows.push(workflow);
    assert.ok(
      hasStableConcurrencyGroup(workflowConcurrency(text)),
      `${workflow} must declare a workflow-level concurrency group that is stable across scheduled and manual runs`
    );
  }

  assert.deepEqual(checkedWorkflows.sort(), ["auto-release.yml", "reap-stale-locks.yml"]);
});

test("reap stale locks workflow keeps scheduled manual cleanup wiring", () => {
  const text = readWorkflow("reap-stale-locks.yml");
  const concurrency = workflowConcurrency(text);
  const reapSteps = workflowJobStepMaps(text, "reap");
  const reapActionStep = reapSteps.find((step) => step.uses === "./.github/actions/reap-stale-locks");

  assert.equal(workflowHasTrigger(text, "schedule"), true);
  assert.equal(workflowHasTrigger(text, "workflow_dispatch"), true);
  assert.deepEqual(
    jobSections(text).map((job) => job.name),
    ["reap"]
  );
  assert.equal(concurrency.group, "build-lock-reaper");
  assert.equal(concurrency["cancel-in-progress"], "true");
  assert.ok(reapActionStep, "reap job must call the local reap-stale-locks action");
  assert.equal(reapActionStep.with["lock-name"], "wallstop-organization-builds");
  assert.match(reapActionStep.with.operation, /github\.event\.inputs\.operation/);
  assert.match(reapActionStep.with["reservation-id"], /github\.event\.inputs\['reservation-id'\]/);
  assert.match(reapActionStep.with["resource-safe"], /github\.event\.inputs\['resource-safe'\]/);
  assert.doesNotMatch(text, /\$\{\{\s*inputs(?:\.|\[)/);
  assert.equal(reapActionStep.env.BUILD_LOCK_APP_ID, "${{ secrets.BUILD_LOCK_APP_ID }}");
  assert.equal(
    reapActionStep.env.BUILD_LOCK_APP_PRIVATE_KEY,
    "${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}"
  );
  assert.equal(reapActionStep.env.BUILD_LOCK_TOKEN, undefined);
  assert.doesNotMatch(text, /ORG_BUILD_LOCK_TOKEN/);
});

test("semantic-release GitHub workflows declare required token permissions", () => {
  const releaseConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".releaserc.json"), "utf8"));
  const plugins = Array.isArray(releaseConfig.plugins) ? releaseConfig.plugins : [];
  const usesGithubPlugin = plugins.some(isGithubReleasePlugin);

  if (!usesGithubPlugin) {
    return;
  }

  const checkedJobs = [];

  for (const workflow of listWorkflows()) {
    const text = readWorkflow(workflow);
    for (const job of jobSections(text)) {
      if (!/semantic-release/.test(job.text)) {
        continue;
      }

      checkedJobs.push(`${workflow}:${job.name}`);
      assert.ok(
        hasEffectivePermission(text, job.text, "contents", "write"),
        `${workflow} job ${job.name} must grant contents: write so @semantic-release/github can publish releases and tags`
      );
      assert.ok(
        hasEffectivePermission(text, job.text, "issues", "write"),
        `${workflow} job ${job.name} must grant issues: write for @semantic-release/github issue updates`
      );
      assert.ok(
        hasEffectivePermission(text, job.text, "pull-requests", "write"),
        `${workflow} job ${job.name} must grant pull-requests: write for @semantic-release/github PR updates`
      );
    }
  }

  assert.deepEqual(checkedJobs, ["auto-release.yml:release"]);
});

test("semantic-release workflows serialize releases without canceling active publishes", () => {
  const checkedWorkflows = [];

  for (const workflow of listWorkflows()) {
    const text = readWorkflow(workflow);
    if (!jobSections(text).some((job) => /semantic-release/.test(job.text))) {
      continue;
    }

    checkedWorkflows.push(workflow);
    const concurrency = workflowConcurrency(text);
    assert.ok(
      hasStableConcurrencyGroup(concurrency),
      `${workflow} must declare a workflow-level concurrency group so release jobs cannot overlap`
    );
    assert.equal(
      concurrency["cancel-in-progress"],
      "false",
      `${workflow} release concurrency must queue behind an active publish instead of canceling it mid-release`
    );
  }

  assert.deepEqual(checkedWorkflows, ["auto-release.yml"]);
});

test("Dependabot auto-merge handles successful CI reruns", () => {
  const text = readWorkflow("dependabot-auto-merge.yml");

  assert.match(text, /^\s*workflow_run:\s*$/m);
  assert.match(text, /^\s*workflows:\s*\[Build lock CI\]\s*$/m);
  assert.match(text, /^\s*types:\s*\[completed\]\s*$/m);
  assert.match(text, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(text, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
});

test("Dependabot auto-merge CI gate is exact-head and workflow-filtered", () => {
  const text = readWorkflow("dependabot-auto-merge.yml");

  assert.match(text, /gh api -X GET "repos\/\$\{REPOSITORY\}\/actions\/runs"/);
  assert.match(text, /-f head_sha="\$\{PR_HEAD_SHA\}"/);
  assert.match(text, /map\(select\(\.workflow_id == \$\{ci_workflow_id\} and \.event == \\"pull_request\\"\)\)/);
  assert.match(text, /run_conclusion="\$\(jq -r '\.conclusion'/);
  assert.doesNotMatch(text, /actions\/workflows\/\$\{CI_WORKFLOW_FILE\}\/runs/);
  assert.doesNotMatch(text, /gh api[^\n]*\|\|\s*true/);
  assert.doesNotMatch(text, /@\s*tsv/);
});

test("Dependabot auto-merge uses one concurrency key for PR and CI completion triggers", () => {
  const text = readWorkflow("dependabot-auto-merge.yml");

  assert.match(text, /group:\s*dependabot-automerge-\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.event\.workflow_run\.head_sha\s*\|\|\s*github\.run_id\s*\}\}/);
  assert.doesNotMatch(text, /github\.event\.pull_request\.head\.ref\s*\|\|\s*github\.event\.workflow_run\.head_branch/);
  assert.doesNotMatch(text, /github\.event\.pull_request\.number\s*\|\|\s*github\.event\.workflow_run\.head_sha/);
  assert.match(text, /cancel-in-progress:\s*true/);
});

test("Dependabot auto-merge revalidates PR identity before merging", () => {
  const text = readWorkflow("dependabot-auto-merge.yml");

  assert.match(text, /pr_author="\$\(jq -r '\.user\.login'/);
  assert.match(text, /\$\{pr_author\}" != "dependabot\[bot\]"/);
  assert.match(text, /pr_draft="\$\(jq -r '\.draft'/);
  assert.match(text, /EVENT_PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| '' \}\}/);
  assert.match(text, /\$\{EVENT_NAME\}" == "pull_request_target" && "\$\{pr_head_sha\}" != "\$\{EVENT_PR_HEAD_SHA\}"/);
  assert.match(text, /event head \$\{EVENT_PR_HEAD_SHA\} is stale because the current head is \$\{pr_head_sha\}/);
  assert.match(text, /current_head_sha="\$\(jq -r '\.head\.sha'/);
  assert.match(text, /\$\{current_head_sha\}" != "\$\{PR_HEAD_SHA\}"/);
  assert.match(text, /skipping stale auto-merge attempt\."\s*\n\s*exit 0/);
  assert.match(text, /auto_merge_enabled="\$\(jq -r '\.auto_merge != null'/);
  assert.doesNotMatch(text, /refusing to enable auto-merge for stale CI[\s\S]*exit 1/);
});

test("privileged Dependabot auto-merge workflow does not check out PR code", () => {
  const text = readWorkflow("dependabot-auto-merge.yml");

  assert.match(text, /^\s*pull_request_target:\s*$/m);
  assert.doesNotMatch(text, /uses:\s*actions\/checkout@/);
});
