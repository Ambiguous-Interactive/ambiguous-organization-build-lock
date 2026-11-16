# Plan

Open work only. Maintenance rules: [task-driven development](.llm/skills/task-driven-development/SKILL.md#plan-maintenance).

## Future work and blockers

- Credential scope (#51): the owner keeps both Apps installed org-wide. The
  remaining work is the org-secret repository scope and the permission probe.
- Enrollment drift (#113): 27 findings remain. Five are DxAudio findings (fixed
  by this session's consumer pull request), 14 are DxMessaging workflow shape
  findings, and 8 are expired unity-builder and unity-helpers exceptions.
  DoxReloaded is complete.
- Seat attribution (#223): use Unity portal evidence to determine whether peer
  activation can invalidate an incumbent seat.
- Shared-seat capacity (#83): prove independent returnable identities and both
  return orders before deciding capacity or slot-aware state changes.
- Queue fairness (#53): measure live two-runner load before changing admission.
- Platform cleanup (#153, #229, #231, #249): collect native/container canary and
  macOS signing evidence; authorize the exact Darwin-capable release separately.
- Operational canaries (#29): obtain deliberate-failure and seven-day monitoring
  evidence before closing the rollout.
- Scheduler availability (#334): prove an independent delivery path or obtain
  an owner decision; recovered monitor runs alone do not close the issue.
- Consumer failure (#278): collect consumer test and retry evidence; recorded
  lock cleanup was clean.
- Cancellation attribution (#277): obtain actor evidence beyond run records.
- Linter compatibility (#335): the pinned linter still fails to build against
  YAML v4.0.0, which no longer exports `yaml.ParserError`. Move the dependency
  only after a linter release supports the newer API.
- Aggregate coverage (#397): the reviewed aggregate shapes cover one licensed
  job, so a workflow with several licensed jobs cannot pass. DxMessaging and
  unity-helpers findings wait on that decision.
- Merge queue adoption (#379): v1.18.0 publishes an approved pin. Repin
  DoxReloaded, add `merge_group`, and enable the queue after the owner
  authorizes it.
- Status adoption (#390): v1.18.0 publishes an approved pin. A consumer adopts
  the reporting step outside every licensed job.
