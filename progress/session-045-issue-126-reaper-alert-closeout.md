# Session 045: Issue #126 reaper alert closeout

Date: 2026-08-02

## Selection and hypothesis

The live repository inventory contained 17 open issues and no open or draft
pull requests. The newest P0 operational issue was generated alert #126,
`ops: scheduled reaper delivery outside SLO`. The reaper had resumed at
`30726138905` after the alert was opened, but the delivery audit had no
completion-triggered run to close the stale alert. The selected change keeps
the existing independent schedule as the detection path and adds a
`workflow_run` completion trigger for the same audit.

Hypothesis: re-running the bounded, read-only audit after every completed
reaper run will close a recovered alert promptly without granting dispatch
authority, exposing lock credentials, or changing lock behavior.

Safety invariants:

- The scheduled audit remains the independent detector for missing or delayed
  reaper deliveries.
- The completion trigger only runs the committed monitor and never invokes the
  reaper or writes lock state.
- Actions read, contents read, and issues write remain the only permissions;
  no writer, reader, or Unity credential is available to the audit.
- A malformed or unavailable Actions response still fails closed according to
  the existing monitor contract.

## Red-green evidence

The focused policy/documentation baseline failed after the workflow trigger was
introduced because the contract did not yet require the trigger and the
runbook's evidence sentence was wrapped in a way that broke its exact policy
assertion. The corrected focused suite passed:

```text
node --test test/workflow-policy.test.js test/documentation-policy.test.js
74 passed, 0 failed
```

The workflow contract now requires `workflow_run` for the exact `Reap stale
build locks` workflow and `completed` activity type. The runbook documents that
the audit also runs after completed scheduled/manual reaper runs.

No licensed Unity workflow, lock configuration, credential, or organization
policy changed.

## Delivery and live closeout evidence

PR #178 was squash-merged at `ec9768d20b62ea013f35d30936db5fdcb0410eb1`,
whose exact-head CI passed, including the hosted-Windows evidence-deletion job.
Cursor Bugbot reviewed that exact head and reported no actionable findings on
permissions, trigger semantics, or fail-closed behavior. Copilot was requested
through the reviewer API and tagged comment but returned no review submission;
there was no feedback to remediate.

The first scheduled reaper delivery from the merged head was run
`30727490453`, completed successfully at `2026-08-02T01:41:02Z`, and used head
`ec9768d20b62ea013f35d30936db5fdcb0410eb1`. Its completion-triggered audit was
run `30727495525`, completed successfully, and synchronized the marker issue
to `State: healthy` at `2026-08-02T01:41:27Z`. Issue #126 closed at
`2026-08-02T01:41:28Z`.

The default branch remained green at the merge commit: post-merge Build lock
CI run `30727434178` passed both validation jobs. No licensed Unity workflow,
lock configuration, credential, or organization policy changed.
