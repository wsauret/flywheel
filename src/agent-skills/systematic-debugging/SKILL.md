---
description: Use when diagnosing, fixing, and verifying a reported defect end to end.
dependencies:
  - root-cause-analysis
  - test-driven-development
  - verification
---

# Systematic Debugging

Diagnose first, then fix only the confirmed cause, then prove the original behavior independently.

## Input

Start with a specific defect, expected behavior, available evidence, reproduction constraints, and permission to edit.

## Method

1. Run the composed root-cause-analysis method. A decisive `no-defect` result is successful completion with no edit. Stop unsuccessfully if it returns `blocked` or `exhausted`.
2. Preserve the confirmed trigger-to-symptom causal chain and its evidence per edge.
3. In interactive chat only, after `confirmed`, load the `design` skill and propose the fix through it; its scope check decides whether approval is needed, and approval resumes this method. Any agent outside an interactive chat follows its brief autonomously.
4. Create the smallest diagnosis-scoped regression through the composed test-driven-development method. If honest RED cannot be established, use only that method's declared fallback or blocked result.
5. If any new observation refutes a causal edge, return to diagnosis. Do not continue editing a disproved explanation.
6. Implement the smallest fix at the point where valid behavior first becomes invalid. Change one causal mechanism, not a cluster of symptoms.
7. Apply the composed verification method through fresh verification of the original symptom, focused regression, and intended diff on the present tree. Always observe the original symptom on the surface where the report observed it, such as the installed binary, the client, or the command that the user ran. A passing regression test never replaces this observation. Past observations, including GREEN from the fix, guide hypotheses only, never current acceptance. Run the fewest decisive fresh checks plus explicit repository gates; do not add an unrelated adjacent path or full suite. Within this verification pass, one fresh check may prove multiple claims; stop once the required evidence is complete.

## Stop and result

Stop with `fixed`, `no-defect`, `blocked`, `failed-verification`, or `escalated`. For `no-defect`, report paths inspected now, fresh observations, and why they decisively settle the report. For a fix, preserve the causal chain and report changed files, RED and GREEN evidence or the declared fallback, fix summary, fresh final proof, and remaining risk. State confidence per the composed verification method.

## Failure

Unsafe edits, unavailable decisive evidence, a regression that cannot reach GREEN, or unavailable decisive verification stop with work preserved. A failed verification is not success. Return to diagnosis when proof refutes the cause, and escalate with tested hypotheses and the next discriminating trace when no new evidence remains. Do not use workflow phase, handoff, or retry-control vocabulary.