---
description: Use when diagnosing, fixing, and verifying a reported defect end to end.
dependencies:
  - root-cause-analysis
  - test-driven-development
  - verification
---

# Systematic Debugging

Diagnose first, then fix only the confirmed cause, then prove the original behavior independently. The root-cause-analysis, test-driven-development, and verification instructions are included with this skill; do not load them again.

## Input

Start with a report of one or more defects, expected behavior, available evidence, reproduction constraints, and permission to edit.

## Method

1. Diagnose with the root-cause-analysis instructions. When the report names several defects, collect all reported symptoms first, then find the cause of each. A decisive `no-defect` result is successful completion with no edit. On `blocked` or `exhausted`, stop when a person reads the result. When no person can answer, such as in an unattended run, continue with the best fix that the evidence supports and state what stays uncertain.
2. Keep each confirmed causal chain with its evidence per edge.
3. In interactive chat only, after `confirmed`, load the `design` skill and propose the fix through it; its scope check decides whether approval is needed, and approval resumes this method. Any agent outside an interactive chat follows its brief autonomously.
4. For each cause, write the smallest regression test that fails because of the defect, as the test-driven-development instructions say. If no such test is possible, use only their `skipped` or `blocked` result.
5. If any new observation refutes a causal edge, return to diagnosis. Do not continue to edit for a disproved explanation.
6. Fix each cause at the point where valid behavior first becomes invalid. One fix changes one causal mechanism, not a cluster of symptoms.
7. Apply the verification instructions through fresh verification of each original symptom, each focused regression, and the intended diff on the present tree. Always observe the original symptom on the surface where the report observed it, such as the installed binary, the client, or the command that the user ran. A passing regression test never replaces this observation.

## Stop and result

Stop with `fixed`, `no-defect`, `blocked`, `failed-verification`, or `escalated`. For `no-defect`, report paths inspected now, fresh observations, and why they decisively settle the report. For a fix, report each causal chain, changed files, RED and GREEN evidence or the `skipped` result, fix summary, fresh final proof, and remaining risk. State confidence as the verification instructions define it.

## Failure

Unsafe edits, a regression that cannot reach GREEN, or unavailable decisive verification stop with work preserved. A failed verification is not success. Return to diagnosis when proof refutes the cause. When no new evidence remains, escalate with tested hypotheses and the next discriminating trace if a person reads the result; otherwise make the best supported fix as step 1 says.