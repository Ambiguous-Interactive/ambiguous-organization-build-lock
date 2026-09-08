# Session 075 -- the Darwin trusted return, landed on today's main

Half of #153. The Windows-container half is untouched and stays open.

## What was missing

`return-unity-license` is the only action allowed to attest that a paid Unity licence went back.
Its verification is Windows-only, so a Darwin job cannot use it, and `unity-builder#14` retired
organization-credentialed macOS integration rather than let one run unproven. #153 asks for a
"centrally owned, bounded macOS return implementation with immutable editor resolution and a
defensible publisher/code-identity check."

## What this adds

One Darwin branch through the same four controls the Windows path already has, so the two read side
by side rather than as two designs.

| control | Windows | Darwin |
| --- | --- | --- |
| editor resolution | `<tool-cache>/u6-v3/<version>/Editor/Unity.exe` | the Mach-O inside the bundle, same root |
| no substitution by link | `assertNoReparsePath`, unchanged | the same walk, already platform-neutral |
| code identity | Authenticode: Valid, thumbprint in an allowlist, EKU 1.3.6.1.5.5.7.3.3 | `codesign --verify --strict -R` against a designated requirement |
| descendant termination | `taskkill /PID <pid> /T /F` | the editor is spawned detached and the **process group** is signalled |

**The identity check is a requirement, not a parse.** The Darwin verdict is `codesign`'s exit code
against

```
anchor apple generic
  and certificate 1[field.1.2.840.113635.100.6.2.6] exists
  and certificate leaf[field.1.2.840.113635.100.6.1.13] exists
  and certificate leaf[subject.OU] = "<team>"
```

which pins the same three things the Windows script does -- an Apple-rooted chain, the Developer ID
code-signing usage, and one identity -- and pins them where the operating system evaluates them.
Nothing in the verdict is computed from output this action reads, which is the property the Windows
side has and the one worth keeping.

**Process-group isolation is the part a reviewer should look at hardest.** `taskkill /T` walks a
tree; a signal to a pid does not. The editor is therefore spawned `detached` on Darwin so it leads
its own group, and termination signals `-pid`. Without that, a `codesign` or editor child outliving
its parent keeps the seat, which is exactly the failure #153 names.

## The identity is measured, and what it is not

`UNITY_DARWIN_TEAM_IDS` holds one value, `9QW8UQUTAA`, and it was **measured rather than
recalled**: it is the `UID`/`OU` on the Developer ID **Installer** certificate in the xar table of
contents of `MacEditorInstaller/Unity.pkg`. The comment at `return-unity-license.js:24-45` records
that provenance beside the constant.

**The gate reads a different certificate.** It checks the Developer ID **Application**
certificate on `Unity.app/Contents/MacOS/Unity`. A team identifier names the account rather than
the certificate purpose, so both should carry the same OU -- but that is an inference, and #229's
canary is what settles it. A wrong value can only refuse a return, never accept one: the
requirement independently demands `anchor apple generic` and the Developer ID Application marker.

The identifier is a reviewed constant rather than an input, because #153 says caller-selected
identity is not cleanup authority.

## What this session added on top: the requirement is now compiled, not just spelled

`verifyDarwinUnityEditor` maps **every** non-zero `codesign` exit to one message,
`"Unity editor signature verification failed."` A syntax error in the requirement text therefore
reads exactly like a signature that did not match, and the gate would refuse every Darwin return
forever while looking like it was working. Worse, the canary in #229 would report that failure and
it would read as *"the team identifier is wrong"* -- the one conclusion the canary exists to draw.

Twelve unit cases assert the argv this action builds. **An argv is not a proof that the string
inside it means anything to `csreq(5)`**, and nothing anywhere asked the macOS requirement compiler
whether it does.

Three cases now do, in `test/unity-darwin-requirement.test.js`, and a `macos-latest` CI job runs
them. They need no seat, no credential, and no
Unity install, so they are not the canary and do not stand in for it:

