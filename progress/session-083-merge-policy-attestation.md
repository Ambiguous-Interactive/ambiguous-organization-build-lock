# Session 083: merge-policy attestation

The operator picked #252 option 3 (consumer attestation) as the resolution
of the ruleset bypass-actor retrieval gap. This session implements that
path, applies the two consumer settings fixes that a pull request cannot
make, and opens attestation pull requests for every carrying ruleset.

## Task, invariants, hypothesis

- Task: implement consumer-attested ruleset bypass evidence, clear the
  true drift in alert #255, and keep every fail-closed path intact.
- Invariants: no credential gains write access; missing or untrusted
  evidence still fails the audit closed; findings stay issue-visible;
  docs, tests, and workflow stay synchronized.
- Hypothesis: the audit can fill its one bypass blind spot from a
  consumer-published file and prove the file is fresh against live
  evidence, without weakening any check.

## Evidence

- The first audit run (34285720502) failed closed because GitHub returns
  ruleset `bypass_actors` only to ruleset-write callers (#254). The
  operator chose option 3: consumer attestation, not a write credential.
- Live reads with the operator user token (ruleset write, used only for
  evidence and the approved settings fixes):
  - DoxReloaded had no required aggregate. Ruleset 22595536
    `Required CI - Success (default branch)` now requires `CI Success`
    with an empty bypass list (operator-approved live fix).
  - qora-redux classic branch protection let administrators bypass
    required checks. `enforce_admins` is now `enabled: true`; every other
    protection setting is unchanged (operator-approved live fix).
  - DxMessaging ruleset 17663217 grants Integration 3977200 an `always`
    bypass. This is real drift; the audit will report it as
    `unexpected-bypass-actor` once the attestation lands, until review
    accepts the actor into `merge-policy-expectations.json`.
  - IshoBoy ruleset 4545251 has an empty bypass list.
- Both approved settings fixes were verified by reading the settings back
  from the API after the change.

## What landed

- `internal/mergepolicy/attestation.go`: the attestation schema, a strict
  parser, and `ResolveBypassEvidence`. A carrying ruleset whose live
  bypass evidence is hidden must have a fresh attestation; a missing one
  fails the audit closed, a stale one fails closed when it hides the only
  bypass evidence and stays a visible finding when live evidence exists.
- `internal/mergepolicy/audit.go`: new codes
  `merge-policy-attestation-missing` and `merge-policy-attestation-stale`;
  tri-state bypass evidence on `Ruleset` (`BypassKnown`); attested actors
  render with an `(attested)` marker; shared `CarryingRulesetIDs` helper.
- `cmd/audit-merge-policy`: reads the attestation file from the default
  branch with the reader token, records attested ruleset ids in the
  artifact, and treats an unparseable published file as fail-closed.
  `retrievalError` was removed; the bypass fail-closed point moved into
  the reviewed resolver.
- `.github/workflows/merge-policy-audit.yml`: the minted reader token now
  also carries Contents read. The reader App already holds that
  permission; no App change and no write scope anywhere.
- Live ruleset names and required contexts are compared raw and sanitized
  only at render time. IshoBoy requires contexts such as
  `Validate YAML & Workflows` that contain characters outside the
  publishable alphabet; a sanitized comparison could never match.
- Consumer attestation pull requests, each carrying the exact live
  ruleset evidence read on 2026-09-09:
  - DoxReloaded #815 (ruleset 22595536, no bypass actors)
  - DxMessaging #564 (ruleset 17663217, Integration 3977200 always)
  - IshoBoy #873 (ruleset 4545251, no bypass actors)
- `docs/consumer-enrollment.md`: two new finding-code rows, the
  attestation contract with the file shape, and corrected retrieval
  guidance. `docs/operations-runbook.md`: the merge-policy audit uses
  Administration read and Contents read.
- qora-redux needs no attestation: classic protection bypass evidence
  stays readable with Administration read.

## Durable learning (continuous-improvement gate)

- Promote: the attestation contract is documented in
  `docs/consumer-enrollment.md`, the place consumers already read for the
  finding-code contract. No `.llm` edit: the fact is contract-specific.
- No code weakened: the resolver fails closed on missing or untrusted
  evidence, and the existing retrieval fail-closed paths are unchanged.

## Verification

- `go test ./...`, `go test -race ./...`, `go vet ./...`,
  `golangci-lint run --timeout=5m` (0 issues), module verify and tidy:
  pass.
- `node --test test/*.test.js`: 874 pass, 6 skipped (0 fail). The
  workflow-policy test locks the new Contents read token permission.
- `bash tools/workflows/ci.sh javascript`, `ci.sh shellcheck`,
  `go run ./cmd/workflow-credential-audit .`,
  `node tools/llm-harness.mjs check`: pass.
- All three published attestation files parse with the production
  `ParseAttestation`.

## Follow-ups

- The three attestation pull requests are consumer decisions. Until each
  merges, that repository reports `merge-policy-attestation-missing` and
  the run stays red by design.
- DxMessaging Integration 3977200 needs a review decision: remove the
  bypass or record it in `merge-policy-expectations.json` (then extend
  the schema with its mode per #254).
- unity-helpers still has no merge gate; the attestation is irrelevant
  there until a ruleset requires the reviewed aggregate (#255 finding).
- The next daily run proves the pipeline end to end: with all three
  attestations merged, the audit reports complete with only the true
  DxMessaging and unity-helpers findings.
