const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");
const workflowsRoot = path.join(repoRoot, ".github", "workflows");
const policyTextExtensions = new Set([".js", ".json", ".md", ".yml", ".yaml"]);
const unparsedJobsName = "<unparsed-flow-jobs>";

function readWorkflow(name) {
  return fs.readFileSync(path.join(workflowsRoot, name), "utf8");
}

function listWorkflows() {
  return fs
    .readdirSync(workflowsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.name);
}

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

function collectFlowNodeText(lines, startIndex, _endIndex, firstValue) {
  const collected = [firstValue];
  let depth = flowBalance(stripYamlFlowComments(collected.join("\n")));

  for (let index = startIndex + 1; depth > 0 && index < lines.length; index += 1) {
    const line = lines[index];
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
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }

  const body = trimmed.slice(1, -1).trim();
  if (!body) {
    return [];
  }
  return splitTopLevel(body);
}

function parseFlowMap(value) {
  const trimmed = stripYamlNodeDecorators(stripYamlFlowComments(value));
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  const body = trimmed.slice(1, -1).trim();
  const mapping = {};
  if (!body) {
    return mapping;
  }

  for (const part of splitTopLevel(body)) {
    const colon = findTopLevelColon(part);
    if (colon === -1) {
      return null;
    }

    const key = yamlScalarValue(part.slice(0, colon).trim());
    const entryValue = part.slice(colon + 1).trim();
    mapping[key] = entryValue;
  }
  return mapping;
}

function normalizeYamlScalarMapValues(mapping) {
  return Object.fromEntries(Object.entries(mapping).map(([key, value]) => [key, yamlScalarValue(value)]));
}

function parseYamlKeyText(text) {
  const normalizedText = stripYamlNodeDecorators(text);
  const entry = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_.-]+)):[ \t]*(.*)$/.exec(normalizedText);
  if (!entry) {
    return null;
  }

  return {
    key: entry[1] || entry[2] || entry[3],
    value: yamlNodeValue(stripYamlComment(entry[4]))
  };
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
      entries.push({ ...entry, index });
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
  return /^\*[A-Za-z0-9_.-]+$/.test(stripYamlNodeDecorators(stripYamlComment(value)));
}

