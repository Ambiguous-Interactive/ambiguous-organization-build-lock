# Session 042: Central action ownership enforcement

Date: 2026-08-01

## Selection and hypothesis

The live repository inventory had 16 open issues and no open pull requests.
Issue #171 is the highest-impact actionable issue that can be advanced without
changing organization settings, credentials, or paid-license capacity. Its
clarification requires action files to be maintained in this repository rather
than referenced from another internal repository.

Hypothesis: the current enrollment analyzer can report a clean licensed job
while a non-licensed step calls an organization-owned action file from another
repository, because it only classifies local actions and central lock actions.
The falsifier is a fixture containing a foreign organization action-file call
that produces `foreign-action-reference`.

## Baseline and scope

A fresh shallow clone of the six registered active repositories was inspected
at each default branch. No active workflow contained a cross-repository
`.github/actions` call. The only historical match was in IshoBoy progress text;
its live workflow now uses the central preflight at the reviewed immutable
commit. Existing repository-local diagnostic and test composites remain local
by design and are not action-file references to another repository.

The change is limited to the source analyzer, its table-driven regression test,
and the enrollment contract documentation. It does not change lock capacity,
organization settings, App installation, secrets, or consumer workflows.

## Implementation

Every parsed workflow step now checks remote action ownership. A path beginning
with the organization name and containing `/.github/actions/` is accepted only
when it begins with the central lock repository action prefix. Other
organizations and `/.github/workflows/` reusable calls are not classified by
this finding because they have separate policy paths.

## Verification

Focused test:

```text
go test ./internal/enrollment -run 'TestForeignOrganizationActionFilesAreRejected|TestCancellationPolicy' -count=1
passed
```

The test covers a foreign action file, the central action namespace, a foreign
reusable workflow, and an action path in another organization. The complete
enrollment audit scan found zero live cross-repository action-file references
before this enforcement was added; the new mutation prevents future drift.

## Review boundary

The remaining work for #171 is any future migration of repository-specific
implementation, if a consumer demonstrates that it is genuinely centralizable.
This PR establishes the central ownership guard without replacing diagnostic or
test logic with an unreviewed generic action.

## Adversarial review and remediation

Copilot review of the first pushed head found that the check covered direct
workflow steps but not `runs.steps` inside a local composite action. That was a
reachable bypass of the stated snapshot-wide contract. The analyzer now applies
the same ownership check while recursively loading composite manifests, and a
regression test proves the wrapper path emits the same finding. The prior head
is not treated as complete evidence; full verification and a fresh exact-head
review are required after this remediation.

Cursor's fresh exact-head review then found that raw string matching missed
path-equivalent action references such as `.github/workflows/../actions`. The
ownership check now parses the remote repository tuple and normalizes its action
path before classifying it; dot and parent-path mutations are covered by the
table-driven test. This second finding was also fixed before merge readiness.
