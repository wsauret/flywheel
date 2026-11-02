# Review Briefs

Read this when you write a brief for a phase that reviews a plan or a code change, or that refines a plan from review findings.

A review brief wires the phase: what it reviews, against which intent, with which evidence, and what it returns. The review method stays with its owners. Name the owner and do not restate its method.

## Wiring checklist

- **Intent.** Keep approved Design intent and Decisions in the conversation checkpoint; the runtime carries them to reviewers read-only. Send later intent changes under the same heading. Pass implementation deviations through the preceding handoff or `reads: [<implement phase>]`; use `description` for a separate review workflow.
- **Authorities.** Name binding paths under PROJECT CONTEXT PATHS in `description`. Reviewers read that list, not a new authority search. Forward a spec's `consulted` list with `reads: [<spec phase>]` and tell the coordinator to pass it under that heading.
- **Parent.** Name corrections that would change the Design intent or an explicit choice of the person, and evidence that the intent cannot hold. A reviewer tags these contradictions as findings. A refine phase does not integrate them or leave them as final open questions: it asks the parent and waits.
- **Individual reviewer.** Use `persona: reviewer-code-<lens>` for code or `persona: reviewer-plan-<lens>` for a plan. Never mix families. Their `code-review-method` or `plan-review` owns read-only evidence, location format, severity, unsettled claims, and results. State only the target and output contract. Never give an individual reviewer `code-review`, which dispatches reviewers. Refer to the Review shape and `examples/lens-review.workflow.yaml`. A `reviewer-uat` observes a running change and refuses a plan.
- **Lenses.** Choose the reviewer agents with the triggers in `code-review`, 'Select the reviewer set': load it and add one agent for each lens that the target triggers, and none that it does not trigger. The quality and elegance pair in the Review shape is its standard tier, not a fixed set. A file that you launch again for each unit needs each lens that the next unit triggers: add that agent to the file before that launch.
- **Coordinator.** Compose `dependencies: [code-review]` for reviewer selection, prompts, claims, synthesis, and arbitration. Composition does not grant personas: list each permitted reviewer in `subagents`. Use the target's family and `reviewer-mechanism` for runtime claims. List fewer when the phase must use fewer. Add `implementation-planning` only when refinement reshapes milestones.
- **Evidence budget.** Name the exact plan path, or diff base and changed files. Permit the needed read-only commands, narrow tests, and scratch probes. A ban on target edits is not a ban on evidence. Limit each reviewer to the target: it follows each result into the code that consumes it, settles each assigned claim or names it unsettled, and then reports. It does not audit code that the target does not reach.
- **Report.** Return findings and stop. Declare fields that the consumer reads. For parallel reviewers with a `dedupe` join, key findings by family: `<path>:<line>` for code, `<milestone_id>` or `<milestone_id>/<task_id>` for plans (`references/reducers.md`, "Keys").
- **Refine.** Name one canonical file and one writer: reviewers report, the coordinator writes. Permit no sidecars, backups, or drafts. Declare the file as an output `path` so the host checks existence. With no findings and no unresolved claims, leave the plan unchanged and report ready.
- **Integration.** Fold each accepted correction into the owning task; add a task only when none can own it. Keep the prevented failure beside each correction. Retain rejected or deferred findings with reasons and the assumption behind rejected hardening. A later reviewer must refute that reason before raising it again. The `code-review` skill owns arbitration, structural reshape, and the whole-plan sweep.
- **Commitments.** Copy commitments forward; change one only with a stated reason. Report a missing commitment as the producer's defect.

## Skeleton

```yaml
phases:
  - phase: refine
    brief: >-
      Review the plan at the path in the request with the composed method.
      Keep the approved intent in your checkpoint and pass the PROJECT CONTEXT PATHS to each reviewer.
      Integrate the accepted findings into that file and write no other file.
      With no findings and no unresolved claims, leave the plan unchanged.
      When an accepted correction would change the Design intent or an explicit choice of the person,
      or evidence shows that the Design intent cannot hold, do not integrate it.
      Message your parent with message_session and wait for the reply.
    dependencies: [code-review]
    subagents: [reviewer-plan-quality, reviewer-plan-elegance, reviewer-plan-performance, reviewer-plan-data-integrity, reviewer-plan-security, reviewer-plan-design, reviewer-mechanism]
    output:
      summary: The integrated, deferred, and rejected findings, and each changed commitment with its reason.
      fields:
        plan: { type: path }
        changed: { type: boolean }
```
