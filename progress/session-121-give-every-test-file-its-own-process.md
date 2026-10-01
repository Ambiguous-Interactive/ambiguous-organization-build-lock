# Session 121: give every test file its own process

Date: 2026-10-01

## What changed

No check was removed. The reason a check exists is part of the check, so no
rationale comment was removed either.

| Measurement | Before | After |
| --- | --- | --- |
| `node --test test/*.test.js` | 21.7 s | 4.9 s |
| `.devcontainer/scripts/verify.sh` | 34.0 s | 8.4 s |
| `test/workflow-scripts*.test.js` | 18.4 s | 3.2 s |
| `test/build-lock*.test.js` | 6.0 s | 2.9 s |
| Windows CI job, `node --test` step | 78.0 s | 35.7 s |
| Windows CI job, whole | 93 s | 51 s |
| Linux CI job, whole | 89 s | 72 s |

The local rows are on the development container, before and after. The CI rows
are run 36904676960 for the Windows before and run 36929198410 for the Windows
after. The Linux before is run 36925885236, which is the merge base; the first
attempt used run 36904676960, which is one commit earlier, and that understated
the before by the three tests PR #322 added.

## Why the suite was slow

`node --test` gives each **file** its own process and runs those processes at the
same time. Inside one file it runs the tests one after another. That is the whole
story:

| File | Top-level statements | Time alone |
| --- | --- | --- |
| `workflow-scripts.test.js` | 75 | 18.4 s |
| `build-lock.test.js` | 216 | 6.0 s |
| `llm-harness-catalog.test.js` | 4 | 3.5 s |
| every other file | 1 to 20 | under 1 s |

`workflow-scripts.test.js` alone was the longest single step in the local
verification and in the Linux CI job.

The work is not CPU-bound. Four copies of that one file at the same time took
20.2 s and one took 18.4 s. It is process-spawn-bound: the file shells out to
`git` and `bash` from every test, and the per-test cost is the spawn count
rather than any computation.

## The two Windows tests

`test/unity-cleanup-evidence.test.js` held two Windows-only tests. On a hosted
Windows runner the committed helper `.github/dist/delete-unity-return-evidence.ps1`
compiles its own C# with `Add-Type`, and Windows PowerShell shells out to
`csc.exe` for that. One spawn costs about fifteen to thirty seconds.

Run 36904676960 measured it. The job took 93 s and the test step took 78 s:

| Test | Time |
| --- | --- |
| `Windows helper deletes real claimed central evidence by native handle` | 31.3 s |
| `Windows helper rejects a same-size rewrite with all metadata restored` | 45.0 s |
| every other test in the step | 1.5 s |

Seventy-six of seventy-eight seconds were two tests run one after the other in
the same file. That made the Windows job the slowest job on every pull request,
at 93 s against 89 s for the Linux job that does six times the checking.

Run 36929198410 measured the fix. The two tests report 22.8 s and 34.9 s, which
overlap rather than adding up, and the step takes 35.7 s.

### Three attempts, in order

1. **Both tests in one new file.** The job took 97 s, worse than the 93 s
   before, and the log showed the two finishing one after the other. Moving them
   together changed nothing, because `node --test` runs the tests inside one
   file in sequence.
2. **One test per file.** The step fell to 35.7 s and the job to 51 s.
3. **A pinned `--test-concurrency=4`.** `node --test` defaults to one process
   per core less one. Measured on two cores: the default gives a serial run, and
   the flag gives four processes. Without the flag a two-core runner image would
   run these four files one after another and the step would go back to about
   78 s with nothing in the workflow saying why. Four is the file count.

### Two options rejected

- **Compile the helper once.** `Add-Type -OutputAssembly` would let one compile
  serve every spawn. It adds a cache directory and a build artifact to a
  fail-closed safety helper. Thirty seconds is not worth that.
- **Use PowerShell 7 in the test's own time-restore helper.** PowerShell 7
  compiles in process and would save about fifteen seconds. It cannot be
  measured from a Linux container, and the test asserts a restored change time,
  which no built-in .NET call sets. Recorded as untested, not attempted.

## What the split moved

Nothing but code location and comment placement. Three checks say so, and the
first two are independent of each other:

1. **Test-name set.** 978 names before, 978 after, sorted diff empty.
2. **Top-level statement multiset.** `acorn` parses each file and the statements
   are compared with whitespace and comments normalized. A lost or duplicated
   statement shows up even when the test names match, which is what happened
   twice during this work:

   | File | Statements before | After | Lost | Added |
   | --- | --- | --- | --- | --- |
   | `workflow-scripts` | 108 | 114 | 0 | the six per-shard imports |
   | `build-lock` | 257 | 260 | 0 | the three per-shard imports |
   | `unity-cleanup-evidence` | 38 | 46 | 2 | both a `require` the split replaced |

3. **Comment-line multiset.** Zero lines lost in both files that had any. The
   first attempt dropped 25 rationale comment blocks, including the
   `issue #13` and `issue #269` provenance notes, and no test noticed. The
   splitter now refuses to write a file if any comment line falls outside the
   statement ranges it emits.

### How the split was cut

`acorn` reported every top-level statement with its line range and its bound
names. Each statement was weighed by its measured duration, and each shard
destructures only the names its own tests reach, so an unused import is still a
signal.

