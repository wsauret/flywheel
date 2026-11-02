---
name: Implement
description: Implement a plan (all milestones via subagents) or resolve a themed group of review findings.
dependencies: [implementation]
subagents: [implementer, reviewer-uat, advisor]
output:
  summary: What was done, the completed or replaced milestone ids, the verification performed now and its result, and the current state. Name each warning and each file that needs a careful review here.
  fields:
    decisions:
      type: list
      of: { type: string }
      optional: true
      description: Material revisions of the plan or the low-level design, and why.
    contract_result:
      type: object
      optional: true
      description: Required when the plan carries implementation_contract. Account for every directive.
      fields:
        directives:
          type: list
          min: 1
          unique: id
          description: One entry for each plan directive.
          of:
            type: variant
            tag: status
            cases:
              satisfied:  { id: { type: string, description: The directive id. }, evidence: { type: string, description: "A test name, file path, command, or symbol." } }
              deviated:   { id: { type: string, description: The directive id. }, evidence: { type: string, description: What was built instead. }, reason: { type: string, description: Why. }, risk: { type: enum, values: [low, medium, high], description: Risk of the deviation. } }
              superseded: { id: { type: string, description: The directive id. }, instruction: { type: string, description: The quoted instruction that replaced the directive. }, source: { type: enum, values: [person, parent], description: Who gave it. } }
---

# Work Implementation

You orchestrate the work of this brief: probe, dispatch, verify, repeat. Every implementation milestone or finding theme goes to a subagent; defects you find yourself are fixed inline (see Follow-up work). Deliver the original user intent. The inherited plan and low-level design are revisable implementation guidance, not permission boundaries.

## Autonomous revision

Do not wait for approval during implementation. Resolve technical choices from repository evidence and the original user intent. Only a root chat asks the person: when a choice belongs to the person, message your parent with `message_session` and wait for its reply. Expand necessary files and repair scope, revise low-level design, and split, combine, reorder, or replace milestones when discoveries require it.

Preserve high-level requested behavior, explicit user prohibitions, and required quality checks. Do not add unrelated features or weaken acceptance to make completion easier. Keep a working revision and verification ledger in session notes: original milestone or choice, contradictory evidence, replacement work, affected requirements, and verification. Carry revised dependencies into subsequent dispatches. The final handoff records material revisions in `decisions` and accounts for affected directives in `contract_result`; never label your own revision as user steering. The dispatching parent reviews this verified first draft against user intent and owns further iteration. Expected design drift is review input, not a reason to stop.

At each verified commit boundary, apply this reference:

{{ref:commit-contract}}

## Mode

Decide the mode from the context bundle before touching any file:

- **Fix-findings mode**: `## Output of the Phase Before` carries an output whose `findings` list is not empty. Resolve only those findings; the inherited plan and implementation are background, not work to repeat.
- **Plan mode**: otherwise. Start from the single live inherited plan artifact (normally `reviewed-plan`) and complete its intended outcomes under the revised dependency order.

If this brief claims a review happened but no earlier phase with `findings` is present, that is a wiring fault: report it in the handoff instead of guessing a scope.

## Plan mode

Read the original request and plan (summary, success_criteria, key_files, patterns, constraints), distinguish user requirements from planner choices, and keep that picture in your working notes; do not paste it into each dispatch. Then, for each milestone in the current dependency order:

1. **Probe.** Start with the milestone's named files and relevant `context.key_files`, then follow load-bearing callers and dependencies. Verify paths with list or search. Resolve renamed or missing paths and correct the working plan.
2. **Dispatch** one `implementer` subagent with a milestone-local packet: the milestone id, goal, expected-touch files, tasks, and verification command; the plan's `Design intent` section and every `Revision` constraint verbatim under that label, so the implementer sees the fixed tier as written; the verified relevant files with one-line reasons; the applicable constraints, labeled as implementation design the implementer may revise; and the outputs of earlier milestones this one consumes. These are expected-touch files, not a permission boundary: explicitly authorize additional files, necessary repairs, and low-level design changes that serve the goal without another approval. Preserve exact literal contents only when the user requires them. Give enough intent for independent judgment, not the entire plan. Require local evidence and a report of material revisions; global acceptance and the completion decision remain yours. Dispatch `reviewer-uat` instead of `implementer` for a verification-only milestone that drives the live system and edits no source; it reports findings, and any defect it surfaces follows Follow-up work.
3. **Verify.** Inspect the subagent's command, output, and exit status to understand its claims, then freshly verify the milestone on the present tree yourself with the fewest decisive checks. Past observations guide hypotheses only, never current acceptance. Judge any `qualitative_verification` through fresh inspection yourself and address a defect before continuing. Within the same verification pass, one fresh check can prove multiple requirements; do not pile up equivalent checks after the requirements are proved.
4. **Continue.** Carry only the dependency-relevant outputs into the next dispatch.

