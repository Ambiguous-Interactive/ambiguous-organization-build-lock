<!-- summary: Byte-safe pattern for a tool that reads a file and writes it back. -->
# Text Rewrite Byte Safety

A tool that reads a file as text and writes it back changes bytes it never
named. It has to read bytes and decode them strictly.

This applies to every rewrite in this repository:

- the consumer repin,
- the release authorization,
- the enrollment onboarding,
- the lock state and its history,
- the LLM harness catalog.

## The defect

`readFileSync(path, "utf8")` replaces every byte Node cannot decode with
U+FFFD, which is three bytes long. Go's `encoding/json` does the same inside
a string, and returns no error.

A rewrite then commits a destroyed byte. It also reports only the edits it
meant to make, so the destruction hides behind a count.

Observed in 2026-09: a 173-byte consumer companion came back as 175 bytes.
`0x89` became `ef bf bd`. The run exited 0.

A sweep for the same shape found five files to change. One of them hid a
credential finding in a `progress/` record.

## The pattern

Read bytes. Decode with a fatal decoder. Refuse a file it cannot read.

```js
const { TextDecoder } = require("node:util");

// `ignoreBOM` matters only where the decoded text is used. It is inert
// where the text is discarded. See the mark section.
const decodeUtf8 = new TextDecoder("utf-8", { fatal: true });

const readTextFile = (filePath) => {
  const bytes = fs.readFileSync(filePath);
  const text = bytes.toString("utf8");
  const byteOrderMark = /^\uFEFF+/.exec(text)?.[0] || "";
  return { bytes, byteOrderMark, text: text.slice(byteOrderMark.length) };
};

// Call this where a file is queued for writing, never where it is read.
const queueWrite = (file, content, location) => {
  try {
    decodeUtf8.decode(file.bytes);
  } catch {
    throw new Error(
      `${location} is not valid UTF-8, so this rewrite cannot read it. Node replaces ` +
        "every byte it cannot decode with U+FFFD, so writing the file back would destroy a " +
        "byte the pin does not name. Re-save the file as UTF-8 and repin again."
    );
  }
  // This carries a mark into every file, JSON included. See the section on
  // the file kind for the case where that is wrong.
  pendingWrites.push({
    filePath: file.filePath,
    content: file.byteOrderMark + content
  });
};
```

```go
if !utf8.Valid(content) {
    return errors.New(
        "cannot read Unity enrollment policy: the file is not valid UTF-8")
}
```

## Refuse at the write, not at the read

Only a written file can lose a byte. A file the tool reads and leaves alone has
nothing to destroy, so refusing it is a false positive.

A permanent blocker on unrelated files is worse than the defect. A policy entry
rarely exempts one.

Queue every write through one guarded helper. The helper runs before the flush,
so a refusal leaves every file untouched. That is what makes the refusal atomic
across the checkout.

## The byte order mark

Two decoder defaults differ, and both decide the outcome.

`TextDecoder` strips a leading U+FEFF by default. Pass `ignoreBOM: true` to
keep it. Without the option the rewrite destroys three bytes it never named.

`readFileSync(path, "utf8")` keeps the mark. A key pattern then matches nothing
on the first line. A real pin stays frozen, and the run reports the repository
already pinned.

So carry the mark aside, read the text without it, and write the mark back.
Carry the whole run of leading marks, not one.

## The file kind decides whether a mark is carried

The reason is byte preservation. A mark is encoding metadata, not content, so
dropping it destroys three bytes the pin does not name. That is why the
consumer rewrite keeps one.

JSON is different. A mark is invalid JSON, and both reader families refuse it.
Node reports an unexpected token. Go reports `invalid character '\ufeff'`. A
rewrite that carries a mark into JSON makes a case that used to fail succeed.
It commits a file the repository's own audits reject on the next run.

`jq` accepts a mark. Name the readers that refuse one. Do not write that every
reader does.

## A read you never write is not automatically safe

A lossy decode is safe where no write follows and the file's own parser fails
closed. `JSON.parse` rejects a substitution in some positions and not in
others. It rejects the substitution wherever a token has to begin, and in a
number. It accepts it anywhere inside a quoted string, including a key, and
returns no error.

That gap hid a real defect here. The peer timeline read a holder id through a
lossy decode. One undecodable byte in that id produced a peer identity that did
not exist, with no error and no gap. The comment above `base64DecodeStateOrNull` in
`.github/dist/build-lock.js` records it. `readLockConfig` has the same shape
and does fail closed, but only because its fields are numbers and booleans.

A read-only path is therefore safe by position, not by rule. A credential
pattern is a literal, and a substitution breaks it. The `progress/` audit
decodes strictly for that reason.

Related: `testing-and-validation` owns the red result a regression test needs.
`operations-and-documentation` owns the operational contract that records a
refusal and its scope.