Hand-balancing by line count fails. The first attempt produced four shards at a
9.9 s wall with half the tests failing, because a helper sat in the wrong shard.
Brace counting fails too, because the files have no indentation at all.

## Files

| File | Lines | Why |
| --- | --- | --- |
| `test/workflow-scripts-1.test.js` | 2633 | The repin rewrite and offer cases |
| `test/workflow-scripts-0.test.js` | 1104 | ShellCheck install, onboarding, summaries |
| `test/workflow-scripts-5.test.js` | 298 | Release authorization |
| `test/workflow-scripts-2.test.js` | 143 | Repin snapshot surfaces |
| `test/workflow-scripts-3.test.js` | 162 | Repin undecodable bytes |
| `test/workflow-scripts-4.test.js` | 160 | Repin pin movement |
| `test/workflow-scripts-support.js` | 999 | Every helper and case table |
| `test/build-lock-2.test.js` | 5644 | Lock, queue, and release cases |
| `test/build-lock-1.test.js` | 4828 | Cleanup and incident cases |
| `test/build-lock-0.test.js` | 748 | Action input and digest cases |
| `test/build-lock-support.js` | 540 | The runtime bindings and fixture tables |
| `test/unity-cleanup-windows-native-delete.test.js` | 41 | Its own `Add-Type`, its own process |
| `test/unity-cleanup-windows-native-rewrite.test.js` | 64 | Two `Add-Type` spawns, its own process |
| `test/unity-cleanup-evidence-support.js` | 174 | The Windows fixture helpers |

`ci.sh syntax` and `verify.sh` now walk `test/*.js` rather than `test/*.test.js`,
so a support module is checked on its own. The `*support.js` files hold no test,
so the `node --test test/*.test.js` glob never picks them up.

## Verification

- `.devcontainer/scripts/verify.sh` exits 0.
- The three checks above pass.
- `eslint`, `shellcheck`, `actionlint`, `golangci-lint`, `go vet`,
  `go test -race`, and the LLM harness check all pass.
- `test/workflow-policy.test.js` records the exact run-script command line of
  every workflow, so the Windows job's changed command is pinned by a test that
  failed until it was updated.

## A Linux-green change that broke Windows

CI caught a real defect the local runs could not. `restoreWindowsFileTimes`
lives in `test/unity-cleanup-evidence-support.js` and calls `childProcess`, and a
cleanup pass had dropped the module's `node:child_process` import while removing
an export it mistook for dead. Every Linux run stayed green, because the two
Windows-native tests are the only coverage for that helper and they are skipped
off Windows.

That is a class, not an accident: a file whose only coverage runs on one runner
has no local check at all. So `ci.sh javascript` now runs `no-undef` over
`.github/dist`, `tools`, and `test`, with the Node globals listed because the run
uses `--no-config-lookup`. Removing the import again now fails on Linux. The rule
costs nothing: eslint already ran.

## Review rounds, and what each changed

| Finding | Disposition |
| --- | --- |
| The splitter deleted 25 rationale comment blocks, including two issue provenance notes | Fixed. Each statement keeps its own leading comment block, and the splitter now refuses to write a file when any comment line falls outside the ranges it emits. Zero comment lines are lost. |
| The CI "before" was measured one commit before the merge base | Fixed. The Linux before is now run 36925885236, the merge base, and the record names both runs. |
| `go test -race` was called the longest Linux step | Wrong. `node --test` at 21 s is the longest; `go test -race` is 17 s. Corrected. |
| "the shards import exactly the names their own tests use" did not extend to support modules, where a dead export is invisible to eslint | Fixed. Nine dead exports were dropped. A cleanup script then deleted two function *parameters* that matched the export pattern; the statement multiset check caught it at once and they are back. |
| "the split moves no assertion" was true of the assertion set but not of placement | Corrected. Fourteen `assert.*` calls now live in the support modules, where the fixtures they guard moved. The assertion set is unchanged. |
| The Windows win depends on the runner having four cores | Fixed. `--test-concurrency=4` is pinned on that step, and the reason is in the workflow. |
| The new Windows files had duplicated header prose and a stale "tests below" comment | Fixed. |
| A support module re-exports its runtime whole, which no linter can see through | Accepted. The three modules that do it were read by hand and the export list is the statement multiset check's own input. |
| `build-lock-support.js` generates an RSA-2048 key at module load, now once per shard | Accepted. Measured at 41 ms. No correctness effect. |
| A Linux-green change broke the only coverage a Windows-only test has | Fixed. `no-undef` now runs on every JavaScript file, so an unbound reference in a file with no local coverage fails on every runner. |
| The Linux job only fell from 89 s to 78 s | Accepted. `go test -race` at 17 s and `setup-go` at 12 s are what is left. Moving the race suite to its own job would add a required-check name to the branch ruleset, which this task must not change. |

## Known limits

- `llm-harness-catalog.test.js` is now the third slowest file at 3.5 s. It holds
  four tests and one of them is 3.4 s of it, so splitting it would not shorten
  the longest step.
- Six shards is a judgement call. Four would leave one shard at 3.4 s and three
  near 3.4 s, which is balanced; six was chosen because the split points had to
  land on a statement boundary that leaves no shard with a single slow test.