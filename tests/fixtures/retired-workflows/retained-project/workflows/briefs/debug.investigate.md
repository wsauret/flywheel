---
name: Investigate
description: Investigate a reported issue, trace the causal chain, and form a confirmed hypothesis.
dependencies: [root-cause-analysis]
output:
  summary: Concise result of the investigation.
  fields:
    hypothesis:
      type: string
      nullable: true
      description: Confirmed root cause and full causal chain. Use null only when decisive evidence proves there is no defect or change to make. Never use null for an inconclusive or inaccessible investigation.
    evidence:
      type: list
      of: { type: string }
      min: 1
      description: Decisive fresh runtime, code, or test observations from this agent.
---

# Debug - Investigation

This agent runs the composed root-cause method and stops at its causal-chain gate. It never edits files: the fix phase owns the change.

---

## Part 0: Problem Contract

- Extract the actual behavior, expected behavior, scope, supplied identifiers, constraints, and prior attempts from the request and prior context.

---

## Part 1: Research

Investigate without editing files:

1. Locate the subsystem that owns the observed behavior. Read the entry point, the value's source, its callers, and its consumers.
2. Check environment assumptions only when evidence makes an environment mismatch plausible.

---

## Part 2: Diagnose

Apply the composed method to the report and the evidence selected above.

Classify the result as positive, decisive negative, or inconclusive. A positive result confirms the defect and causal chain. A decisive negative proves that there is no defect or change to make. If available evidence is inconclusive, message your parent with `message_session` and wait true, ask only for the specific inaccessible evidence that can unblock the investigation, and continue from its reply. If the reply does not supply the evidence, message your parent again with the blocked or exhausted result of the composed method, and wait true for its decision. An inconclusive result is never a hypothesis and never null, so Fix cannot run on an invented root cause.

---

## Investigation handoff

A successful investigation emits either a confirmed defect or a decisive no-change result:

- `summary`: State how the problem was confirmed, or what proved that no change is needed.
- `hypothesis`: State the confirmed root cause and full causal chain with file and line references. Use `null` exclusively for a decisive no-change result.
- `evidence`: Cite at least one decisive runtime fact, code invariant, test result, or safe reproduction result. Name where and how the symptom was observed, so that Verify observes it the same way.

For a decisive no-change result, cite inspected paths, observations, and why they settle the report. Do not use `null` when evidence is inconclusive or inaccessible. Hand off a hypothesis only when its causal chain is complete.
