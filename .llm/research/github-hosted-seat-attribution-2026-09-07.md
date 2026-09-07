# GitHub-Hosted Unity Seat Attribution, 2026-09-07

<!-- summary: A portal seat row on a GitHub Actions address range identifies a hosted runner; pair the range check with the enrollment audit to name the exact workflow and job. -->

## Question

Can an unknown Unity portal seat row be attributed to an organization
workflow when the portal shows only a machine id, user, and source address?

## Method

Unity portal seat rows can include the client source address. GitHub
publishes its Actions runner address ranges at `https://api.github.com/meta`
under the `actions` key. Membership of a seat address in that range proves
the activation came from a GitHub-hosted Actions runner, not from the
self-hosted fleet. The container-style hostname (twelve hexadecimal
characters) and a root user are consistent with a container job, but they
are not proof on their own.

Pair the range check with the enrollment audit. The audit reason
`unsafe-hosted-unity-runner` names every licensed job whose `runs-on` lacks
a literal `self-hosted` label, which turns one unknown portal row into
named workflow and job evidence.

## Scope and evidence boundary

The 2026-09-07 portal row published in issue #223 shows a container-style
machine id, a root user, and a client address inside GitHub Actions range
`135.232.128.0/17`. The audit run against the six enrolled repositories at
their default-branch heads named exactly two paid jobs on hosted runners,
both unity-helpers `.unitypackage` export jobs, and changed no other
finding. No raw log, credential, serial, or evidence digest is retained
here.

## Outcome

Seat attribution needs both halves: the address range proves the runner is
GitHub-hosted, and the audit names the workflow and job. Disposition of the
identified jobs is a maintainer decision recorded in `PLAN.md` (M1).
