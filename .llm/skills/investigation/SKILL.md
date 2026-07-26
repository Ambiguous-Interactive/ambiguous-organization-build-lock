---
name: investigation
description: Diagnose bugs and unexplained behavior without guessing. Use when reproducing a failure, tracing a causal chain, analyzing an incident, or determining root cause before a fix.
---
# Investigation

Keep diagnosis separate from remediation. A request to analyze does not
authorize a fix.

## Evidence protocol

1. Record the symptom, expected behavior, scope, safety impact, and
   reproduction status: `reproduced`, `intermittent`, or `cannot reproduce`.
2. Prefer a deterministic reproduction. Minimize the input while preserving
   the failure; record exact commands and relevant outputs without secrets.
3. Trace the complete code and data path from input to the observed symptom.
   Inspect callers, callees, state transitions, recent history, error handling,
   cleanup, and operator-visible evidence. Do not stop at the first suspicious
   line.
4. State one falsifiable hypothesis at a time, including the predicted
   observation and evidence that would disprove it.
5. Run the smallest discriminating experiment. Instrument at boundaries when
   existing evidence cannot distinguish competing causes.
6. Record falsified hypotheses so later attempts do not repeat them. After
   three falsified hypotheses, stop changing variants, reframe the causal
   model, widen the trace, and identify the missing evidence.
7. Label the conclusion as `root cause demonstrated`, `probable cause`, or
   `unresolved`. `Cannot reproduce` is a valid outcome, never proof that no
   defect exists.

## Remediation gate

Only implement a fix when the task authorizes it and the evidence identifies a
causal mechanism. First add or identify a regression test that fails before the
fix and passes after it. A test that never demonstrated the failure is not
regression evidence.

Fix the narrowest root cause, not only the visible symptom. Re-run the original
reproduction in a fresh process or isolated fixture, then run adjacent and full
verification. If reproduction is unsafe or impossible, state the evidence
boundary and the manual or external check required.

## Report

Return:

- reproduction status and safety impact;
- observed facts, falsified hypotheses, and remaining open questions;
- causal chain and confidence label;
- fix status, regression evidence, and verification actually run;
- residual risk or explicit blocker.
