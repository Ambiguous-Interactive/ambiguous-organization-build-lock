# Session 034: Isho cleanup canary

Date: 2026-07-30

Status: trusted-main canary complete; owner portal attestation and delivery pending

## Objective and safety boundary

Review every open issue and pull request, rank the work by impact while
favoring the least licensed Unity churn, and complete the highest-priority
issue whose full acceptance criteria can be satisfied safely.

Issue #54 is selected. It is the narrowest open lifecycle gap and a dependency
of the post-activation monitoring tracker in #29. Its production workflow
already contains the intended private return-log wiring, so its remaining
closure evidence is one controlled trusted-main canary, an auditable evidence
record, and authorized owner portal attestation rather than another consumer
workflow change.

The canary must preserve these invariants:

- licensed work starts only after reader preflight and FIFO acquire;
- activation, Unity work, and return use the same physical runner;
- missing or ambiguous cleanup remains red and capacity-consuming;
- PlayMode may pass without activation only through an explicit, data-driven
  no-test classification;
- cleanup and the stable aggregate must finish without cancellation;
- private return logs, credentials, account data, and serial fragments are
  not published.

Disconfirming evidence would be an untrusted or non-main dispatch, skipped
EditMode work, accidental skip/green PlayMode behavior, an absent or failed
fallback cleanup job, a green aggregate after incomplete work, a return log in
retained artifacts, or a cleanup result that leaves the canary's activation
unexplained.

## Issue and pull-request inventory

The clean checkout started at `ed9945f49`, equal to `origin/main`. GitHub
reported 13 open issues, no open or draft pull requests in this repository,
and no Dependabot pull request. The complete local verifier passed at that
baseline with 604 Node tests, all Go packages, both module verification and
tidy gates, actionlint, the generated knowledge checks, and the credential
audit.

| Priority | Issues | Impact and disposition |
| --- | --- | --- |
| P0 constrained | #83 | Highest active production defect. Independently replicated shared-entitlement returns create false-red `400006` cleanup and benign quarantine. Safe closure requires central lifecycle semantics, consumer repins, both return orders, and portal-reconciled proof; unknown cleanup cannot be reclassified as safe. |
| P0 broad | #113 | The complete enrollment audit reports 278 findings across 113 active jobs in six repositories. A clean audit requires broad consumer remediation and has the highest Unity churn. |
| P0 owner-constrained | #51 | Organization secret and App installation scope is a credential boundary, but its acceptance requires owner control-plane changes prohibited by this objective. |
| P1 selected | #54 | The trusted-main Isho cleanup canary closes the code-visible lifecycle evidence gap with one intentional Unity run and no workflow edit or consumer repin; authorized owner portal attestation remains required for issue closure. |
| P1 policy | #44 | Truthful required aggregates and rulesets span every consumer and require organization policy work. |
| P1 architecture | #53 | Pre-runner FIFO starvation requires a new fail-closed queue/claim protocol and live two-runner proof. |
| P2 throughput | #99, #49 | Consumer retry timing and the 15-leg unity-helpers graph require multi-repository measurements and workflow changes. |
| Operational | #29, #27 | Deliberate canaries and a seven-day monitoring gate remain; #27 closes with #29. |
| Tracker | #30 | Umbrella rollout closure depends on its remaining child and owner-only work. |
| Safety-blocked | #60 | Literal zero cooldown remains blocked by #83 and requires all consumer repins plus a cross-runner canary. |
| Upstream-blocked | #94 | actionlint v1.7.12 remains latest and does not compile with yaml/v4 rc.6; direct unused transitive overrides are explicitly prohibited. |

The root Go module is current. The isolated actionlint module advertises only
the known incompatible yaml update and actionlint-owned unused transitives.
No dependency update can be incorporated safely in this PR.

## Baseline and canary design

An existing same-repository PR run, IshoBoy `30499717852` at exact head
`a2a12ce3113a7daab9f3ffeb6a75287acf4a6bb8`, supplied a non-closing baseline:

- reader-visible runner preflight, compile, EditMode, both fallback cleanup
  jobs, and `Unity CI Success` completed successfully;
- EditMode ran 652 tests with 652 passing and emitted exact positive return
  evidence;
- PlayMode discovered no assemblies, ran the named no-assemblies policy step,
  and intentionally did not acquire or activate;
- the workflow source used the private runner-temp paths
  `unity-return-compile.log` and `unity-return-${testMode}.log`;
- its retained artifacts contained only compile diagnostics and EditMode test
  results, with no return-log file, email-shaped value, PEM, password, serial,
  license XML, or private-key marker.

That run proved the mechanics but was a `pull_request` event on an unmerged
head. It did not satisfy #54's trusted-main requirement, so it was not used as
closure evidence.

The selected experiment dispatched the existing `Unity CI Validation`
workflow on IshoBoy `main` commit
`a7adb5cc64f475c639de8a4ead80b8c20dea4d93`. The workflow declares
`cancel-in-progress: false`; no workflow, lock configuration, organization
policy, credential, or consumer pin was changed.

## Trusted-main result

