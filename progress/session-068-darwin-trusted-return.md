# Session 068 -- a Darwin trusted return, proposed

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

## The analyzer now admits the runner the implementation supports

`auditPaidJob` refused any job running `return-unity-license` on anything but a self-hosted
**Windows** runner, so a macOS job would have carried `unsafe-return-execution-environment` even
with the implementation above merged. #153 asks for "analyzer support only for the exact approved
immutable action shape and same-runner suffix", and this is that.

`windowsSelfHostedJob` and a new `darwinSelfHostedJob` now share one `selfHostedPlatformJob`
helper, and the rule admits either. **It widens nothing else.** A hosted macOS runner, a
self-hosted runner naming neither platform, and a dynamic `runs-on` expression all still fail
closed, each with its own red case.

Ordering is worth stating: the analyzer admitting a Darwin return is safe before the team
identifier is read, because the action itself refuses every Darwin return until then. The analyzer
stops double-blocking; it does not become the thing that permits.

## What is deliberately not decided here

**`UNITY_DARWIN_TEAM_IDS` is empty, and an empty set fails the return closed.** It is the Darwin
counterpart of `UNITY_SIGNER_THUMBPRINTS`, whose two values somebody read off real binaries. The
team identifier has to be read the same way -- `codesign -dv --verbose=4` on an installed
`Unity.app`, then recorded here in review. This session had no macOS machine, and guessing an
identity into a trust boundary is the one thing that must not happen: a wrong value fails closed,
but a *plausible* wrong value invites somebody to "fix" the gate by loosening it.

So the action refuses every Darwin return until that read happens. That is the intended state of
this pull request.

The identifier is a reviewed constant rather than an input, because #153 says caller-selected
identity is not cleanup authority.

## Validation

- `node --test test/unity-license-return.test.js`: **30 pass, 0 fail**, eight consecutive runs.
  Twelve are new.
- Whole suite before and after: **11 fail, 126 cancelled in both**. Those are this container's,
  not this change's; `pass` moves 555 -> 567 and nothing else moves.
- `node --test test/documentation-policy.test.js test/action-manifests.test.js`: 67 pass.
- `go build ./...`, `go vet ./...`, `go test ./...`: all pass, ten packages.
- **`go test -race` was not run**: this container has no gcc and the race detector needs cgo. The
  change adds no concurrency, and that is an argument rather than a measurement; CI runs it.

### Mutation coverage

Each guard was broken in turn and only its own tests went red.

| mutation | red |
| --- | --- |
| identity pin dropped from the requirement | requirement test, codesign invocation test |
| signal the pid rather than the process group | group-signal test, hung-verifier test |
| unsupported platform falls through to the Darwin verifier | platform-refusal test |
| an empty reviewed team set is allowed through | both fail-closed tests |
| loader injection allowed into the child environment | environment allowlist test |

And for the analyzer, each guard broken in turn:

| mutation | red |
| --- | --- |
| Darwin runners not admitted at all | the accepts-Darwin test, both label spellings |
| a hosted macOS runner admitted | the hosted-macOS case |
| any self-hosted runner admitted whatever its platform | the non-Windows and no-trusted-platform cases |
| a dynamic `runs-on` stops failing closed | the dynamic-expression case |

One harness bug was found doing this and is worth recording: the first mutation script scanned only
for `--- FAIL` and reported a mutant that **failed to compile** as "nothing went red", which reads
exactly like a coverage gap and is not one. It also exited before restoring, so it left two mutants
in the tree. A mutation harness restores in a `finally` and treats a build failure as inconclusive
rather than as either colour.

## What this does not do, and must not be read as doing

- **No canary.** #153 requires an exact-head licensed canary on native macOS. Nothing here has run
  against a real editor or returned a real licence.
- **No authorization.** The release sha still has to be added to `approvedReturnShas` by a separate
  reviewed merge. This changes no allowlist.
- **The Windows-container half of #153 is untouched.**