function findTopLevelMappingEntry(lines, key) {
  for (let index = 0; index < lines.length; index += 1) {
    if (isBlankOrComment(lines[index]) || lineIndent(lines[index]) !== 0) {
      continue;
    }

    const entry = parseYamlKeyLine(lines[index]);
    if (entry && entry.key === key) {
      return { ...entry, index };
    }
  }
  return null;
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
      declaration = { ...entry, index };
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

  const blockEnd = findMappingBlockEnd(lines, declaration.index + 1, indent);
  const child = directChildValue(lines, declaration.index + 1, blockEnd, indent);
  if (child && isFlowMapLike(child.value)) {
    const flowText = collectFlowNodeText(lines, child.index, blockEnd, child.value);
    return permissionsFromFlowMap(flowText) || new Map();
  }

  const entries = directMappingEntries(lines, declaration.index + 1, blockEnd, indent);
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
    const onEnd = findMappingBlockEnd(lines, onEntry.index + 1, onEntry.indent);
    const onValue = isFlowLike(onEntry.value) ? collectFlowNodeText(lines, onEntry.index, onEnd, onEntry.value) : onEntry.value;
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

  const onEnd = findMappingBlockEnd(lines, onEntry.index + 1, onEntry.indent);
  const mappingEntries = directMappingEntries(lines, onEntry.index + 1, onEnd, onEntry.indent);
  const sequenceItems = directSequenceItems(lines, onEntry.index + 1, onEnd, onEntry.indent);
  if (mappingEntries.length > 0 || sequenceItems.length > 0) {
    return (
      mappingEntries.some((entry) => entry.key === trigger) ||
      sequenceItems.some((item) => yamlScalarValue(item.value) === trigger)
    );
  }

  const child = directChildValue(lines, onEntry.index + 1, onEnd, onEntry.indent);
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
    const end = findMappingBlockEnd(lines, concurrencyEntry.index + 1, concurrencyEntry.indent);
    const value = isFlowLike(concurrencyEntry.value)
      ? collectFlowNodeText(lines, concurrencyEntry.index, end, concurrencyEntry.value)
      : concurrencyEntry.value;
    const flowMap = parseFlowMap(value);
    return flowMap ? normalizeYamlScalarMapValues(flowMap) : { group: value };
  }

  const concurrency = {};
  const end = findMappingBlockEnd(lines, concurrencyEntry.index + 1, concurrencyEntry.indent);
  for (const entry of directMappingEntries(lines, concurrencyEntry.index + 1, end, concurrencyEntry.indent)) {
    concurrency[entry.key] = yamlScalarValue(entry.value);
  }
  if (Object.keys(concurrency).length > 0) {
    return concurrency;
  }

  const child = directChildValue(lines, concurrencyEntry.index + 1, end, concurrencyEntry.indent);
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
    const jobsEnd = findMappingBlockEnd(lines, jobsEntry.index + 1, jobsEntry.indent);
    const value = isFlowMapLike(jobsEntry.value) ? collectFlowNodeText(lines, jobsEntry.index, jobsEnd, jobsEntry.value) : jobsEntry.value;
    return [{ name: unparsedJobsName, text: `${unparsedJobsName}\n${value}` }];
  }

  const jobsEnd = findMappingBlockEnd(lines, jobsEntry.index + 1, jobsEntry.indent);
  const starts = directMappingEntries(lines, jobsEntry.index + 1, jobsEnd, jobsEntry.indent);
  if (starts.length === 0) {
    const child = directChildValue(lines, jobsEntry.index + 1, jobsEnd, jobsEntry.indent);
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
      const result = collectRunScript(lines, item.index, inlineEntryIndent, inlineEntry.value);
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

    const result = collectRunScript(lines, entry.index, entry.indent, entry.value);
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
    const jobsEnd = findMappingBlockEnd(lines, jobsEntry.index + 1, jobsEntry.indent);
    const value = isFlowMapLike(jobsEntry.value) ? collectFlowNodeText(lines, jobsEntry.index, jobsEnd, jobsEntry.value) : jobsEntry.value;
    return [{ line: jobsEntry.index + 1, text: value }];
  }

  const jobsEnd = findMappingBlockEnd(lines, jobsEntry.index + 1, jobsEntry.indent);
  const jobEntries = directMappingEntries(lines, jobsEntry.index + 1, jobsEnd, jobsEntry.indent);
  if (jobEntries.length === 0) {
    const child = directChildValue(lines, jobsEntry.index + 1, jobsEnd, jobsEntry.indent);
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

function isGithubReleasePlugin(plugin) {
  return plugin === "@semantic-release/github" || (Array.isArray(plugin) && plugin[0] === "@semantic-release/github");
}

function policySensitiveAliasLines(text) {
  const lines = text.split(/\r?\n/);
  const aliases = [];
  let pendingStepsIndent = null;

  function flowValueHasPolicyAlias(value) {
    if (isYamlAlias(value)) {
      return true;
    }

    const flowMap = parseFlowMap(value);
    if (flowMap) {
      return Object.values(flowMap).some((entryValue) => flowValueHasPolicyAlias(entryValue));
    }

    const flowItems = parseFlowSequence(value) || [];
    return flowItems.some((item) => flowValueHasPolicyAlias(item));
  }

  for (const [index, line] of lines.entries()) {
    const stripped = stripYamlComment(line);
    if (!stripped) {
      continue;
    }

    const indent = lineIndent(line);
    if (pendingStepsIndent !== null && indent > pendingStepsIndent && /^\s*\*[A-Za-z0-9_.-]+\s*$/.test(stripped)) {
      aliases.push(index + 1);
    }
    if (pendingStepsIndent !== null && indent <= pendingStepsIndent) {
      pendingStepsIndent = null;
    }

    const key = parseYamlKeyLine(line);
    if (key && ["run", "steps", "uses"].includes(key.key) && isYamlAlias(key.value)) {
      aliases.push(index + 1);
    }
    if (key && flowValueHasPolicyAlias(key.value)) {
      aliases.push(index + 1);
    }
    if (key && isFlowLike(key.value)) {
      const flowText = collectFlowNodeText(lines, index, lines.length, key.value);
      if (flowValueHasPolicyAlias(flowText)) {
        aliases.push(index + 1);
      }
    }

    const sequence = parseSequenceItem(line);
    if (sequence && isYamlAlias(sequence.value)) {
      aliases.push(index + 1);
    }

    const sequenceKey = sequence && parseYamlKeyText(sequence.value);
    if (sequenceKey && ["run", "steps", "uses"].includes(sequenceKey.key) && isYamlAlias(sequenceKey.value)) {
      aliases.push(index + 1);
    }

    if (sequence && flowValueHasPolicyAlias(sequence.value)) {
      aliases.push(index + 1);
    }
    if (sequence && isFlowLike(sequence.value)) {
      const flowText = collectFlowNodeText(lines, index, lines.length, sequence.value);
      if (flowValueHasPolicyAlias(flowText)) {
        aliases.push(index + 1);
      }
    }

    if (flowValueHasPolicyAlias(stripped)) {
      aliases.push(index + 1);
    }
    if (isFlowLike(stripped)) {
      const flowText = collectFlowNodeText(lines, index, lines.length, stripped);
      if (flowValueHasPolicyAlias(flowText)) {
        aliases.push(index + 1);
      }
    }

    if (key && key.key === "steps" && !key.value) {
      pendingStepsIndent = key.indent;
    }
  }

  return [...new Set(aliases)];
}

test("workflows that query Actions REST APIs declare actions read permission", () => {
  for (const workflow of listWorkflows()) {
    const text = readWorkflow(workflow);

    for (const job of jobSections(text)) {
      if (!/gh api[\s\S]*\/actions\/(?:runs|workflows)\b/.test(job.text)) {
        continue;
      }

      assert.ok(
        hasEffectivePermission(text, job.text, "actions", "read"),
        `${workflow} job ${job.name} must grant actions: read/write in its effective permissions`
      );
    }
  }
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

test("workflow policy rejects aliases in run scripts, steps, and action uses", () => {
  const aliased = `
dangerous_run: &dangerous_run echo \${{ secrets.FOO }}
dangerous_steps: &dangerous_steps
  - uses: cycjimmy/semantic-release-action@v5
dangerous_step: &dangerous_step
  run: echo \${{ github.token }}
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
`;

  assert.deepEqual(policySensitiveAliasLines(aliased), [10, 11, 12, 13, 14, 15, 17, 19, 21, 23, 25, 27, 30, 33, 36]);

  for (const workflow of listWorkflows()) {
    const aliases = policySensitiveAliasLines(readWorkflow(workflow));
    assert.deepEqual(aliases, [], `${workflow} must not use YAML aliases for run, steps, or uses fields`);
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
`;

  assert.deepEqual(policySensitiveAliasLines(workflow), []);
  assert.deepEqual(
    runScriptSections(workflow).map((section) => section.text),
    ["*not_an_alias", "*also_not_an_alias"]
  );
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
});

test("scheduled manual workflows declare stable concurrency", () => {
  for (const workflow of listWorkflows()) {
    const text = readWorkflow(workflow);
    if (!workflowHasTrigger(text, "schedule") || !workflowHasTrigger(text, "workflow_dispatch")) {
      continue;
    }

    assert.ok(
      hasStableConcurrencyGroup(workflowConcurrency(text)),
      `${workflow} must declare a workflow-level concurrency group that is stable across scheduled and manual runs`
    );
  }
});

test("semantic-release GitHub workflows declare required token permissions", () => {
  const releaseConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".releaserc.json"), "utf8"));
  const plugins = Array.isArray(releaseConfig.plugins) ? releaseConfig.plugins : [];
  const usesGithubPlugin = plugins.some(isGithubReleasePlugin);

  if (!usesGithubPlugin) {
    return;
  }

  for (const workflow of listWorkflows()) {
    const text = readWorkflow(workflow);
    for (const job of jobSections(text)) {
      if (!/semantic-release/.test(job.text)) {
        continue;
      }

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
});

test("semantic-release workflows serialize releases without canceling active publishes", () => {
  for (const workflow of listWorkflows()) {
    const text = readWorkflow(workflow);
    if (!jobSections(text).some((job) => /semantic-release/.test(job.text))) {
      continue;
    }

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
