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

It also applies to every reader that decides from evidence:

- the enrollment audit, the merge-policy audit, and the onboarding
  command all read the reviewed policy through one parser,
- the merge-policy audit reads its expectations and each consumer's
  published attestation through one parser each,
- the merge-policy audit reads GitHub responses through one decoder,
- the Unity automation audit reads a consumer checkout,
- the enrollment audit reads a git tree.

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
// The parser owns the refusal, so every reader answers the same way.
func ParseUnityEnrollmentRegistry(content []byte) (UnityEnrollmentRegistry, error) {
	if len(content) == 0 || len(content) > MaxUnityEnrollmentPolicyBytes {
		return UnityEnrollmentRegistry{}, fmt.Errorf("unity enrollment policy size is invalid")
	}
	if !utf8.Valid(content) {
		return UnityEnrollmentRegistry{}, fmt.Errorf("unity enrollment policy is not valid UTF-8")
	}
	// ... decode
}
```

A caller keeps no copy of this rule. A second copy is a second answer,
and the two drift. A caller that needs a different scope owns a
different function, not a copy of the check.

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

Measured in 2026-10 on the same class, one byte inside a reviewed policy: the
enrollment audit printed "policy is valid" and exited 0, the registry and a
consumer attestation accepted corrupted free-text values that no validator
inspects, and the merge-policy audit published `complete: true` for a
repository whose live check context carried such a byte, with a finding that
named the wrong cause.

The refusals now sit in the parsers and in the one response decoder. A reader
refuses and names the encoding in its own error, and the published finding
keeps the stable reason code it always had, so a consumer-facing alert does not
change shape.

## A pattern match decodes too

`regexp` treats its input as UTF-8 code points, and a byte it cannot decode
becomes U+FFFD. A literal pattern then stops matching, because the text it sees
is not the text on disk.

Measured in 2026-10: a consumer workflow whose only Unity literal carried one
`0xFF` byte passed the Unity automation audit, while the clean spelling fails
it. A safety scan that cannot read a file exactly is not evidence that it
contains nothing, so it refuses the file and names it.

A raw path and a raw file body are the same problem. A git tree can name a
file with a byte no decoder can read, and a checked-in script is matched by
literal needles. The snapshot now refuses the path and the body, which is the
shape an operator can act on: one repository is reported as unreadable and the
rest of the audit still runs.

## What a byte check cannot see

A byte check sees bytes. A JSON escape is not a byte the decoder cannot
read: `"\ud800"` is six valid ASCII bytes, and `utf8.Valid` accepts the
file. The decoder then substitutes U+FFFD, because it has no
representation for that code point, and returns no error.

So the byte check is necessary and not sufficient. A value the decoder
cannot represent is a second door to the same destruction. Measure the
second door before calling the first one closed.

A second door needs its own check. It is not the check you would
reach for first.

Do not test whether the decoded value round-trips. That test passes
on the defect. A substituted U+FFFD and a real U+FFFD are the same
three bytes.

The decision has to read the escape in the bytes. A lone surrogate
is a value the decoder has no name for. A high surrogate must be
followed by its partner. A low surrogate that no high surrogate used
is unpaired.

```go
// A caller keeps no copy of this rule, so the rule has one home.
// Refusal names the reader, and the reason travels as an error value
// so a later step can publish the cause without the message around it.
if err := jsonstrict.Refusal("unity enrollment policy", content); err != nil {
    return Registry{}, err
}
```

Run the check after the decode, not before. The decoder owns a
malformed file and names its syntax error. A check placed earlier
reports a cause the operator cannot act on.

A refusal nobody can act on is a weak evidence set. When a reader
knows what it was reading, it puts that name in the refusal, and the
cause stays recoverable through a wrapping `%w`:

```go
return nil, fmt.Errorf("read active rules: %w", jsonstrict.Label("active rules response", err))

// Elsewhere, publishing the cause and nothing else:
cause := jsonstrict.Reason(retrievalErr)
```

Keep the reason clause inside the alphabet the publishing validator
accepts. A reason that holds one character outside it makes the whole
artifact fail validation, and the cause is lost with it. Pin every
published reason in a test that runs the validator, not only in the
package that defines it.

Measure the other readers. Do not assume they all lose the value. This
repository's Go readers substituted the value. Node did not, because a
JavaScript string holds a lone surrogate and `JSON.stringify` writes it
back as an escape. `jq` stopped on an escaped high surrogate but
substituted an escaped low surrogate. One defect, three answers, and the
readers disagreed on half of it.

Related: `testing-and-validation` owns the red result a regression test needs.
`operations-and-documentation` owns the operational contract that records a
refusal and its scope.
