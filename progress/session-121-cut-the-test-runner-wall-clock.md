# Session 121: cut the test runner's wall clock

Date: 2026-10-01

## What this session measured, and what it changed

No check was removed. Every assertion that ran before runs now. The only
changes are where a test lives and when it runs.

| Measurement | Before | After |
| --- | --- | --- |
| `.devcontainer/scripts/verify.sh` | 34.0 s | 9.9 s |
| `node --test test/*.test.js` | 21.7 s | 5.0 s |
| `test/workflow-scripts*.test.js` | 18.4 s | 4.5 s |
| `test/build-lock*.test.js` | 6.0 s | 2.5 s |
| Windows CI job, test step | 78 s | 45 s predicted |
| Windows CI job, whole | 93 s | 60 s predicted |

The Windows row is a prediction from the recorded per-test times, not a
measurement. Everything else was measured on this machine, before and after.

## Why the suite was slow

`node --test` gives each **file** its own process and runs those processes at
the same time. Inside one file it runs the tests one after another. That is the
whole story:

| File | Top-level tests | Time alone |
| --- | --- | --- |
| `workflow-scripts.test.js` | 75 | 18.4 s |
| `build-lock.test.js` | 216 | 6.0 s |
| `llm-harness-catalog.test.js` | 4 | 3.5 s |
| every other file | 1 to 20 | under 1 s |

`workflow-scripts.test.js` alone was the longest single step in the local
verification and in the Linux CI job.

The work is not CPU-bound. Four copies of that one file at the same time took
20.2 s, and one took 18.4 s. It is process-spawn-bound: about two thousand `git`
and `bash` spawns across 75 tests, twenty-six per test. Spreading the same work
across processes is nearly free.

## The two Windows tests

`test/unity-cleanup-evidence.test.js` held two Windows-only tests. On a hosted
Windows runner the committed helper `.github/dist/delete-unity-return-evidence.ps1`
compiles its own C# with `Add-Type`, and Windows PowerShell shells out to
`csc.exe` for that. One spawn costs about fifteen to thirty seconds.

Run 36904676960 measured it. The job took 93 s, and the test step took 78 s:

| Test | Time |
| --- | --- |
| `Windows helper deletes real claimed central evidence by native handle` | 31.3 s |
| `Windows helper rejects a same-size rewrite with all metadata restored` | 45.0 s |
| every other test in the step | 1.5 s |

Seventy-six of the seventy-eight seconds were two tests, and they ran one after
the other in the same file. That made the Windows job the slowest job on every
pull request, at 93 s against 87 s for the Linux job that does six times the
checking.

They are now in one file each, so each gets a process and they run at the same
time. The job should take about 60 s.

The first attempt put both in one new file. The Windows job took 97 s, worse
than the 93 s before, and the log showed the two tests finishing one after the
other at 31.9 s and 46.9 s: `node --test` runs the tests inside one file in
sequence, so moving them into a file together changed nothing. One test per
file is the fix.

### Two options rejected

- **Compile the helper once.** `Add-Type -OutputAssembly` would let one compile
  serve every spawn. It adds a cache directory and a build artifact to a
  fail-closed safety helper. Not worth it for thirty seconds.
- **Use PowerShell 7 in the test's own time-restore helper.** PowerShell 7
  compiles in process and would save about fifteen seconds. It cannot be
  measured from a Linux container, and the test asserts a restored change time,
  which no built-in .NET call can set. Recorded here as untested, not attempted.

## What the split moved

Nothing but code location. The check that matters is the test-name set:

```
before: 978 test names
after:  978 test names
diff:   empty
```

Every helper, fixture, and case table that more than one shard reached moved to
a support module. The shards import exactly the names their own tests use, so an
unused import is still a signal.

The split points came from a real parse, not from brace counting. `acorn`
reported the 109 top-level statements of `workflow-scripts.test.js` and the 258
of `build-lock.test.js`, and each statement was weighed by its measured
duration. A hand-balanced line split fails: the first attempt put 74 tests in
four shards at a 9.9 s wall, and half of them failed because a helper sat in the
wrong shard.

## A parallel verification runner was measured and rejected

After the split, `go test -race` at 7.5 s is the slowest remaining step and
`node --test` at 5.0 s is second. Running the check groups at the same time
would take the sum of 16.7 s down to about 8 s, and `verify.sh` from 9.9 s to
about 8 s. That is one second for a new script that agents have to learn,
document, and keep correct. Not taken.

## Files

| File | Lines | Why |
| --- | --- | --- |
| `test/workflow-scripts-0..5.test.js` | 942 to 2443 each | The 75 tests, weighed by duration |
| `test/workflow-scripts-support.js` | shared | Every helper and case table |
| `test/build-lock-0..2.test.js` | three shards | The 216 tests |
| `test/build-lock-support.js` | shared | The runtime bindings and fixture tables |
| `test/unity-cleanup-windows-native-delete.test.js` | one test | Its own `Add-Type`, its own process |
| `test/unity-cleanup-windows-native-rewrite.test.js` | one test | Its own `Add-Type`, its own process |
| `test/unity-cleanup-evidence-support.js` | shared | The Windows fixture helpers |

`ci.sh syntax` and `verify.sh` now walk `test/*.js` rather than `test/*.test.js`,
so a support module is checked on its own. The `*support.js` files hold no test,
so the `node --test test/*.test.js` glob never picks them up.

## Verification

- `.devcontainer/scripts/verify.sh` exits 0.
- The 978 test names are identical before and after.
- `eslint`, `shellcheck`, `actionlint`, `golangci-lint`, `go vet`,
  `go test -race`, and the LLM harness check all pass.
- `test/workflow-policy.test.js` records the exact run-script command list for
  every workflow, so the Windows job's changed command line is pinned by a test
  that failed until it was updated.

## Known limits

- The Windows job numbers in this record are predicted from per-test times the
  hosted runner reported. The pull request carries the measured job time.
- On Linux the `node --test` step fell from 27.4 s to 19.0 s, but the job only
  fell from 87 s to 84 s, because `go test -race` at 18 s is now the longest
  step. Moving the race suite to its own job would need a new required-check
  name in the branch ruleset, which this task must not change.
- Six files is a judgement call. Four shards left one shard at 3.4 s and the
  other three near 3.4 s, which is balanced; six was chosen because the split
  points had to land on region boundaries, and eight would have produced two
  shards of two tests each.
- `llm-harness-catalog.test.js` is now the third slowest file at 3.5 s. It was
  not split because it holds four tests and one of them is 3.4 s of it, so a
  split would not shorten the longest step.