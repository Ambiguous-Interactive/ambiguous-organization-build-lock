#!/usr/bin/env bash
set -euo pipefail

# Open reviewed pull requests that repin consumer lock action references to
# the newest authorized release. Each new offer enables auto-merge, so GitHub
# merges it only after every consumer gate passes; a consumer can still merge
# by hand or disable auto-merge. A closed repin pull request is a consumer
# answer: the automation never re-offers that repin, never force-pushes, and
# never edits a default branch.

# The reviewed enrollment policy that drives scope and repin exceptions.
# REPIN_POLICY_PATH overrides it for tests.
policy_path="${REPIN_POLICY_PATH:-unity-enrollment-policy.json}"
lock_repository_prefix="Ambiguous-Interactive/ambiguous-organization-build-lock/"

resolve_scope() {
  go run ./cmd/audit-unity-enrollment \
    --policy "${policy_path}" \
    --validate-policy-only
  local count
  count="$(jq -er '.repositories | length' "${policy_path}")"
  if [ "${count}" -lt 6 ]; then
    echo "The Unity enrollment baseline is incomplete." >&2
    exit 1
  fi
  local repositories
  repositories="$(jq -r '.repositories[].repository | split("/")[1]' "${policy_path}" |
    LC_ALL=C sort |
    paste -sd, -)"
  if [ -z "${repositories}" ]; then
    echo "The Unity enrollment repin scope is empty." >&2
    exit 1
  fi
  echo "repositories=${repositories}" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
}

resolve_repin_target() {
  # The repin target is the newest authorized release, never the newest
  # published release. Authorization is the human merge of the release
  # authorization pull request, so the target must resolve to a reviewed
  # release tag that both allowlists approve.
  git fetch --force origin 'refs/tags/v*:refs/tags/v*' >/dev/null 2>&1 || {
    echo "Could not fetch release tags for repin target resolution." >&2
    exit 1
  }
  local target="" target_version=""
  local sha tag
  while IFS= read -r sha; do
    [ -n "${sha}" ] || continue
    tag="$(git tag --points-at "${sha}" 2>/dev/null |
      grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' |
      LC_ALL=C sort -V |
      tail -n1 || true)"
    if [ -z "${tag}" ]; then
      continue
    fi
    if [ -z "${target_version}" ] ||
      [ "$(printf '%s\n%s\n' "${target_version}" "${tag}" | LC_ALL=C sort -V | tail -n1)" = "${tag}" ]; then
      target="${sha}"
      target_version="${tag}"
    fi
  done < <(jq -r '.approvedLockShas[]' "${policy_path}")
  if [ -z "${target}" ]; then
    echo "No authorized lock SHA resolves to a release tag; refusing to guess a repin target." >&2
    exit 1
  fi
  if ! jq -e --arg sha "${target}" '.approvedReturnShas | index($sha)' "${policy_path}" >/dev/null; then
    echo "Repins require the target in approvedReturnShas; ${target} is missing." >&2
    exit 1
  fi
  printf '%s\t%s\n' "${target}" "${target_version}"
}

