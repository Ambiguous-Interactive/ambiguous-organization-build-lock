# Session 036: Delete consumed Unity return evidence

Date: 2026-07-30

Status: implementation and hosted validation complete; exact-head review pending

## Selection

GitHub reported 14 open issues and no open or draft pull requests. Local `main`
matched `origin/main` at `c60c7e5c1`; sampled scheduled workflows on that exact
head were green.

Priority order by impact and safe Unity churn:

1. #83 remains the largest active production defect, but its issue record
   requires independently returnable Unity identities, both return orders, and
   portal reconciliation. Treating `400006` as clean without that evidence would
   violate the fail-closed cleanup contract.
2. #160 is the highest safely completable security issue. It removes consumed
   credential-adjacent evidence centrally and its implementation needs no
   licensed Unity execution.
3. #113 reports broad cross-repository enrollment drift and requires sequenced
   consumer remediation rather than one central low-churn change.
4. #51 requires prohibited organization policy and secret/App scope mutations.
5. #153, #53, #49, and #44 require broader architecture, consumer rollout, or
   live licensed validation.
6. #99 and #60 are throughput follow-ups; #60 depends on safe #83 resolution.
7. #94 remains upstream-blocked because actionlint v1.7.12 is still latest and
   does not compile with yaml/v4 rc.6.
8. #29 and #27 require live canaries/monitoring; #30 is the umbrella tracker.

There are no open dependency PRs. The root Go module is current. The only
available direct isolated-module update is yaml/v4 rc.6, which remains blocked
by #94; unrelated indirect-module version advertisements were not promoted into
direct dependencies.

## Red-green evidence

The focused baseline added a successful-classification assertion that the
central evidence directory no longer exists:

```text
node --test test/unity-cleanup-evidence.test.js
44 passed, 1 failed: evidence directory still existed
```

The implementation derives the only permitted target from `RUNNER_TEMP`,
`GITHUB_RUN_ID`, and `GITHUB_RUN_ATTEMPT`. It requires the central SHA-256
binding; validates exact path, name, non-link ancestry, and stable identities;
rejects unexpected siblings; atomically claims the directory under a random
private name; and performs the authoritative read, digest verification, and
classification there. A Windows-native helper opens the classified file
without write/delete sharing and the owned directory with the minimum delete
sharing needed for child disposition, verifies their volume/file IDs and
stable metadata, re-hashes the exact opened file, then deletes those exact
handles. There is no pathname-delete fallback. Absence is verified before
completed outputs. Supplemental evidence remains outside deletion ownership.

Current focused evidence:

```text
node --test test/unity-cleanup-evidence.test.js
63 passed, 2 hosted-Windows native tests skipped locally

node --test test/workflow-policy.test.js
65 passed

go test ./internal/enrollment
passed

.devcontainer/scripts/verify.sh
passed: 676 Node tests (674 pass, 2 Windows-only skips) plus all Go
packages/modules, actionlint, harness, and credential-literal policy
```

The enrollment analyzer now rejects the obsolete digestless cleanup composite
and continues to enforce the exact contiguous central return, classifier,
release, and cleanup-gate terminal suffix. CI includes a narrow
`windows-latest` job that executes the real native deletion helper without
Unity.

The hosted-Windows remediation progressed through three concrete failures: the
original 30-second cold `Add-Type` timeout, a parent-directory sharing conflict
that blocked child disposition, and a C# member-name collision between the
delete-access constant and public deletion method. The helper now has a bounded
120-second allowance, supplies only the validated runner-temp root as compiler
scratch, permits delete sharing only on the identity-bound directory handle,
and names the access constant distinctly. Exact head `fb5f84ef2` passed both
native success and metadata-forgery tests on `windows-latest`; Linux validation
also passed in workflow run `30594124851`.

## Adversarial review

The first independent review found three unsafe paths: authoritative read
failure could collapse into empty evidence, classification could become stale,
and the enrollment analyzer still trusted the obsolete digestless composite.
All were accepted and remediated.

The second round proved a deeper TOCTOU issue: pathname `unlink`/`rmdir` could
delete replacements before post-hoc identity checks detected the race. Those
operations were removed. Later rounds showed that Windows ChangeTime, and then
all metadata together, remained forgeable. The native helper now re-hashes
bytes through the exact opened handle while write/delete sharing is excluded.
Regression tests substitute both the file and directory and restore all
metadata after a byte rewrite. The independent reviewer returned PASS with no
remaining actionable high-impact finding.

## Rollout boundary

The updated classifier cannot be approved or pinned by consumers until its
merge commit is reachable. After this central PR merges, a separate reviewed
authorization/consumer migration must pin that immutable commit and prove the
organization enrollment audit green. No organization policy is changed here.