IshoBoy workflow-dispatch run
[`30501396253`](https://github.com/Ambiguous-Interactive/IshoBoy/actions/runs/30501396253)
at exact `main` commit
`a7adb5cc64f475c639de8a4ead80b8c20dea4d93` completed successfully without
cancellation:

- `Current PR Head Guard` and `Self-hosted runner access preflight` passed.
- `Unity Full Compile Check` job `90741673282` ran on one registered Windows
  runner, acquired the FIFO lock, completed the compile sentinel, emitted
  exact positive Unity return evidence, and released. Hosted fallback cleanup
  job `90742646226` passed. The exact runner identity remains available in the
  access-controlled job metadata and is not duplicated in this public record.
- `Unity Tests (EditMode)` job `90742675058` used that same registered runner
  identity, acquired the FIFO lock, produced a valid result with 655 of 655
  tests passing, emitted exact positive Unity return evidence, and released.
  Hosted fallback cleanup job `90746097598` passed.
- `Unity Tests (PlayMode)` job `90742674810` discovered no PlayMode assemblies,
  completed `Skip PlayMode tests (no assemblies)`, and intentionally skipped
  Unity resolution, acquire, test, return, release, and result upload.
  Its hosted fallback cleanup job `90746097623` still passed.
- The stable `Unity CI Success` job `90746120012` passed only after compile,
  EditMode, PlayMode policy, and both cleanup jobs reached their required
  terminal states. No environment approval or cancellation supplied the
  result.

The exact positive return annotations explain both licensed activations, and
the two fallback cleanup jobs independently confirmed that the canary retained
no lock ownership. A fresh central read also found no active account incident.
Those GitHub-side facts do not independently inspect the Unity portal. Issue
#54 therefore remains open until an authorized owner records a value-free
post-run portal confirmation that no unexplained activation remains.
Detailed canary evidence was linked to #54 in comment `5124846796` and to the
#29 monitoring tracker in comment `5124849124`; correction comments
`5124903805` and `5124914239` preserve the portal-attestation boundary.

GitHub retained exactly two artifacts:

- `unity-EditMode-results`, digest
  `sha256:2adcbf76717f563732434eef4c209c5c25b3106f8510e47d0d70f44eab6e52b8`;
- `unity-compile-check-logs`, digest
  `sha256:b4956c360187dc4c5877f4aba79ae3009a8ae947eadb2c04a7cd9d69571b1bf1`.

A bounded download enumerated 14 files under the documented compile-log and
EditMode-result paths. A filename check found zero private return-log files.
A separate content scan read the retained files without printing their
contents and reported zero files matching email, PEM, password, private-key,
serial, license-XML, or Unity-credential-name shapes. Only filenames and
aggregate match counts were emitted.

## Follow-up found during the canary

The earlier PR run's valid EditMode result was followed by a Windows
`STATUS_ACCESS_VIOLATION` during Unity shutdown. The durable verdict had
already been written and exact positive license return evidence followed, so
the anomaly did not invalidate cleanup evidence. It is nevertheless a
separate editor/test-runner reliability risk.

IshoBoy issue
[#313](https://github.com/Ambiguous-Interactive/IshoBoy/issues/313) records the
reproduction boundary, sanitized investigation plan, fail-closed constraints,
and acceptance criteria. The trusted-main canary reproduced the same anomaly
for the compile sentinel and for a 655-of-655 passing EditMode result, so that
evidence was added to #313. Both jobs then returned with exact positive
evidence and released cleanly. This PR does not change Isho's durable-verdict
policy or conceal the native process anomaly.

## Validation and review

The progress record is public audit evidence and contains only repository,
commit, workflow, job, result-count, reason-code, digest, and decision facts.
It contains no raw logs, live lock state, credentials, account identifiers,
personal data, or serial fragments.

Fresh complete local verification passed:

```text
.devcontainer/scripts/verify.sh
LLM harness checks passed.
tests 604; pass 604; fail 0
all Go packages passed
both modules verified
Workflow credential-literal policy passed.
```

Independent adversarial review round 1 accepted the trusted-main EditMode,
PlayMode-policy, aggregate, and cleanup evidence, but found that exact positive
return did not prove the explicit portal inventory requirement. It also asked
for authoritative #29 linkage, found a physical hostname in the public record,
and identified ambiguous wording that made a content scan sound like a
filename-only scan. The remediator cited the exact #29 comment, retained #54 as
open pending owner portal attestation, removed the hostname, and described the
two artifact checks precisely. Independent adversarial review round 2 inspected
the latest record and found no remaining actionable finding.

PR CI, exact-head Cursor and Copilot review requests, merge evidence, and
post-merge `main` verification remain pending.

## Continuous improvement

Trigger: this session performs a licensed lifecycle canary and creates a
cross-repository operational evidence record.

Observed fact: exact positive return and central cleanup evidence do not prove
an independently named portal-inventory acceptance criterion. The existing
investigation and continuous-improvement guidance already requires evidence at
the same scope as each requirement. Promotion decision: no durable learning;
this task-specific boundary belongs in #54 and this record rather than a
duplicate skill rule.
