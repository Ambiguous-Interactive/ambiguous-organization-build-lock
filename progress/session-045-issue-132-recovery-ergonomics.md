# Session 045: Issue #132 recovery ergonomics

Date: 2026-08-02

## Selection and priority audit

The live repository inventory contained 15 open issues and no open pull
requests. Priority was ranked by lock/license safety impact first, then by
consumer CI churn and whether the repository could complete the work without
owner-only settings, portal evidence, or a multi-repository rollout:

| Priority | Issues | Disposition |
| --- | --- | --- |
| P0 | #27, #44, #51, #53, #83, #113, #160 | High-impact follow-ups requiring external evidence, owner settings, consumer rollout, or unresolved entitlement behavior. |
| P1 | #49, #60, #94, #99, #132, #153 | Actionable ergonomics selected from this group because it is central-only and does not activate Unity or change lock policy. |
| P2 | #29, #30 | Monitoring and rollout trackers requiring live operational evidence. |

Issue #132 already had exact-ID recovery and a one-command dispatch. Its
remaining manual step was copying the incident ID into the workflow form.

## Safety hypothesis and implementation

The recovery form can omit `incident-id` safely only if the action resolves the
single schema-5 `activeIncident` from the same canonical state read, retains
the exact-ID comparison before writing, and continues to require explicit
portal-cleanup proof. It must not recover when state is absent or ambiguous.

The implementation follows that shape. An explicitly supplied ID remains
checked against state; an omitted ID is populated from the sole active
incident. The state write remains CAS-protected, and the existing ambiguous
write retry behavior remains unchanged.

## Verification

- Added a regression test for omitted-ID recovery and retained wrong-ID and
  missing-proof rejection tests.
- Focused build-lock tests and the complete repository verifier are required
  before merge.
- No organization policy, credentials, runner capacity, or live lock state
  was changed.

The change improves the normal operator path but does not introduce automatic
portal recovery or permit recovery of multiple/ambiguous incidents.

## Review and remediation

Cursor Bugbot reviewed the pushed head and found two actionable issues: the
omitted ID was rebound on each CAS retry, and operator documentation still had
conflicting exact-ID wording. The implementation now freezes the first bound
ID for the entire retry loop, adds a changed-incident CAS regression, and
synchronizes the action, lock, README, and operations-runbook language. The
focused recovery/documentation suite passes after remediation; a fresh full
verifier is required before merge.