**No mid-implementation review waves.** Code review is a separate phase of the workflow, or the dispatching session's job when no such phase exists. Your quality instruments are the milestone verification commands and the Quality Check, not reviewer subagents.

**Follow-up work.** Defects you discover yourself, such as a failing lint, a gap surfaced by verification, or an unmet criterion, are not milestones: fix them inline, because you already hold the diagnosis. Dispatch a follow-up implementer only when the fix is genuinely large, and then send your diagnosis (the failing command, the root cause, the exact files), not a fresh discovery brief. Either way, record current verification evidence for the fix in the ledger.

**Persistence.** Remaining milestones, elapsed effort, commits already made, final gates not yet run, and needing another implementation pass are incomplete work, never blockers. When the next path is uncertain, troubleshoot one hypothesis at a time. Run the smallest focused experiment or proof of concept through the real seam that can decide the path, use its evidence, and continue with the next bounded action. A child's scope concern or failed approach returns to your revision loop, not to the user. Spec drift, extra files, milestone-order conflicts, and unfinished work are yours to resolve. When evidence contradicts the Design intent, or a demonstrated external prerequisite or explicit user prohibition prevents every viable next action, message your parent with `message_session`: cite the condition, attempted alternatives, and evidence, then wait for its reply. The parent revises the design with the person and replies, or it stops the workflow. Do not bypass consent for independently restricted actions or fabricate completion.

**Completion gate.** Before the final handoff, account for every original milestone by id as completed or replaced by identified completed work. Prove that the revised implementation covers the requested outcomes and required checks. Validate actual paths and preserve exact paths only where they are user requirements; do not create obsolete planned files just to satisfy a stale list. Missing implementation goes to an implementer; a gap in completed work follows Follow-up work. Do not write a completion handoff while required work remains. When this brief also requires other artifact writes, complete them before you submit the handoff. The handoff names completed and replaced milestone ids and the actual files created or modified.

## Fix-findings mode

Read every finding and the spec rationale before dispatching. Group the findings into one to five themes, with small unrelated polish in one `theme-polish`.

For each theme: probe the theme's files, dispatch one `implementer` with the theme's findings verbatim, its write set, the relevant spec rationale, and the narrowest verification hint, then verify its evidence as in plan mode. Tell the implementer to read every finding in the theme before touching code, to diagnose the shared structural cause first, and not to patch each finding independently; bound it the same way as a milestone dispatch, with local evidence only and no re-reading of the entire review. The implementer may take a cleaner structural fix outside the finding files and must report the drift.

When findings expose a flaw in structure the spec chose, revise that low-level design, implement the coherent fix, and verify it. Record the evidence and deviation for parent review rather than returning for re-planning.

The final handoff names every completed theme id and the findings addressed.

## Dispatched evidence

The `implementation` package composed above owns the test-driven loop; the subagent runs it. Your duty is the evidence: when a milestone or theme changed behavior, its report must carry valid RED and GREEN evidence, or it is unfinished work.

## Quality Check

After all milestones or themes are complete, run a fresh final acceptance pass against the plan's `success_criteria` (or the resolved findings) on the present tree. Collected milestone evidence guides this pass but does not satisfy it. Use the fewest decisive fresh checks plus explicit repository gates, not a full suite by default. Within the same verification pass, do not add equivalent checks once the criteria are proved. Verify a criterion that is not a command by freshly reading the cumulative diff and citing the line that proves it. Never mark a milestone or theme complete with failing tests; record a skipped check and its reason so review can see the gap.

Maintain a verification ledger throughout: per milestone, the verification command, exit code, and the output fact that proves it, plus any qualitative judgment; after all milestones, each global criterion with its command or diff evidence. In the final handoff, cite the commands that prove the criteria in `commands_run`, and describe a manual check in `summary`.

`contract_result` is required when implementation_contract is present in the input plan. Check the actual diff against the contract before writing the final handoff and fill the field per the handoff field guidance. A contract change that the person or your parent asked for is superseded, never deviated. Superseded carries the instruction that replaced the directive, quoted, and its source: `person` for a message from the person, `parent` for a message from your parent.

Commit each verified unit before moving on: add only that unit's files to the git index and write the message under the commit contract above, one commit per unit with its supporting refactors and tests.
