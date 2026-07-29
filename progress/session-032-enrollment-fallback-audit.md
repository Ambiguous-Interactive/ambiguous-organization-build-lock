# Session 032: enrollment fallback audit

## Goal and selection

Reviewed all 14 open issues and found no open or draft pull requests.
Prioritized work by production impact and paid Unity CI cost:

1. #113 organization enrollment drift: broad safety visibility, static audit,
   and decomposable without consuming a Unity seat.
2. #83 shared-entitlement return ambiguity: high impact but explicitly blocked
   on independent entitlement identities, both return orders, and portal
   reconciliation.
3. #60 literal zero cooldown: blocked by the same unresolved shared-entitlement
   evidence.
4. #99 acquire/release timing and #44 truthful aggregates: valuable but require
   coordinated consumer evidence and paid runs.
5. #132 recovery ergonomics, #29/#27 monitoring, #53 runner starvation, #49
   matrix throughput, #54 canary, #51 secret scope, and #94 dependency updates:
   lower impact, externally gated, or organization-policy work outside this
   session.

Opened repository-owned #113 follow-ups in DoxReloaded #299, DxMessaging #305,
IshoBoy #310, qora-redux #180, unity-builder #13, and unity-helpers #322.

## Baseline and scope challenge

The complete current six-repository audit reproduced 287 findings across 113
inventory rows. The smallest consumer, qora-redux, reproduced 18 findings.
Eight were attached to its hosted `unity-cleanup` job even though that job has
no acquire, activation, or Unity credential path and exists to satisfy the
documented runner-loss fallback contract.

Forcing a full acquire/return/classify/release/gate lifecycle into that hosted
fallback would invent a second paid lifecycle and weaken recovery. The selected
slice therefore corrects the central analyzer before any paid consumer run.

## Red and green

Red:

- `TestUnityEnrollmentAcceptsCanonicalFallbackCleanup` produced the eight
  full-lifecycle findings on a canonical fallback.
- Malformed fallback fixtures could not produce dedicated recovery-contract
  findings because no fallback classification existed.

Green:

- Canonical recovery jobs are inventoried as `fallback-cleanup`.
- The class requires no acquire, activation, or Unity credential reference; a
  hosted runner; an `always()` job and release; exact source-job holder
  identity; exact `unknown/healthy/return-terminated` evidence; step-scoped
  writer credentials; approved immutable release; propagated failures; and an
  always-reporting aggregate that checks both source and fallback jobs.
- Any Unity credential, activation, or acquire keeps the job in the full paid
  lifecycle audit.
- Same-repository PR guards are recognized when they are a top-level
  conjunction term, so stricter guards do not become false drift.
- Reviewed commit `6b7e4321f81fab1fde9c05f86c97c260c0280273` is approved without
  downgrading consumers past the incident and cleanup fixes after v1.10.0.

The current local organization audit drops from 287 to 278 findings. Qora drops
from 18 to 11: the former eight fallback findings become three precise
hardening findings for release shape, extra executable steps, and aggregate
coverage, and its reviewed acquire pin is no longer unapproved.

## Review and validation

Independent planning review reproduced the Qora findings and agreed that the
fallback job must not be removed or treated as a paid lifecycle. It recommended
the narrow recovery invariants and negative matrix implemented here.

The independent adversarial pass found and drove closure of opaque activation
steps, dynamic/self-hosted runners, source/fallback suffix mismatch, alternate
state locations, custom-shell aggregates, unsafe condition terms, short
timeouts, context-relative suffixes, missing writer credentials, and
case-variant action references. A fresh final pass reported no P1, P2, or P3
findings.

Focused enrollment tests pass. The complete verifier passes 604 Node tests,
every Go package, actionlint, module verification, workflow credential policy,
and the LLM harness. The exact local organization audit remains complete at
6/6 repositories and 113 inventory rows, with 278 truthful findings.

Hosted reviewers, PR delivery, merge, and post-merge audit remain to be
recorded.
