---
description: Use when implementing a bounded change or settled implementation specification.
dependencies:
  - implementation-planning
  - test-driven-development
  - verification
---

# Implementation

Complete the bounded task against real code, preserve unrelated work, and prove the delivered behavior.

## Input

Start with the section of your brief labeled Design intent, the task or implementation specification, acceptance criteria, and current repository. Read named code, load-bearing callers, tests, and boundaries. Design intent defines the outcome and is not yours to change; everything else in the brief is implementation design, a starting hypothesis you revise against the code and record as deviations, not an immutable script. A brief with no labeled Design intent gives you the requested outcome as the fixed tier.

## Method

1. Verify every named path and inspect the nearest established pattern.
2. Trace signature, schema, registration, and wiring changes through all load-bearing callers and consumers.
3. Own newly discovered uncertainty inside the task. Technical diagnoses and implementation designs are hypotheses, not user goals or constraints. State what observation would support, narrow, or reject each material hypothesis, then use the smallest fresh focused experiment or real observation that decides it. A freshly run existing check is decisive only for what that code does; a claim about an external service, a dependency, or runtime behavior is settled by a throwaway probe against the real thing, before you build on it and again after. Past observations guide hypotheses but cannot establish the current state. Revise or drop the implementation plan when evidence contradicts it. Cut or simplify proposed work when evidence supports it while preserving every approved outcome. Expand scope only by the smallest amount demonstrated necessary for an approved outcome, and defer independent improvements. Remaining work, elapsed effort, or needing another implementation pass is not a blocker. Preserve user intent, explicit user prohibitions, and required quality checks. Missing paths, extra callers, inaccurate estimates, and a failed planned approach require investigation and a revised attempt, not a blocked result.
4. Use the composed test-driven-development method for behavior changes.
5. Implement the smallest complete change. Validate external boundaries, trust canonical internal state, keep one source of truth, and avoid speculative fallbacks, compatibility shims, forwarding wrappers, and single-use abstractions.
6. Preserve unrelated work. Fix dependencies and defects needed to deliver the requested outcome; report unrelated improvements rather than adding them.
7. Run narrow feedback while editing. Use the composed verification method for the smallest complete fresh post-implementation proof of the predicted benefit and preserved contracts. Tests alone can suffice; exercise the real user surface only for an evidence gap, explicit acceptance requirement, or explicit repository gate. Run the deciding checks against the current implementation; do not recycle earlier observations as acceptance evidence.
8. Inspect the final changed code for scope, dead code, accidental complexity, and unclear names. Delete every line whose removal would not change required behavior.

## Milestones

When the change is larger than one bounded pass, decompose it with the composed implementation-planning method before editing, and verify each milestone with its own command as you land it.

## Sizing

{{if:subagent}}
When you can dispatch implementer subagents, size the work before you edit. Without that grant, implement every unit yourself.

- Implement one bounded unit inline.
- Send separable units whose files do not overlap to implementers that run at the same time.
- Run dependent units one after another, and revise the plan from each result before you send the next unit.

Dispatch only when it saves more work than it adds. When you dispatch, you own the whole change:

- Send each unit a packet: its id, goal, expected-touch files, tasks, and verification command. Add the files that you verified with a one-line reason each, constraints labeled as revisable design, and only the earlier outputs that the unit consumes. Do not send the whole plan. For a group of review findings, send the verbatim findings, the write set, the rationale, and a narrow verification hint; the child reads the whole group, not the whole review, and reports structural changes outside the write set.
- Fix a defect that you diagnosed yourself inline. A large follow-up packet names the failing command, the root cause, and the exact files, not a discovery task.
- Each child returns local proof and deviations. Verify each unit again on the current tree, own integrated acceptance, and run the checks that judge the whole tree once, on the integrated tree, after every unit is done. Sizing changes who does the work, never whether evidence is fresh or whether a required check runs.
- Your result accounts for the whole change, including each child's work and deviations.
{{else}}
Implement every unit yourself.
{{end}}

## Rules

- Exact literal content is byte for byte. When the user says a file must contain exact text, preserve it exactly, verify with exact equality rather than substring checks, and never add a trailing newline, punctuation, or quoting convention the user did not request. Do not state a byte count you did not compute.
- Revert an out-of-scope file only when its exact prior contents are recoverable from git, a diff, session artifacts, or tool logs. Never guess, truncate, or replace a file with placeholder content; report the gap instead.

## Stop and result

Return the best complete, directly verified implementation of the requested outcome. A no-change result is complete when decisive evidence proves the outcome is already satisfied or the proposed work is unnecessary; report that evidence instead of fabricating edits. This is a reviewable first draft, not a claim of perfect fidelity to the initial spec. Report material deviations with the original choice, discovered evidence, revised choice, and verification. Report each material choice that the brief left open the same way, with the option taken and why. The parent reviews the draft against user intent and owns further iteration. Do not omit requested behavior or weaken checks to claim completion.

## Failure

A failed approach is a reason to investigate and try an alternative. Do not stop merely because the spec or low-level design cannot work. Only a demonstrated external prerequisite or explicit user prohibition that prevents any viable next action warrants an unresolved report; name the evidence and attempted alternatives. Never fabricate success or bypass consent for an independently restricted action. Commit, push, and publication remain the dispatching agent's responsibility unless assigned to you.