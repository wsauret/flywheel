---
name: Fix
description: Implement and verify a fix for the confirmed root cause, or repair the defects that Verify listed.
dependencies: [test-driven-development]
output:
  summary: Concise result of the fix.
  commands: { min: 1 }
  fields:
    hypothesis:
      type: string
      description: Confirmed root cause and full causal chain.
    fix_description:
      type: string
      description: The applied change and why it addresses the root cause.
    evidence:
      type: list
      of: { type: string }
      min: 1
      description: Decisive fresh runtime, code, or test observations from this agent. Prior records guide hypotheses only, never current acceptance.
---

# Debug - Fix

Make one focused change, with the failing regression written first per the `test-driven-development` package composed above. The artifacts in `## Inherited Artifacts` select the pass:

- `debug-investigation` without `debug-verification`: the first pass. The investigation's `hypothesis` is the confirmed root cause, and its evidence supports it. Fix only that diagnosis.
- `debug-verification`: a repair pass. Each item of its `defects` is a check that still fails on the present tree. Run each one again, diagnose from its output why it still fails within the confirmed causal chain, and repair it on the present tree. `debug-fix`, when present, is the previous pass: keep its changes unless a defect traces to one of them.

Do not reconstruct an older workflow state: the present tree and the inherited artifacts are the inputs of this pass. When the investigation's `hypothesis` is null, no root cause is confirmed and a listed defect refutes the investigation: return control to Investigation.

---

## Scope of this fix

- Address the confirmed root cause, or the listed defects, and nothing else.
- If no test framework is available, use the narrowest safe behavior check the investigation evidence supports.
- One targeted change, then run the focused check. This agent owns the focused failing regression and its GREEN proof; Verify owns fresh final verification and explicit repository gates.
- When a targeted change fails, diagnose why it failed. If the diagnosis refutes the confirmed causal chain, stop without another edit and return control to Investigation. Do not invent a new diagnosis here.

---

## Return to Investigation

When the confirmed chain no longer holds, or no root cause is confirmed, make no further edit. Investigation is not a later phase of this workflow, so send this report to your parent with `message_session` and wait true, and continue from it:

```
## Refuted Diagnosis
- Problem: <original description>
- Confirmed chain under test: <the investigation's causal chain>
- Targeted change attempted: <the one change and why the chain predicted it>
- Refuting evidence: <the fresh output that contradicts the chain>
- Changes made so far: <list of files modified, and whether they are still applied>
- Recommendation: <what Investigation should trace next>
```

---

## Fix handoff

- State the confirmed causal chain in `hypothesis`, with what a repair pass traced within it. Record this agent's fresh RED and GREEN observations of the focused regression in `evidence`; investigation proof guides the hypothesis but is not this agent's acceptance evidence.
- In a repair pass, name each listed check in `evidence` with its fresh result.
- State the completed fix in `summary` and record the applied change in `fix_description`.
- Cite the commands that ran the focused regression in `commands_run`. Verify independently runs the smallest decisive fresh checks and explicit repository gates.

Hand off when the focused test or behavior check passes for the right reason. A failed check is work to revise from its output, not a reason to stop.