| case | what it is red against |
| --- | --- |
| the shipped requirement compiles under `csreq -r =<req> -b` | a typo that turns the gate into "always refuse". Paired with a deliberately malformed requirement, so a `csreq` that accepted anything would not pass it |
| `codesign --verify --strict` passes on `/bin/ls` and the same command with `-R` refuses it | a requirement so loose that an Apple-signed non-Unity binary satisfies it. The refusal is attributable because it is the same binary and the same flags, one added `-R` |
| the compiled requirement decompiles (`csreq -r <file> -t`) holding `9QW8UQUTAA`, and a different team compiles to different bytes | **a clause `csreq` accepts and discards.** `/bin/ls` cannot expose this: it is a platform binary with no Developer ID chain, so `certificate 1[...6.2.6] exists` refuses it before the identity is ever consulted |

**The job earned its place on its first run, by going red.** Pointed at
`test/unity-license-return.test.js`, it failed three pre-existing cases -- not the new ones. That
file builds its editor fixture under `os.tmpdir()`, which on macOS resolves beneath the symlinked
`/var`, and the action's own `assertNoReparsePath` walk correctly refuses it. So **this suite has
never been runnable on Darwin**, and nobody knew, because nothing had ever run it there.

That is a fixture problem and not an action problem -- production resolves under
`runner.tool_cache`, not `/var` -- so it is #241 rather than fixed here, and the three new cases
live in their own file that builds no fixture at all.

The third is the one worth reading twice. The first draft of it asserted that the team clause was
what refused `/bin/ls`, which is false for exactly that reason -- it was a case that could not go
red. Asking the compiler what it stored is the question that can.

## The analyzer half was dropped, because main already has a stricter one

Draft #228 carried a second commit that widened `auditPaidJob`: `windowsSelfHostedJob` and a new
`darwinSelfHostedJob` sharing a `selfHostedPlatformJob` helper, admitting **any** self-hosted macOS
job. That was written before #230 merged. #230 (`10eba8d11`) solved the same problem and solved it
harder: `returnRunnerPlatform` (`unity_policy.go:5050-5084`) rejects a dual-family `runs-on` and any
expression-bearing label, and `centralReturnRunnerApproved` (`:5086-5109`) admits Darwin **only**
when every return reference is in `approvedDarwinReturnShas` -- a list validated at `:185-203` and
empty at `unity-enrollment-policy.json:32`.

So #228's analyzer commit is not merely redundant, it is **strictly weaker**: it has no allowlist
and no dual-family refusal. Cherry-picking it back would have re-opened both. Only the two runtime
commits are here; the enrollment contract stays exactly as #230 left it.

The practical consequence, and it is the safe one: **this change permits no Darwin return.** The
analyzer refuses every one until a reviewed release SHA is added to `approvedDarwinReturnShas`,
which is #231 and deliberately a human merge.

## Validation

- `node --test test/unity-license-return.test.js`: **33 cases, 30 pass, 3 skipped** on Linux --
  the three skips are the macOS-only requirement cases, which the new `darwin-return-requirement`
  job unskips.
- Whole suite: **11 failures before this change and 11 after**, the same eleven. They are this
  container's -- it has no Go toolchain, and every one of them shells out to `go`.
- `node --test test/documentation-policy.test.js test/action-manifests.test.js`: 68 pass, covering
  the README rewrite below.
- `bash tools/workflows/ci.sh javascript`: clean.
- `go test`, `go vet`, `golangci-lint` and `actionlint` were **not** run here and no Go file
  changed. CI owns them.

Two contract pins had to move with the new job, and both are the kind that should have to move:
`test/workflow-policy.test.js:15` names `ci.yml`'s jobs and `:53` names its run steps.

## The README said Windows-only, and it is a trust document