rewrite_pins() {
  # Mechanical mutation contract: replace only the 40-hex reference suffix on
  # `uses:` lines that name this repository's actions, and update a trailing
  # `# vX.Y.Z` comment to the new release in the spacing the consumer's own
  # files already use. Everything else is untouched, and the target must
  # already be authorized in both allowlists.
  # A reviewed, unexpired repin exception preserves one whole workflow file so
  # a pin-only update cannot move a caller to an action whose input contract
  # it cannot satisfy. Reviewed `repinCompanions` files carry the consumer
  # artifacts that derive from the pin (copyable docs, pin constants, policy
  # snapshots) through the same mechanical, mode-bound rewrite, so a declared
  # companion never leaves the offered commit incomplete. A pin-literal
  # companion that still names an authorized pin no moved pin accounts for
  # fails the run instead of guessing.
  local directory="$1" target_sha="$2" target_version="$3" repository="$4"
  node - "${directory}" "${target_sha}" "${target_version}" "${policy_path}" "${lock_repository_prefix}" "${repository}" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const [directory, targetSha, targetVersion, policyPath, lockPrefix, repository] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(targetSha)) {
  throw new Error("Repins require a full lowercase 40-character commit SHA.");
}
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const lowered = (values) => new Set((values || []).map((value) => String(value).toLowerCase()));
// The exact reviewed top-level fields; the registry parser rejects any other
// field, so the standalone rewrite must refuse it too.
const reviewedPolicyKeys = new Set([
  "schemaVersion",
  "organization",
  "approvedLockShas",
  "approvedReturnShas",
  "approvedDarwinReturnShas",
  "repositories",
  "exceptions",
  "repinExceptions",
  "repinCompanions"
]);
for (const key of Object.keys(policy)) {
  if (!reviewedPolicyKeys.has(key)) {
    throw new Error(`Repins reject an unknown policy field: ${key}`);
  }
}
if (!lowered(policy.approvedLockShas).has(targetSha) || !lowered(policy.approvedReturnShas).has(targetSha)) {
  throw new Error(`Refusing to repin to ${targetSha}: it is not authorized in both allowlists.`);
}
if (policy.schemaVersion !== 1) {
  throw new Error("Repins require the reviewed policy schemaVersion 1.");
}
if (policy.organization !== "Ambiguous-Interactive") {
  throw new Error("Repins require the reviewed policy organization.");
}
const exceptionPattern = /^\.github\/workflows\/[^/]+\.[yY][aA]?[mM][lL]$/;
const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const singleLine = (value) => !/[\r\n`]/.test(value);
const canonicalRepositories = new Map();
for (const value of Array.isArray(policy.repositories) ? policy.repositories : []) {
  canonicalRepositories.set(String(value.repository || "").toLowerCase(), String(value.repository || ""));
}
// Companion modes are the reviewed mechanical rewrites. They mirror the
// registry parser's validation, so a standalone rewrite cannot accept a
// policy the audit would reject.
const companionModes = new Set(["pin-lines", "pin-literal", "policy-snapshot"]);
// The exact reviewed allowlist keys; any other approved*Shas key is an
// unreviewed boundary the registry parser would reject.
const reviewedSnapshotKeys = new Set(["approvedLockShas", "approvedReturnShas", "approvedDarwinReturnShas"]);
const reviewedEntryKeys = new Set(["repository", "path", "reason", "owner", "expiresAt"]);
const reviewedCompanionKeys = new Set(["repository", "path", "mode"]);
// The workflow walk selects `.yml`/`.yaml` files by name, so a companion on any
// other extension is named by nothing else and this rewrite is its only
// writer. Mirrors `validRepinCompanionPath` in internal/enrollment, including
// its rejection of a trailing slash: `path.posix.normalize` keeps one where
// Go's `path.Clean` removes it, so the check is stated here rather than left
// to the comparison. A companion names one file, and `path/` is a directory.
const validCompanionPath = (value) =>
  typeof value === "string" && value.length > 0 &&
  !value.includes("\\") && !value.startsWith("/") && !value.startsWith("-") &&
  !value.endsWith("/") &&
  !(value === ".github" || (value.startsWith(".github/") && /\.ya?ml$/i.test(value))) &&
  singleLine(value) &&
  !/[\x00-\x1f\x7f]/.test(value) &&
  !value.split("/").includes("..") && path.posix.normalize(value) === value;
if (policy.repinExceptions !== undefined && !Array.isArray(policy.repinExceptions)) {
  throw new Error("Repins require repinExceptions to be a list when present.");
}
if (policy.repinCompanions !== undefined && !Array.isArray(policy.repinCompanions)) {
  throw new Error("Repins require repinCompanions to be a list when present.");
}
// Every entry must match the reviewed registry contract, including entries
// for other repositories, so a standalone rewrite cannot accept a policy the
// registry parser would reject.
const entries = policy.repinExceptions || [];
const seenExceptions = new Set();
for (const entry of entries) {
  for (const key of Object.keys(entry)) {
    if (!reviewedEntryKeys.has(key)) {
      throw new Error(`Repins reject an unknown repinExceptions entry field: ${key}`);
    }
  }
  const entryRepository = String(entry.repository || "");
  if (canonicalRepositories.get(entryRepository.toLowerCase()) !== entryRepository) {
    throw new Error("Repins require a registered canonical repository spelling in every repinExceptions entry.");
  }
  const entryPath = String(entry.path || "");
  if (!exceptionPattern.test(entryPath) || entryPath.includes("\\") ||
    !singleLine(entryPath) || entryPath.split("/").includes("..")) {
    throw new Error(`Repins require a normalized workflow path in repinExceptions; got ${entryPath}`);
  }
  if (!singleLine(String(entry.owner || "")) || !String(entry.owner || "").trim() ||
    !singleLine(String(entry.reason || "")) || !String(entry.reason || "").trim()) {
    throw new Error("Repins require a single-line owner and reason in every repinExceptions entry.");
  }
  const expiry = String(entry.expiresAt || "");
  if (!rfc3339Pattern.test(expiry) || !Number.isFinite(Date.parse(expiry))) {
    throw new Error(`Repins require an RFC3339 expiry in repinExceptions; got ${expiry}`);
  }
  const key = `${entryRepository.toLowerCase()}\u0000${entryPath}`;
  if (seenExceptions.has(key)) {
    throw new Error("Repins reject a duplicate repository/path repinExceptions entry.");
  }
  seenExceptions.add(key);
}
const companionEntries = policy.repinCompanions || [];
const seenCompanions = new Set();
for (const entry of companionEntries) {
  for (const key of Object.keys(entry)) {
    if (!reviewedCompanionKeys.has(key)) {
      throw new Error(`Repins reject an unknown repinCompanions entry field: ${key}`);
    }
  }
  const entryRepository = String(entry.repository || "");
  if (canonicalRepositories.get(entryRepository.toLowerCase()) !== entryRepository) {
    throw new Error("Repins require a registered canonical repository spelling in every repinCompanions entry.");
  }
  const entryPath = String(entry.path || "");
  if (!validCompanionPath(entryPath)) {
    throw new Error(`Repins require a normalized repository-relative path that is not a .github YAML file in repinCompanions; got ${entryPath}`);
  }
  if (!companionModes.has(String(entry.mode || ""))) {
    throw new Error(`Repins require a reviewed mechanical mode in repinCompanions; got ${entry.mode}`);
  }
  const key = `${entryRepository.toLowerCase()}\u0000${entryPath}`;
  if (seenCompanions.has(key)) {
    throw new Error("Repins reject a duplicate repository/path repinCompanions entry.");
  }
  seenCompanions.add(key);
}
const exceptions = new Map();
for (const entry of entries) {
  if (entry.repository !== repository) {
    continue;
  }
  const expiry = Date.parse(String(entry.expiresAt));
  if (expiry <= Date.now()) {
    throw new Error(
      `The repin exception for ${entry.path} expired at ${entry.expiresAt}; renew or remove it before repinning.`
    );
  }
  exceptions.set(entry.path, entry);
}
const companions = [];
for (const entry of companionEntries) {
  if (entry.repository !== repository) {
    continue;
  }
  companions.push({ path: entry.path, mode: String(entry.mode) });
}
const linePattern =
  /^(\s*(?:-\s+)?uses:\s*Ambiguous-Interactive\/ambiguous-organization-build-lock\/\S+?@)([0-9a-f]{40})(\s+#.*)?$/;
const versionCommentPattern = /^#\s*v\d+\.\d+\.\d+$/;
// A workflow file may end its lines with CRLF. `split("\n")` leaves the `\r`
// on every line, and the pattern's `$` anchor does not match before it, so
// the match drops the terminator and `rewritePinLine` puts it back. Without
// this the pattern skips every pin in such a file: the rewrite reports no
// change, the automation closes its own offer as superseded, and the
// consumer keeps a stale pin with no evidence that anything was missed.
const matchPinLine = (line) => linePattern.exec(stripTerminator(line));
const lineTerminator = (line) => (line.endsWith("\r") ? "\r" : "");
const stripTerminator = (line) => (line.endsWith("\r") ? line.slice(0, -1) : line);
// A block scalar turns everything more indented than its opening key into
// literal text, and a `run: |` body is where a workflow is written, quoted,
// and asserted on. A `uses:` or a `repository:`/`ref:` pair inside one is a
// sample of the shape, not the shape itself, and rewriting it edits a script
// or a fixture instead of a pin. Both rewrites below consult this, so a
// sample and a real key are treated the same way.
//
// Two properties decide whether this is safe, and both are load-bearing.
// The recorded indent is the indent of the MAPPING the scalar belongs to, not
// the indent of the physical line: a scalar opened by the first key of a
// sequence item (`- name: |`) still belongs to the item's mapping, and every
// sibling key of that step shares the item's content indent. Recording the
// line indent instead shields those siblings, so a real `uses:` or `ref:`
// stops moving while the rewrite reports nothing to change. The opener must
// also not match a comment, and `^(\s*)[^#]` does: `\s*` is greedy and
// backtracks, so `[^#]` lands on a space and any indented comment ending in a
// colon and a bar opens a block that shields real pins. Both of those
// produce a silent "already pinned", which is the one outcome worse than a
// wrong edit.
//
// The opener therefore names the key explicitly, so a comment cannot match
// it, and an optional sequence marker is captured so the mapping indent can
// be derived. A comment is also refused on its own, before the pattern runs,
// because a pattern cannot exclude one: the sequence marker is optional, so
// on `- # note: |` it backtracks to nothing and the key then accepts the
// `#`. A quoted key may contain a colon, and a sequence item may be a bare
// scalar, so both are in the key alternation. Tag and anchor properties are
// allowed before the indicator because `run: !!str |` and `run: &doc |` are
// block scalars too. Detecting a scalar remains a heuristic on the opening
// line; over-detecting skips lines that both rewrites would have matched
// only by an exact key prefix, so the cost of a false positive is a pin an
// operator carries by hand, never a wrong write. A false NEGATIVE is the
// expensive direction, so the pattern is written to match every legal block
// scalar header rather than a tidy subset of them.
const blockScalarOpener =
  /^[ \t]*(?:-[ \t]+)?(?:(?:"[^"]*"|'[^']*'|[^:'"#][^:]*):[ \t]*)?(?:[!&][^\s]*[ \t]*)*[|>][-+0-9]*[ \t]*(?:#.*)?$/;
// A comment may follow a sequence marker, which is ordinary YAML: a step
// whose whole entry is a comment is a legal step. It cannot be a key, so it
// cannot open a block scalar. See the opener above for why the pattern
// cannot be left to make this decision alone.
const blockScalarComment = /^[ \t]*(?:-[ \t]+)?#/;
const blockScalarLines = (lines) => {
  const literal = new Set();
  // The indent the block's content must exceed: the column of the mapping
  // that owns the scalar, which is past a sequence item's `- `.
  let openIndent = -1;
  for (const [index, line] of lines.entries()) {
    const body = stripTerminator(line);
    if (openIndent >= 0) {
      if (body.trim() === "") {
        continue;
      }
      const indent = body.length - body.trimStart().length;
      if (indent > openIndent) {
        literal.add(index);
        continue;
      }
      openIndent = -1;
    }
    if (blockScalarComment.test(body)) {
      continue;
    }
    const opener = blockScalarOpener.exec(body);
    if (opener) {
      // A sequence item's content starts after `- `, so a scalar opened by
      // the item's first key ends at the next sibling of that key rather
      // than at the next line of the item.
      const marker = /^[ \t]*-[ \t]+/.exec(body);
      openIndent = marker ? marker[0].length : body.length - body.trimStart().length;
    }
  }
  return literal;
};
const versionGrammar = /^v\d+\.\d+\.\d+$/;
// The version comment is a machine-readable contract, so the target version
// must be a release tag. The scheduled resolver emits only `vX.Y.Z` tags;
// this check also fails the standalone rewrite closed.
if (targetVersion && !versionGrammar.test(targetVersion)) {
  throw new Error(
    `Repins require a vMAJOR.MINOR.PATCH target version; got ${JSON.stringify(targetVersion)}.`
  );
}
const files = [];
const relativeToConsumer = (filePath) =>
  path.relative(directory, filePath).split(path.sep).join("/");
const visit = (entry) => {
  for (const item of fs.readdirSync(entry, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const itemPath = path.join(entry, item.name);
    // A symlink is followed on read and written through, so a workflow reached
    // through one would be edited outside the checkout the offer shows while
    // `git status` stays clean, and a symlinked directory would hide every pin
    // inside it so the run would report no change and close its own offer as
    // superseded. Neither is a reviewed surface, so refuse them by name.
    if (item.isSymbolicLink()) {
      throw new Error(
        `Repins refuse the symlink ${relativeToConsumer(itemPath)} under .github; a rewrite would ` +
          "either edit the file it points at instead of the reviewed checkout, or miss the pins " +
          "inside a linked directory and report no change at all."
      );
    }
    if (item.isDirectory()) {
      visit(itemPath);
    } else if (/\.(yml|yaml)$/.test(item.name)) {
      files.push(itemPath);
    }
  }
};
// `.github` is the one entry the walk below never sees inside itself, so it
// needs its own check. A committed symlink there would send the rewrite into
// a directory outside the reviewed checkout, and the report would name paths
// that do not exist in it.
const githubRoot = path.join(directory, ".github");
const githubStat = fs.lstatSync(githubRoot);
if (githubStat.isSymbolicLink() || !githubStat.isDirectory()) {
  throw new Error(
    "Repins refuse a .github that is not a directory in the reviewed checkout; a rewrite would " +
      "edit whatever it points at instead."
  );
}
visit(githubRoot);
const report = { changed: 0, uses: 0, refs: 0, files: [], skipped: [], unmatched: [], companions: [], unmatchedCompanions: [] };
const matchedExceptions = new Set();
// The pins this rewrite removes, from the workflow lines it rewrites. A
// checkout `ref:` naming this repository is such a pin, and it moves the same
// way. Only the workflow subset may move inside a pin-literal companion, so a
// historical SHA quoted for another reason survives untouched;
// `workflowReplacedPins` below takes that subset once the workflow pass is
// done.
const replacedPins = new Set();
// A consumer owns the gap between its pin and a `# vX.Y.Z` comment, because
// its own formatter owns that file. The enrolled repositories disagree:
// IshoBoy's yamllint sets `min-spaces-from-content: 2` and rejects one space
// as an error, while unity-helpers runs Prettier over `.github/` and rewrites
// two spaces back to one. A single canonical width therefore breaks one of
// them on every release, so the rewrite never normalizes the gap. It reads
// the gap this repository already uses and reuses it.
const versionCommentGaps = new Set();
// `linePattern` accepts any `\s` run before `#`, and `trim()` strips the
// Unicode spaces too, so a comment can pass the version test while carrying a
// gap that is not a space. Copying that gap is impossible and dropping it is
// worse: YAML reads a `#` with no separation space as part of the plain
// scalar, so the rewrite would fold `# vX.Y.Z` into the `uses:` value and the
// pin would then match nothing on any later run. A tab fails the same way from
// the other side: libyaml rejects a tab before a comment as a syntax error, so
// a tab is a space the consumer never wrote. A gap the rewrite cannot reproduce
// is evidence it must not touch, so it fails closed and names the file and
// line. Only a version comment needs this: a witness comment is written back
// verbatim and never re-formed.
const gapPattern = /^ +$/;
const commentGap = (comment, location) => {
  // Match the whole gap, not a prefix of it, so a gap that mixes a space with
  // another whitespace character is refused and reported as it really is.
  const gap = /^\s+/.exec(comment)[0];
  if (!gapPattern.test(gap)) {
    throw new Error(
      `${repository} ${location} separates its pin from \`${comment.trim()}\` with ` +
        `${JSON.stringify(gap)} instead of one or more spaces. Only a space separates a pin from a ` +
        "comment in YAML: libyaml rejects a tab as a syntax error, and a gap the rewrite cannot " +
        "reproduce risks folding the comment into the `uses:` value and hiding the pin from every " +
        "later run. Fix the comment by hand and repin again."
    );
  }
  return gap;
};
// Read every workflow file once and record the comment gaps the repository
// already uses. A file a reviewed `repinExceptions` entry protects is never
// rewritten, so it is neither evidence nor read: it cannot veto the run and
// it cannot fail the read.
const sources = [];
for (const filePath of files) {
  const relativePath = relativeToConsumer(filePath);
  const exception = exceptions.get(relativePath);
  if (exception) {
    matchedExceptions.add(relativePath);
    report.skipped.push({
      path: relativePath,
      owner: String(exception.owner || ""),
      expiresAt: String(exception.expiresAt || "")
    });
    continue;
  }
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  // A line inside a block scalar is a sample of a workflow, not a workflow,
  // so it is neither rewritten below nor read as comment-gap evidence.
  const literal = blockScalarLines(lines);
  sources.push({ filePath, relativePath, lines, literal });
  for (const [index, line] of lines.entries()) {
    if (literal.has(index)) {
      continue;
    }
    const match = matchPinLine(line);
    const comment = match ? match[3] || "" : "";
    if (comment !== "" && versionCommentPattern.test(comment.trim())) {
      versionCommentGaps.add(commentGap(comment, `${relativePath}:${index + 1}`));
    }
  }
}
// A moved pin without a version comment gains one, so Dependabot can read
// the release. That new comment needs a gap, and the only evidence is what
// the repository already writes. No precedent, or more than one gap in one
// file, is ambiguous evidence: a mechanical rewrite cannot tell which width the
// consumer's formatter accepts, so it fails closed and names the repository
// and the file instead of guessing. A repository that has no lock pin at all
// never reaches this path because it has no pin to move. `ownGaps` is the
// evidence from the single companion file being rewritten: a `pin-lines`
// companion keeps its own spacing even when the workflow pins use a different
// one, so the offered commit never leaves that file internally inconsistent.
const resolveVersionCommentGap = (location, ownGaps) => {
  // An empty Set carries no evidence, and an empty Set is truthy, so the size
  // check is what selects the workflow fallback.
  const gaps = ownGaps && ownGaps.size > 0 ? ownGaps : versionCommentGaps;
  if (gaps.size === 1) {
    return [...gaps][0];
  }
  const observed = [...gaps];
  const evidence = observed.length === 0
    ? "None of its lock pins carries a `# vX.Y.Z` comment."
    : `Its lock pins use ${observed.length} different comment gaps: ${observed
      .map((gap) => JSON.stringify(gap))
      .join(", ")}.`;
  throw new Error(
    `${repository} ${location} needs a version comment. ${evidence} The rewrite cannot match the ` +
      "repository's comment spacing, so it fails closed instead of guessing. Make the version " +
      "comments uniform in the repository's own format, then repin again."
  );
};
const rewritePinLine = (line, location, ownGaps) => {
  const match = matchPinLine(line);
  if (!match || match[2] === targetSha) {
    return line;
  }
  replacedPins.add(match[2]);
  // A moved pin updates its release comment: a `# vX.Y.Z` comment tracks the
  // new release, a missing comment gains one so every moved pin stays
  // human-readable and Dependabot-visible, and any other reviewed witness
  // comment survives untouched. An unknown target version changes no
  // comment: a stale version label is better evidence than a deleted one.
  const comment = match[3] || "";
  const rawComment = comment.trim();
  const terminator = lineTerminator(line);
  if (targetVersion && (rawComment === "" || versionCommentPattern.test(rawComment))) {
    const gap = comment === ""
      ? resolveVersionCommentGap(location, ownGaps)
      : commentGap(comment, location);
    return `${match[1]}${targetSha}${gap}# ${targetVersion}${terminator}`;
  }
  return `${match[1]}${targetSha}${comment}${terminator}`;
};
// A checkout `ref:` is a second spelling of the same pin, and it moves with
// it. The SHA alone proves nothing: qora-redux checks out `unity-helpers` at
// a literal commit in a `with:` block that looks identical, and rewriting that
// would point a different repository at this repository's release. So the
// rewrite is anchored on the sibling `repository:` key, read from the same
// `with:` block. Only direct children count, so a `ref:` nested under another
// key is not a sibling of `repository:` and never moves.
// A key may be quoted, may carry a space before its colon, and is matched
// without regard to case: GitHub reads an action's `with:` that way, so
// `"with":`, `'with':`, and `with :` are the same key to it and to a YAML
// reader. A key pattern that accepted only `word:` froze a real pin on
// every other spelling, and a stale pin with a green run is the outcome
// this rewrite must never produce.
const yamlKey = "\"[^\"]*\"|'[^']*'|[A-Za-z_][A-Za-z0-9_.-]*[ \t]*";
// A key may sit behind a sequence marker, because a step's first key is
// written as `- uses:`. The key's column is the indent plus that marker, and
// it is the column that decides what is a sibling of what, so both are
// captured rather than measured from the physical line.
const keyPattern = new RegExp(
  "^([ \\t]*)((?:-[ \\t]+)?)(" + yamlKey + "):(?:[ \\t]+(.*))?$"
);
// The column the key sits at, which is what a sibling shares: the line's own
// indent plus any sequence marker in front of it.
const keyIndentOf = (match) => match[1].length + match[2].length;
// `with:` opens the block mapping a checkout reads its inputs from. A
// comment may follow it: a step whose `with:` line carries a comment is
// ordinary YAML, and refusing it would freeze a real pin while the run
// reports the repository already pinned. A tag, an anchor, or a flow
// mapping on the same line is a different value and stays a documented
// limit, so the pattern ends at the comment.
const withPattern = new RegExp("^([ \\t]*)((?:-[ \\t]+)?)(" + yamlKey + "):[ \\t]*(?:#.*)?$", "i");
// A comment needs a space in front of it. Without one, YAML reads the `#`
// and everything after it as part of the plain scalar, so the value is not
// a commit and moving it would edit a line that is not a pin. The `uses:`
// path refuses that shape; the `ref:` path refuses it for the same reason.
const refValuePattern = /^([ \t]*[Rr][Ee][Ff][ \t]*:[ \t]+)([0-9a-f]{40})(?=[ \t]|$)([ \t]+#.*)?$/;
const lockRepository = lockPrefix.replace(/\/$/, "");
// The value is compared folded: a GitHub repository name is an identifier
// GitHub reads without regard to case, so a spelling that differs only in
// case names this repository and a pin left behind would be a real one.
const bareRepository = (value) => value.replace(/[ \t]+#.*$/, "").trim().toLowerCase();
const foldedLockRepository = lockRepository.toLowerCase();
// A quoted key is the same key to a YAML reader as its bare spelling, and
// YAML allows a space before the colon, which belongs to the key's text and
// not to its name. Both are folded here so a key is compared by its name.
const unquoteKey = (key) =>
  key.trim().replace(/^(?:"([^"]*)"|'([^']*)')$/, "$1$2").toLowerCase();
// The step has to be a checkout for `repository:` and `ref:` to be checkout
// inputs. Without this anchor the rule would move a `with:` pair that is
// something else entirely: a reusable-workflow call passes `repository` and
// `ref` to the called workflow as its own inputs, and any other action that
// takes both is free to mean something the rewrite cannot know. Every
// enrolled consumer that carries the shape uses `actions/checkout`, so
// anchoring on it narrows the rule to the one step the shape is written for.
const checkoutStepUses = /^actions\/checkout@[0-9a-f]{40}$/;
// The `uses:` that owns a `with:` block is a sibling of it, so the step is
// read from the block's own line upwards, stopping at the first line that
// leaves the step's mapping.
const opensACheckout = (lines, literal, start, blockIndent) => {
  for (let index = start - 1; index >= 0; index -= 1) {
    if (literal.has(index)) {
      continue;
    }
    const line = stripTerminator(lines[index]);
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    // The step ends at the first line whose own indent leaves the step's
    // column. The LINE's indent is the test rather than the key's, because
    // the first key of a step carries the sequence marker and its key column
    // sits two further right than the keys that follow it. A `uses:` written
    // on the marker line is therefore shallower than its own `with:`, and
    // the first key is read as a member of the step rather than as the end
    // of one.
    const key = keyPattern.exec(line);
    if (!key) {
      continue;
    }
    // A line that carries a sequence marker is a step of its own, and the
    // key in it sits past that marker. A line that does not is a key of the
    // step it is already inside. So the two are compared against the
    // `with:` column the way they are written, and a `uses:` on either
    // counts as the checkout that owns this block.
    if (key[2].length > 0) {
      if (key[1].length > blockIndent) {
        return false;
      }
    } else if (key[1].length < blockIndent) {
      return false;
    } else if (key[1].length > blockIndent) {
      continue;
    }
    if (unquoteKey(key[3]) === "uses" && checkoutStepUses.test((key[4] || "").trim())) {
      return true;
    }
  }
  return false;
};
// Collect the line indices a checkout `ref:` may move on. A `with:` block is
// a block mapping, so every direct child shares one indent: the first deeper
// line fixes it and the block ends at the first line at or above the `with:`
// indent. Blank and comment lines belong to no key and are skipped, and a
// line inside a block scalar is text rather than structure.
const refLineIndices = (lines, literal) => {
  const eligible = new Set();
  for (let start = 0; start < lines.length; start += 1) {
    if (literal.has(start)) {
      continue;
    }
    const withMatch = withPattern.exec(stripTerminator(lines[start]));
    if (!withMatch || unquoteKey(withMatch[3]) !== "with") {
      continue;
    }
    const blockIndent = keyIndentOf(withMatch);
    if (!opensACheckout(lines, literal, start, blockIndent)) {
      continue;
    }
    let childIndent = -1;
    const children = [];
    for (let index = start + 1; index < lines.length; index += 1) {
      // A `with:` inside a block scalar is not a `with:` block at all, and the
      // scan skips the opening line above, so nothing inside one is read here.
      const line = stripTerminator(lines[index]);
      if (line.trim() === "" || line.trimStart().startsWith("#")) {
        continue;
      }
      const key = keyPattern.exec(line);
      if (!key) {
        continue;
      }
      const indent = keyIndentOf(key);
      if (indent <= blockIndent) {
        break;
      }
      if (childIndent === -1) {
        childIndent = indent;
      }
      if (indent !== childIndent) {
        continue;
      }
      children.push({ index, key: key[3], value: (key[4] || "").replace(/\s+$/, "") });
    }
    if (!children.some((child) => unquoteKey(child.key) === "repository" && bareRepository(child.value) === foldedLockRepository)) {
      continue;
    }
    for (const child of children) {
      if (unquoteKey(child.key) === "ref" && refValuePattern.test(stripTerminator(lines[child.index]))) {
        eligible.add(child.index);
      }
    }
  }
  return eligible;
};
// Move a `ref:` by rewriting only its 40-character value. Nothing else on the
// line changes: a `ref:` is not a `uses:` pin, so Dependabot never reads it
// and no version comment is added. The SHA joins `replacedPins` for the same
// reason a `uses:` pin does, so a `pin-literal` companion quoting the policy
// commit can heal alongside the workflow that named it.
const rewriteRefLine = (line) => {
  const match = refValuePattern.exec(stripTerminator(line));
  if (!match || match[2] === targetSha) {
    return line;
  }
  replacedPins.add(match[2]);
  // The trailing comment is optional, so the group is absent when there is
  // none. Spelled out rather than templated, because an absent group in a
  // template literal is the text "undefined".
  return `${match[1]}${targetSha}${match[3] || ""}${lineTerminator(line)}`;
};
// Every write is buffered and flushed once, at the end, so every check fails
// closed before anything is written. A throw can come from a later workflow
// file, from a companion that is not a regular file, or from a companion that
// still names a stale pin, so flushing the workflow pass on its own would not
// be enough. A `writeFileSync` that fails inside the flush loop is the one case
// that cannot be atomic across files; it leaves the run red with no report, so
// the caller stages nothing and the clone is discarded.
const pendingWrites = [];
for (const source of sources) {
  let fileChanges = 0;
  // The `ref:` scan runs on the original lines, before any `uses:` pin moves,
  // so the sibling `repository:` it anchors on is the one the consumer wrote.
  const refLines = refLineIndices(source.lines, source.literal);
  const refChanges = new Set();
  const lines = source.lines.map((line, index) => {
    const rewrittenLine = source.literal.has(index)
      ? line
      : refLines.has(index)
        ? rewriteRefLine(line)
        : rewritePinLine(line, `${source.relativePath}:${index + 1}`);
    if (rewrittenLine !== line) {
      fileChanges += 1;
      if (refLines.has(index)) {
        refChanges.add(index);
      }
    }
    return rewrittenLine;
  });
  source.refChanges = refChanges;
  if (fileChanges === 0) {
    continue;
  }
  pendingWrites.push({ filePath: source.filePath, content: lines.join("\n") });
  report.changed += fileChanges;
  // The two mutations are reported apart because the pull request body names
  // which one happened, and a run that moves only a checkout `ref:` moved no
  // `uses:` reference.
  report.refs += [...source.refChanges].length;
  report.uses += fileChanges - source.refChanges.size;
  report.files.push({ path: source.relativePath, lines: fileChanges });
}
// Only a pin this rewrite removes from a workflow may move inside a
// pin-literal companion. A `pin-lines` companion can name the same SHA for its
// own reasons, and letting that widen the set would rewrite a reviewed witness
// in the pin-literal file and skip the stale-pin check below, which is the
// protection the comment above this set promises.
const workflowReplacedPins = new Set(replacedPins);
for (const [entryPath, entry] of exceptions) {
  if (!matchedExceptions.has(entryPath)) {
    report.unmatched.push({
      path: entryPath,
      owner: String(entry.owner || ""),
      expiresAt: String(entry.expiresAt || "")
    });
  }
}
// Only the reviewed allowlist keys mirror into consumer snapshots; any other
// approved*Shas key is an unreviewed boundary.
const reviewedCompanions = companions.map((companion) => {
  const companionPath = path.join(directory, ...companion.path.split("/"));
  let companionStat;
  try {
    companionStat = fs.lstatSync(companionPath);
  } catch (error) {
    // Only a missing entry means the companion is absent. A path whose parent
    // is a file, or one the checkout cannot read, is not the same fact, and
    // reporting it as absent would offer a commit that silently omits a
    // policy-required artifact.
    if (error.code !== "ENOENT") {
      throw error;
    }
    report.unmatchedCompanions.push({ path: companion.path, mode: companion.mode });
    return null;
  }
  if (!companionStat.isFile()) {
    // A symlink or directory here would make the rewrite write outside the
    // consumer checkout or fail obscurely later; refuse it by name instead.
    throw new Error(`The repin companion ${companion.path} is not a regular file.`);
  }
  return { ...companion, companionPath };
});
for (const companion of reviewedCompanions) {
  if (!companion) {
    continue;
  }
  const { companionPath } = companion;
  let companionChanges = 0;
  if (companion.mode === "pin-lines") {
    const lines = fs.readFileSync(companionPath, "utf8").split("\n");
    // A companion is its own file with its own formatter, so its own comments
    // are the first evidence for a comment it has to gain. The workflow set is
    // the fallback for a companion that carries no version comment at all.
    const ownGaps = new Set();
    for (const [index, line] of lines.entries()) {
      const match = matchPinLine(line);
      const comment = match ? match[3] || "" : "";
      if (comment !== "" && versionCommentPattern.test(comment.trim())) {
        ownGaps.add(commentGap(comment, `${companion.path}:${index + 1}`));
      }
    }
    const rewrittenLines = lines.map((line, index) => {
      const rewrittenLine = rewritePinLine(line, `${companion.path}:${index + 1}`, ownGaps);
      if (rewrittenLine !== line) {
        companionChanges += 1;
      }
      return rewrittenLine;
    });
    if (companionChanges > 0) {
      pendingWrites.push({ filePath: companionPath, content: rewrittenLines.join("\n") });
    }
  } else if (companion.mode === "pin-literal") {
    const original = fs.readFileSync(companionPath, "utf8");
    let updated = original;
    // Standalone tokens only: a SHA embedded in a longer hex constant is a
    // different reviewed value and must survive untouched.
    const replaceStandalone = (sha) =>
      updated.replace(new RegExp(`(?<![0-9a-fA-F])${sha}(?![0-9a-fA-F])`, "g"), () => targetSha);
    for (const replacedPin of [...workflowReplacedPins].sort()) {
      updated = replaceStandalone(replacedPin);
    }
    // A mechanical rewrite cannot tell a stale pin constant from a reviewed
    // historical witness, so it resolves neither and fails closed on both.
    // The check reads the rewritten text, because that is the state the offer
    // carries: a pin the replacement above healed now reads as the target, and
    // a companion that names the target holds a healed constant beside whatever
    // witness it also carries. A token that is still authorized, is not the
    // target, and is not the one any moved pin replaced was never a pin this
    // run healed, and one the rewrite cannot account for.
    const approvedLocks = lowered(policy.approvedLockShas);
    const standaloneTokens = [...updated.matchAll(/(?<![0-9a-fA-F])([0-9a-f]{40})(?![0-9a-fA-F])/g)]
      .map((match) => match[1]);
    const namesTarget = standaloneTokens.some((token) => token === targetSha);
    const unaccounted = standaloneTokens.some(
      (token) => token !== targetSha && approvedLocks.has(token)
    );
    if (unaccounted && !namesTarget) {
      throw new Error(
        `The pin-literal companion ${companion.path} still names an authorized pin that no ` +
          "workflow pin this rewrite removes accounts for. A mechanical edit cannot tell a " +
          "stale pin constant from a reviewed witness; review the companion and update it by hand."
      );
    }
    if (updated !== original) {
      companionChanges = 1;
      pendingWrites.push({ filePath: companionPath, content: updated });
    }
  } else if (companion.mode === "policy-snapshot") {
    // Mirror the reviewed allowlists exactly: the same content a consumer
    // snapshot refresh derives from this policy, so the diff a reviewer reads
    // is the authorization delta and nothing else.
    const snapshot = {
      schemaVersion: policy.schemaVersion,
      organization: policy.organization
    };
    for (const [key, value] of Object.entries(policy)) {
      if (reviewedSnapshotKeys.has(key)) {
        snapshot[key] = value;
      }
    }
    const original = fs.readFileSync(companionPath, "utf8");
    const updated = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (updated !== original) {
      companionChanges = 1;
      pendingWrites.push({ filePath: companionPath, content: updated });
    }
  }
  report.changed += companionChanges;
  report.companions.push({ path: companion.path, mode: companion.mode, lines: companionChanges });
}
for (const write of pendingWrites) {
  fs.writeFileSync(write.filePath, write.content, "utf8");
}
process.stdout.write(`${JSON.stringify(report)}\n`);
EOF
}

open_repin_pull_request() {
  # One pull request body and create call, shared by the fresh-push path and
  # the identical-branch recovery path. Arguments are explicit so the two
  # paths cannot drift.
  local repository="$1" branch_name="$2" label="$3" target_sha="$4"
  local authorization="$5" file_list="$6" preserved_section="$7" companion_section="$8"
  local uses_count="$9"
  local ref_count="${10}"
  local body_file
  body_file="$(mktemp "${RUNNER_TEMP:?RUNNER_TEMP is required}/repin-consumer-locks.XXXXXX")"
  # Each mutation gets its own bullet, and a mutation that did not happen
  # gets no bullet. A run that moves only a checkout `ref:` moved no `uses:`
  # reference, and a body that claims otherwise sends a reviewer looking for a
  # change the diff does not contain.
  local mutation_bullet=""
  if [ "${uses_count}" != "0" ]; then
    mutation_bullet="${mutation_bullet}- Only the \`@<sha>\` suffix of a \`uses:\` reference to
  \`${lock_repository_prefix%/*}\` changed, plus its \`# vX.Y.Z\` version comment
  (updated or added)."
  fi
  if [ "${ref_count}" != "0" ]; then
    mutation_bullet="${mutation_bullet}
- A checkout \`ref:\` naming \`${lock_repository_prefix%/*}\` moved to the same
  release."
  fi
  local references_section=""
  if [ -z "${file_list}" ]; then
    mutation_bullet="No \`uses:\` pin needed a change; this pull request carries reviewed companion artifacts only."
  else
    references_section="
- Changed references:
\`\`\`
${file_list}
\`\`\`"
  fi
  cat > "${body_file}" <<EOF
Repin the organization lock references to the authorized release ${label}
(\`${target_sha}\`).

## Review before merge (leaving auto-merge on is the adoption decision)

- ${mutation_bullet}
- Release authorization evidence: the central authorization pull request for
  this release, merged by a maintainer.
- The automation enables auto-merge on this pull request. The merge then
  fires only when every required check and merge rule passes. Disable
  auto-merge on this pull request to merge by hand instead.
${references_section}${companion_section}${preserved_section}
Central automation opens this pull request and enables auto-merge. It never
edits a default branch and never force-pushes.
EOF
  local pr_url
  if ! pr_url="$(GH_TOKEN="${authorization}" gh pr create \
    --repo "${repository}" \
    --head "${branch_name}" \
    --title "Repin organization lock references to ${label}" \
    --body-file "${body_file}")"; then
    echo "::error::${repository}: could not open the repin pull request." >&2
    exit 1
  fi
  rm -f "${body_file}"
  enable_repin_auto_merge "${repository}" "${authorization}" "${pr_url}"
}

enable_repin_auto_merge() {
  # Option 2 of issue 266: the offer merges itself once every consumer gate
  # passes, so adoption needs no click. The gates already are the review:
  # the enrollment audit fails closed on an unauthorized pin, and the
  # consumer's required contexts and merge rules still apply. The request is
  # one-time, made when the offer is created. A later consumer change, such
  # as disabling auto-merge on the pull request, is respected and never
  # undone. Every failure is best-effort: the offer stays open for a manual
  # merge, a warning names the gap in the job log, and a summary row keeps
  # it operator-visible.
  local repository="$1" authorization="$2" pr_url="$3"
  local pr_number
  if [[ "${pr_url}" =~ ^https://github.com/[^/]+/[^/]+/pull/([0-9]+)$ ]]; then
    pr_number="${BASH_REMATCH[1]}"
  else
    echo "::warning::${repository}: opened the repin offer but could not read its pull request URL; auto-merge was not requested." >&2
    printf '%s\n' "| \`${repository}\` | repin offer is open; auto-merge was not requested (see the job log) |" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
    return 0
  fi
  # An omitted mergeMethod defaults to merge commits, which many consumers
  # disallow. Read the allowed methods with the offer identity in one call
  # and prefer squash: each offer is one reviewed commit.
  local method_line
  if ! method_line="$(GH_TOKEN="${authorization}" gh api graphql \
    -f owner="${repository%%/*}" \
    -f name="${repository#*/}" \
    -F number="${pr_number}" \
    -f query='query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) { id }
        squashMergeAllowed
        mergeCommitAllowed
        rebaseMergeAllowed
      }
    }' \
    --jq '.data.repository as $r |
      (($r.squashMergeAllowed | not) and ($r.mergeCommitAllowed | not) and ($r.rebaseMergeAllowed | not)) as $noneAllowed |
      if ($r.pullRequest.id // "" | startswith("PR_") | not) or $noneAllowed then ""
      elif $r.squashMergeAllowed then "\($r.pullRequest.id)\tSQUASH"
      elif $r.mergeCommitAllowed then "\($r.pullRequest.id)\tMERGE"
      else "\($r.pullRequest.id)\tREBASE"
      end')"; then
    echo "::warning::${repository}: could not read the repin offer #${pr_number} identity; auto-merge was not requested." >&2
    printf '%s\n' "| \`${repository}\` | repin offer #${pr_number} is open; auto-merge was not requested (see the job log) |" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
    return 0
  fi
  local pr_id merge_method
  pr_id="${method_line%%$'\t'*}"
  merge_method="${method_line#*$'\t'}"
  if [ -z "${merge_method}" ] || [ "${merge_method}" = "${method_line}" ]; then
    echo "::warning::${repository}: repin offer #${pr_number} has no readable identity or no allowed merge method; auto-merge was not requested." >&2
    printf '%s\n' "| \`${repository}\` | repin offer #${pr_number} is open; auto-merge was not requested (see the job log) |" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
    return 0
  fi
  # The mutation schema only accepts these merge methods, so an unexpected
  # value takes the not-requested path instead of a malformed request.
  if ! [[ "${merge_method}" =~ ^(SQUASH|MERGE|REBASE)$ ]]; then
    echo "::warning::${repository}: repin offer #${pr_number} has no readable identity or no allowed merge method; auto-merge was not requested." >&2
    printf '%s\n' "| \`${repository}\` | repin offer #${pr_number} is open; auto-merge was not requested (see the job log) |" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
    return 0
  fi
  if ! GH_TOKEN="${authorization}" gh api graphql \
    -f id="${pr_id}" \
    -f method="${merge_method}" \
    -f query='mutation($id: ID!, $method: PullRequestMergeMethod!) {
      enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $method}) { pullRequest { number } }
    }' \
    --jq '.data.enablePullRequestAutoMerge.pullRequest.number' >/dev/null; then
    echo "::warning::${repository}: repin offer #${pr_number} is open but auto-merge was not enabled; the offer waits for a manual merge. Common causes: the repository setting \`Allow auto-merge\` is off, or the ${merge_method} merge method is disallowed." >&2
    printf '%s\n' "| \`${repository}\` | repin offer #${pr_number} is open; auto-merge was not enabled (see the job log) |" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
    return 0
  fi
}

close_superseded_offers() {
  # The rewrite moved no pin, so no permitted lock-pin change remains to
  # reach the authorized release. An open repin offer is then superseded: it
  # offers a pin move the default branch already satisfies or outruns. Close
  # every open offer on the automation's exact branch grammar
  # `automation/repin-lock-<7 hex>`. Offers on any other branch name are
  # never this automation's, so the grammar filter protects them. A closed
  # offer never re-opens, the branch stays untouched, and a future release
  # opens a new offer.
  local repository="$1" label="$2" target_sha="$3" authorization="$4"
  local scan_bound=100 listing marker_line page_size open_offers
  # gh pr list rejects --limit 0 and caps its default page at 30 items, so
  # the scan asks for a bounded page of 100. A busy repository can hold a
  # full page of unrelated open pull requests, and then no page of this
  # size can prove the offer list is complete, so the scan fails closed
  # there instead of closing offers from a possibly truncated list; raising
  # the bound is the remedy, not a silent partial close. The first output
  # line reports the page size, the rest are the automation-branch offers.
  if ! listing="$(GH_TOKEN="${authorization}" gh pr list \
    --repo "${repository}" \
    --state open \
    --limit "${scan_bound}" \
    --json number,headRefName \
    --jq '([(length | tostring), "page-size"] | @tsv),
      (.[] | select(.headRefName | test("^automation/repin-lock-[0-9a-f]{7}$")) | [(.number | tostring), .headRefName] | @tsv)')"; then
    echo "::error::${repository}: could not list open repin offers." >&2
    return 1
  fi
  # Command substitution strips the trailing newline. Parameter expansion
  # separates the marker from a lone-marker listing; the offer stream is
  # split through tail, which always reads its full input.
  marker_line="${listing%%$'\n'*}"
  page_size="${marker_line%%$'\t'*}"
  if ! open_offers="$(printf '%s\n' "${listing}" | tail -n +2)"; then
    echo "::error::${repository}: could not split the offer list." >&2
    return 1
  fi
  # A leading zero would make the arithmetic comparison read the value as
  # octal, so the bound check could silently pass; reject it here.
  case "${page_size}" in
    '' | 0[0-9]* | *[!0-9]*)
      echo "::error::${repository}: unreadable offer-scan page marker." >&2
      return 1
      ;;
  esac
  if [ "${page_size}" -ge "${scan_bound}" ]; then
    echo "::error::${repository}: the open pull request page hit the ${scan_bound} item bound; the offer list may be truncated. Raise the scan bound or reduce the open pull request count." >&2
    return 1
  fi
  local closed=0 offer_number offer_branch
  while IFS=$'\t' read -r offer_number offer_branch; do
    [ -n "${offer_number}" ] || continue
    # Defense in depth for the close mutation: the jq filter already
    # applied the branch grammar, and a parse drift here would otherwise
    # close an unrelated pull request number.
    if ! [[ "${offer_branch}" =~ ^automation/repin-lock-[0-9a-f]{7}$ ]]; then
      echo "::error::${repository}: offer list row (${offer_number}, ${offer_branch}) left the automation branch grammar; closing nothing." >&2
      return 1
    fi
    if ! GH_TOKEN="${authorization}" gh pr close "${offer_number}" \
      --repo "${repository}" \
      --comment "No permitted lock-pin change remains to reach the authorized
release ${label} (\`${target_sha}\`). This offer is superseded, so the
automation closes it. A future release opens a new offer." >/dev/null; then
      echo "::error::${repository}: could not close superseded repin offer #${offer_number} (${offer_branch})." >&2
      return 1
    fi
    closed=$((closed + 1))
  done <<< "${open_offers}"
  if [ "${closed}" != "0" ]; then
    echo "${repository}: closed ${closed} superseded repin offer(s); no permitted lock-pin change remains to reach ${label}." >&2
  fi
  printf '%s\n' "${closed}"
}

repin_consumer() {
  # The caller inspects this function's result, which makes bash ignore
  # errexit for the whole body, including subshells. Every fallible command
  # therefore carries an explicit status guard; a tolerated failure here
  # would be a false-success repin report.
  (
    local repository="$1" branch="$2" target_sha="$3" target_version="$4" authorization="$5"
    local directory="consumers/${repository#*/}"
    local label="${target_version:-${target_sha:0:7}}"
    local branch_name="automation/repin-lock-${target_sha:0:7}"
    rm -rf "${directory}"
    if ! GH_TOKEN="${authorization}" gh repo clone "${repository}" "${directory}" -- \
      --branch "${branch}" \
      --single-branch \
      --no-tags \
      --depth 1; then
      echo "::error::${repository}: could not clone ${branch}." >&2
      exit 1
    fi
    local report
    if ! report="$(rewrite_pins "${directory}" "${target_sha}" "${target_version}" "${repository}")"; then
      echo "::error::${repository}: could not rewrite the lock references." >&2
      exit 1
    fi
    local changed
    if ! changed="$(printf '%s' "${report}" | jq -er '.changed')"; then
      echo "::error::${repository}: could not read the rewrite report." >&2
      exit 1
    fi
    # Both counters come from the same report, so one reader keeps them
    # honest. A missing or non-numeric count is a malformed report, not a
    # count of zero: reading it as zero would let the pull request body
    # describe a mutation the diff contains.
    local uses_count ref_count
    if ! uses_count="$(printf '%s' "${report}" | jq -er '.uses | numbers')" ||
      ! ref_count="$(printf '%s' "${report}" | jq -er '.refs | numbers')" ||
      [[ ! "${uses_count}" =~ ^[0-9]+$ ]] || [[ ! "${ref_count}" =~ ^[0-9]+$ ]]; then
      echo "::error::${repository}: could not read the rewrite counts from the report." >&2
      exit 1
    fi
    local preserved preserved_count
    if ! preserved="$(printf '%s' "${report}" | jq -r '
      .skipped[] | "- `\(.path)` preserved; reviewed by \(.owner) until \(.expiresAt)"
    ')" || ! preserved_count="$(printf '%s' "${report}" | jq -er '.skipped | length')"; then
      echo "::error::${repository}: could not read the rewrite report." >&2
      exit 1
    fi
    local unmatched
    if ! unmatched="$(printf '%s' "${report}" | jq -r '
      .unmatched[] | "- `\(.path)` names a repin exception but no file exists at that path; remove the exception"
    ')" || ! printf '%s' "${report}" | jq -e '.unmatched' >/dev/null; then
      echo "::error::${repository}: could not read the rewrite report." >&2
      exit 1
    fi
    local companions
    if ! companions="$(printf '%s' "${report}" | jq -r '
      .companions[] | select(.lines > 0) | "- `\(.path)` (\(.mode))"
    ')" || ! printf '%s' "${report}" | jq -e '.companions' >/dev/null; then
      echo "::error::${repository}: could not read the rewrite report." >&2
      exit 1
    fi
    local unmatched_companions
    if ! unmatched_companions="$(printf '%s' "${report}" | jq -r '
      .unmatchedCompanions[] | "- `\(.path)` (\(.mode)) names a repin companion but no file exists at that path; review the enrollment policy entry"
    ')" || ! printf '%s' "${report}" | jq -e '.unmatchedCompanions' >/dev/null; then
      echo "::error::${repository}: could not read the rewrite report." >&2
      exit 1
    fi
    if [ -n "${preserved}" ]; then
      printf '%s\n' "${preserved}"
    fi
    if [ -n "${unmatched}" ]; then
      printf '%s\n' "${unmatched}" >&2
    fi
    if [ -n "${unmatched_companions}" ]; then
      printf '%s\n' "${unmatched_companions}" >&2
    fi
    local companion_section=""
    if [ -n "${companions}" ] || [ -n "${unmatched_companions}" ]; then
      companion_section="
## Reviewed companion artifacts

These policy-reviewed files derive their content from the pin. Each changed
file moved through its reviewed mechanical rewrite:

${companions}
"
      if [ -n "${unmatched_companions}" ]; then
        companion_section="${companion_section}
### Missing companion files

${unmatched_companions}
"
      fi
    fi
    # The rewrite moved nothing: no permitted lock-pin change remains to
    # reach the authorized release.
    if [ "${changed}" = "0" ]; then
      local superseded_count
      if ! superseded_count="$(close_superseded_offers "${repository}" "${label}" "${target_sha}" "${authorization}")"; then
        echo "::error::${repository}: could not close the superseded repin offers." >&2
        exit 1
      fi
      local superseded_note=""
      if [ "${superseded_count}" != "0" ]; then
        superseded_note="; closed ${superseded_count} superseded repin offer(s)"
      fi
      if [ "${preserved_count}" != "0" ]; then
        printf '%s\n' "| \`${repository}\` | already pinned to \`${label}\`; ${preserved_count} file(s) preserved by reviewed repin exceptions${superseded_note} |" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
      else
        printf '%s\n' "| \`${repository}\` | already pinned to \`${label}\`${superseded_note} |" >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
      fi
      exit 0
    fi
    local open_prs
    if ! open_prs="$(GH_TOKEN="${authorization}" gh pr list \
      --repo "${repository}" \
      --head "${branch_name}" \
      --state open \
      --json number \
      --jq length)" || ! [[ "${open_prs}" =~ ^[0-9]+$ ]]; then
      echo "::error::${repository}: could not list open repin pull requests." >&2
      exit 1
    fi
    if [ "${open_prs}" != "0" ]; then
      printf '%s\n' "| \`${repository}\` | repin pull request for \`${label}\` is already open |" >> "${GITHUB_STEP_SUMMARY}"
      exit 0
    fi
    local closed_prs
    if ! closed_prs="$(GH_TOKEN="${authorization}" gh pr list \
      --repo "${repository}" \
      --head "${branch_name}" \
      --state closed \
      --json number \
      --jq length)" || ! [[ "${closed_prs}" =~ ^[0-9]+$ ]]; then
      echo "::error::${repository}: could not list closed repin pull requests." >&2
      exit 1
    fi
    if [ "${closed_prs}" != "0" ]; then
      # Merging or closing the repin pull request is final for that target,
      # whoever closed it: a consumer close is a decline, and an automation
      # close removed a superseded offer. Re-offering would override that
      # state, so the repository is skipped and the summary records it. The
      # branch stays in place, so a manual reopen can restore an offer.
      printf '%s\n' "${repository}: a repin pull request for ${label} was closed; the automation left the closed repin pull request in place." >&2
      printf '%s\n' "| \`${repository}\` | repin pull request for \`${label}\` was closed; a closed offer is never re-offered |" >> "${GITHUB_STEP_SUMMARY}"
      exit 0
    fi
    if ! git -C "${directory}" checkout -B "${branch_name}"; then
      echo "::error::${repository}: could not create ${branch_name}." >&2
      exit 1
    fi
    git -C "${directory}" config user.name "github-actions[bot]"
    git -C "${directory}" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git -C "${directory}" add .github
    # Companion paths are validated normalized repository-relative paths with
    # no option-like leading dash, so the explicit -- guard is sufficient.
    local companion_paths
    if ! companion_paths="$(printf '%s' "${report}" | jq -r '.companions[] | select(.lines > 0) | .path')"; then
      echo "::error::${repository}: could not read the companion paths from the rewrite report." >&2
      exit 1
    fi
    while IFS= read -r companion_path; do
      if [ -z "${companion_path}" ]; then
        continue
      fi
      if ! git -C "${directory}" add -- "${companion_path}"; then
        echo "::error::${repository}: could not stage the companion artifact ${companion_path}." >&2
        exit 1
      fi
    done <<< "${companion_paths}"
    if git -C "${directory}" diff --cached --quiet; then
      echo "::error::${repository}: staged repin is empty but ${changed} lines were rewritten." >&2
      exit 1
    fi
    if ! git -C "${directory}" commit -m "chore: repin organization lock references to ${label}"; then
      echo "::error::${repository}: could not commit the repin." >&2
      exit 1
    fi
    local file_list
    file_list="$(printf '%s' "${report}" | jq -r '.files[] | "- `\(.path)` (\(.lines) line\(if .lines == 1 then "" else "s" end))"' )"
    local preserved_section=""
    if [ "${preserved_count}" != "0" ]; then
      preserved_section="
## Preserved compatibility exceptions

These files kept their current pins. A reviewed repin exception protects each
caller because a pin-only update would break its input contract:

${preserved}
"
    fi
    local remote_tip
    if ! remote_tip="$(CONSUMER_PUSH_AUTHORIZATION="${authorization}" git -C "${directory}" \
      -c credential.helper= \
      -c 'credential.helper=!f() { printf "username=build-lock-repin\npassword=%s\n" "${CONSUMER_PUSH_AUTHORIZATION}"; }; f' \
      ls-remote "https://github.com/${repository}.git" "refs/heads/${branch_name}" |
      cut -f1)" || [[ "${remote_tip}" =~ [^0-9a-f] ]]; then
      echo "::error::${repository}: could not read the remote repin branch state." >&2
      exit 1
    fi
    if [ -n "${remote_tip}" ]; then
      # The branch already exists without an open or closed pull request: a
      # previous run pushed it but could not open the pull request. Reuse it
      # only when its content is exactly this repin's content. The automation
      # never force-updates a branch that holds other work.
      if ! CONSUMER_PUSH_AUTHORIZATION="${authorization}" git -C "${directory}" \
        -c credential.helper= \
        -c 'credential.helper=!f() { printf "username=build-lock-repin\npassword=%s\n" "${CONSUMER_PUSH_AUTHORIZATION}"; }; f' \
        fetch --depth 1 "https://github.com/${repository}.git" "${branch_name}"; then
        echo "::error::${repository}: could not fetch the existing repin branch." >&2
        exit 1
      fi
      local remote_tree local_tree
      if ! remote_tree="$(git -C "${directory}" rev-parse 'FETCH_HEAD^{tree}')" ||
        ! local_tree="$(git -C "${directory}" rev-parse 'HEAD^{tree}')"; then
        echo "::error::${repository}: could not compare the existing repin branch content." >&2
        exit 1
      fi
      if [ "${remote_tree}" != "${local_tree}" ]; then
        printf '%s\n' "${repository}: an existing repin branch holds different content; the automation left the stale repin branch untouched." >&2
        printf '%s\n' "| \`${repository}\` | existing repin branch has different content; left untouched |" >> "${GITHUB_STEP_SUMMARY}"
        exit 0
      fi
      open_repin_pull_request \
        "${repository}" "${branch_name}" "${label}" "${target_sha}" \
        "${authorization}" "${file_list}" "${preserved_section}" "${companion_section}" \
        "${uses_count}" "${ref_count}"
      printf '%s\n' "| \`${repository}\` | opened repin pull request to \`${label}\` from the existing branch |" >> "${GITHUB_STEP_SUMMARY}"
      exit 0
    fi
    if ! CONSUMER_PUSH_AUTHORIZATION="${authorization}" git -C "${directory}" \
      -c credential.helper= \
      -c 'credential.helper=!f() { printf "username=build-lock-repin\npassword=%s\n" "${CONSUMER_PUSH_AUTHORIZATION}"; }; f' \
      push "https://github.com/${repository}.git" "${branch_name}"; then
      echo "::error::${repository}: could not push ${branch_name}." >&2
      exit 1
    fi
    open_repin_pull_request \
      "${repository}" "${branch_name}" "${label}" "${target_sha}" \
      "${authorization}" "${file_list}" "${preserved_section}" "${companion_section}" \
      "${uses_count}" "${ref_count}"
    local lines_word="lines"
    if [ "${changed}" = "1" ]; then
      lines_word="line"
    fi
    if [ "${preserved_count}" != "0" ]; then
      printf '%s\n' "| \`${repository}\` | opened repin pull request to \`${label}\` (${changed} ${lines_word}; ${preserved_count} file(s) preserved) |" >> "${GITHUB_STEP_SUMMARY}"
    else
      printf '%s\n' "| \`${repository}\` | opened repin pull request to \`${label}\` (${changed} ${lines_word}) |" >> "${GITHUB_STEP_SUMMARY}"
    fi
  )
}

repin_consumers() {
  local authorization="${CONSUMER_AUTHORIZATION:?CONSUMER_AUTHORIZATION is required}"
  : "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
  local target_line target_sha target_version
  if ! target_line="$(resolve_repin_target)"; then
    echo "::error::Could not resolve the repin target from the reviewed policy." >&2
    exit 1
  fi
  target_sha="${target_line%%$'\t'*}"
  target_version="${target_line##*$'\t'}"
  local failed=false
  local repository branch
  while IFS=$'\t' read -r repository branch; do
    if ! repin_consumer "${repository}" "${branch}" "${target_sha}" "${target_version}" "${authorization}"; then
      printf '%s\n' "| \`${repository}\` | failed; see the job log |" >> "${GITHUB_STEP_SUMMARY}"
      failed=true
    fi
  done < <(jq -r '.repositories[] | [.repository, .defaultBranch] | @tsv' "${policy_path}")
  if [ "${failed}" = true ]; then
    echo "::error::At least one consumer repin failed; the run is red so the gap stays visible." >&2
    exit 1
  fi
}

case "${1:-}" in
  resolve-scope) resolve_scope ;;
  rewrite-pins)
    shift
    rewrite_pins "$@"
    ;;
  repin-consumers) repin_consumers ;;
  *)
    echo "usage: $0 <resolve-scope|rewrite-pins <directory> <target-sha> <target-version> <repository>|repin-consumers>" >&2
    exit 2
    ;;
esac
