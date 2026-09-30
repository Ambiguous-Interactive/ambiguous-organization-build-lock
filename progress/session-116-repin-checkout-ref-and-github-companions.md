# Session 116: repin a consumer's policy checkout `ref:` and its `.github` companions

Date: 2026-09-30

## Open-issue priority

The live inventory held 15 open issues and no open central pull request.

| Priority | Issues | Impact and boundary |
| --- | --- | --- |
| P0 selected | #308 | The repin cannot carry DoxReloaded's `pin-literal` companions under `.github`, and does not move a checkout `ref:` that pins this repository. The fix is central, and no licensed Unity job changes. |
| P0 | #51 | App and organization-secret scope needs an owner inventory and negative probes. |
| P0 | #44, #255 | Four live rulesets accept any source App. Binding the issuer changes merge policy, which this task forbids. |
| P0 | #83 | Concurrent Unity returns report 400006 after a peer releases the shared seat. Needs owner-run licensed operations. |
| P1 | #278, #277 | Missing consumer test logs and absent canceller identity. Both need owner-run evidence. |
| P1 | #153, #229, #231, #249 | Native macOS and container return work needs reviewed authorization and licensed canaries. |
| P1 | #29, #53 | Lifecycle canaries, seven-day monitoring, and runner fairness need owner-run licensed operations and load evidence. |
| P2 | #126 | The reaper delivery alert. It self-resolved and no code defect was found. See session 115. |

#308 is the highest-impact item with a safe central code action. It was not a
cosmetic difference: a consumer that fetches the central policy in a `uses:`
line and again in a checkout `ref:` on the same step could be offered a release
whose policy it was not fetching, so the actions ran one release and the policy
was another.

## The shape of the fix

A `ref:` moves when four things hold, and each is read rather than assumed:

1. the `with:` block is a key of a step, found by column: the sequence item
   whose marker line's key column is the block's column;
2. the step runs `actions/checkout` at 40 lowercase hexadecimal characters;
3. the block names this repository exactly once;
4. the `ref:` is a direct child of that block with a 40-lowercase-hex value.

The anchor is the sibling `repository:` key and never the value of the `ref:`.
qora-redux checks out `unity-helpers` at a literal commit in a `with:` block
that looks identical, so a value-only rule would point that checkout at this
repository's release.

Four DoxReloaded artifacts are declared as `pin-literal` companions, which
fail closed if a stale pin constant survives that no moved pin accounts for. A
mechanical edit cannot tell a stale constant from a reviewed witness, so it
resolves neither and names the file.

## Twelve commits, and what each one corrected

Each commit message states what its own review found, including the commits
that introduced the defect. The series is one long argument between the review
and the previous commit's own claims.

| Commit | What it corrected |
| --- | --- |
| `1792bac6a` | Carry a policy checkout `ref:` through the repin. |
| `76db0d2fb` | A `run: \|` sample that looks like a pin is text, not a pin. |
| `967ef1cd6` | The block-scalar guard was shielding real pins. |
| `a8a6e29aa` | A quoted, cased or gapped `ref:` key froze a real pin. |
| `cb6479200` | Anchor the `ref:` on a checkout step, not a column. |
| `984b2e19b` | The key was read once; the step walk ran past its own step. |
| `e8f5ade3a` | Read a step, not a column, and report only what moved. |
| `e1e3e5088` | Anchor on the step that owns the block, not a marker above it. |
| `1d6201be0` | A child written as a sequence item lost its dash, so a file that parsed then did not. |
| `c50165400` | Read a `uses:` pin line the way its reader does, and compare the whole line. |
| `8e458dd30` | Name the `uses:` spellings the rewrite now reads. |
| `dbef5c55f` | A pin ending in a space froze, and a second `@` deleted text. |

The two that were wrong writes rather than frozen pins are recorded here
because they are the ones a future change could reintroduce: a `with:` block
holding a sequence item lost the `- ` in front of its key, so the rewrite
handed back a file that no longer parsed while reporting success; and a value
carrying a second `@` was cut at the first one, so the report claimed a move it
had not made.

## Verification

- `.devcontainer/scripts/verify.sh` exits 0: 961 tests, 955 pass, 6 skipped, 0
  fail, plus Go, race, vet, gofmt, golangci-lint, shellcheck, the JavaScript
  lint, the LLM harness, module verification and the credential audit.
- Every guard these commits add is mutation-checked on a copy under
  `/tmp/opencode/mut` with a trap-based restore, so a timeout cannot leave a
  mutant on disk. The survivors are the ones that are provably equivalent, and
  each commit message names its own count.
- The real DoxReloaded tree moves 17 pins: 12 `uses:` suffixes, 1 `ref:` value,
  4 companions. No stale SHA survives outside the temporary policy, and a rerun
  reports zero.
- qora-redux's `unity-helpers` checkout `ref:` is unchanged, checked against the
  real file and not a fixture.
- Seven adversarial review rounds, each against the prior commit's own claims.
  The last ran 130+ legal-YAML fixtures and found no corruption, which is the
  outcome that matters most in a rewrite.

## Known limits, all named in both documents

A shape the rewrite cannot read is not evidence, so it stays put with no
warning and no red run. The list in `docs/consumer-enrollment.md` and
`docs/operations-runbook.md` is the contract, and a shape missing from it is a
frozen pin behind a green run. The largest remaining one is a `uses:` key
GitHub's own schema does not accept, which this rewrite reads anyway because
reading it costs nothing and such a workflow fails GitHub's validation either
way.

The rewrite reads workflow text, not YAML. A file that is not valid UTF-8 is
round-tripped and loses the bytes it could not decode. That is unchanged from
before this series and is a separate piece of work.

## Pull request

#311, twelve commits, `main..repin-companion-and-checkout-ref`.