`README.md:260` opened "The central return action is Windows-only." Landing a Darwin path and
leaving that sentence is the failure mode the repository's own rule about synchronized manifests,
runtimes, tests and docs exists to prevent -- a reader checking whether macOS is safe would have got
a confident, wrong answer. It now states both platforms, that every other platform is refused
rather than downgraded, what each verifies, and -- the part that keeps it honest -- that a Darwin
return is still refused by the analyzer until `approvedDarwinReturnShas` names a release.

## Mutation coverage

Session 068's, carried forward rather than re-run: each guard was broken in turn and only its own
tests went red. What this session re-verified is that the same 30 cases still pass against today's
main, not the five mutations. The three new macOS cases carry their own red halves in-line, which
is why two of them compile a deliberately wrong requirement and the third compares two teams.

| mutation | red |
| --- | --- |
| identity pin dropped from the requirement | requirement test, codesign invocation test |
| signal the pid rather than the process group | group-signal test, hung-verifier test |
| unsupported platform falls through to the Darwin verifier | platform-refusal test |
| an empty reviewed team set is allowed through | both fail-closed tests |
| loader injection allowed into the child environment | environment allowlist test |

## Cancellation, which is the cost `detached` introduced

Cursor Bugbot found this on the pull request, at High, and it is right. It is also the
best kind of finding: the mechanism added to stop a seat leaking was itself a way to
leak one.

`detached: true` is what lets `terminateProcess` signal the editor's whole process
group. It also takes the editor **out of the runner's kill tree**, because a detached
child leads its own group and session. So a cancelled workflow run terminated this Node
process and left the editor running with the paid seat -- exactly the failure #153
exists to prevent. Windows never had it: the child is not detached there, so the tree
kill already reaches it.

`SIGINT` and `SIGTERM` are forwarded to the group now, on Darwin only, and the handlers
are released on settle -- a listener outliving the child would signal a pid this process
no longer owns, and on a runner a pid is reusable.

**And writing the test found a second defect, larger than the first.** The completion
rule accepted *any* signal as a close, so the synthetic `runner-cancelled` satisfied it.
A cancelled run -- editor killed mid-return, nothing it wrote a verdict -- would have
written **`return-command-completed=true`**. That is the one direction this action must
not fail in, and it became reachable the moment the handler existed. The two synthetic
signals are a named set now and neither is a completion.

Four mutations, each red on exactly the case that owns it:

| mutation | red |
| --- | --- |
| no handler installed at all | the darwin cancellation case, on a **bounded** wait -- the first draft hung here instead of failing, and a test that hangs on its own mutation reports nothing |
| handler installed on every platform | the windows case, which exists to say why Windows does not need one |
| `runner-cancelled` scored as a completion | the darwin case, on `return-command-completed` |
| handlers not released on settle | the darwin case, on the listener count |

**A second Bugbot round found the rejection path**, which was a third inline copy of
`settle`'s bookkeeping and released no listeners: they would outlive the child and later
signal a reused pid. `error` can also arrive *after* a successful spawn, in which case a
detached editor is running with the seat -- so the path terminates as well.

It is a `fail()` twin of `settle()` now rather than a third copy, which is what stops the
next path from getting it wrong again. Two more mutations, both red on the new case:
releasing no handlers, and releasing them without terminating.

The fixture takes a platform now, because `editorPath` defaults to the Windows layout
while `executeReturn` defaults to `process.platform`, so a fixture that always plants
`Unity.exe` disagrees with the action the moment either is asked about Darwin. That is
one half of #241; the temp root under macOS's symlinked `/var` is the other and is still
open.

## What this does not do, and must not be read as doing

- **No canary.** #153 requires an exact-head licensed canary on native macOS. Nothing here has run
  against a real editor or returned a real licence. The new macOS job compiles and probes the
  requirement; it never verifies a Unity binary, because no runner here has one.
- **No authorization.** The release sha still has to be added to `approvedReturnShas` by a separate
  reviewed merge. This changes no allowlist.
- **The Windows-container half of #153 is untouched.**
