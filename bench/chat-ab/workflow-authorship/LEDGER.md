# Frozen workflow replacement ledger

The machine-readable ledger.json owns these replacements. The fixture drift test checks this rendering and every inline brief.

## 1

Original: implement.yaml: use_when: "Use when the design is already settled in chat and the work is substantial: multiple dependent phases or architectural decisions whose mistakes would invalidate later phases. Launch only when no user choice or technical uncertainty remains and no phase needs discovery, experiments, or proof-of-concept work; the workflow inspects the repository only to ground the settled design in exact files, callers, and tests. Do not use it to start designing, for a bounded change, for routine ticket-sized work, or for bulk homogeneous work such as mass lint fixes, codemods, or renames. When you can launch a workflow file, run bulk work as one that fans out over the sites and verifies each one; otherwise drive it from chat as waves of implementer subagents with per-batch verification. Once the workflow is running, newly exposed implementation uncertainty belongs to the active step: troubleshoot it, run a focused experiment or proof of concept, and continue. The fact that work remains is not a blocker.\n"

Replacement: Keep the exact folded value as YAML comments above the definition and in both handcrafted patch catalogs.

Reason: use_when is a retired runtime key. Comments retain selection metadata without invoking compatibility conversion or a warning.

## 2

Original: implement.yaml: confirmation_template: spec-and-implement

Replacement: Omit the retired key.

Reason: Current path launches have no confirmation-template or description requirement key. The campaign supplies the same task description to each arm.

## 3

Original: implement.spec-create: dependencies include fly.implementation-spec.

Replacement: Inline the retained skills/fly.implementation-spec/SKILL.md body after the brief; declare dependencies [research, implementation-planning].

Reason: The retired skill is not installed. Its body and live reusable dependencies retain the composed method without restoring a product skill.

## 4

Original: implement.spec-create: "The method is the `fly.implementation-spec` package composed above;"

Replacement: "The method is the retained Implementation Specification section below;"

Reason: The retired method is now inline, not an installed package.

## 5

Original: implement.spec-create: file or external brief reference workflows/steps/fly.spec-create.md, including its YAML frontmatter.

Replacement: Inline the exact body as brief, with its name, dependencies, subagents, and output beside it. Keep writes unchanged.

Reason: Current workflows hold inline briefs. The step frontmatter description has no agent-record equivalent; the procedure and output contract are unchanged.

## 6

Original: implement.spec-create: output: bundled:contracts/implementation-plan.json

Replacement: Inline the full implementation-plan.json contract.

Reason: The workflow must be self-contained; the retained contract remains under src/workflows/workflows/contracts/implementation-plan.json.

## 7

Original: implement.spec-review: dependencies include fly.implementation-spec.

Replacement: Inline the retained skills/fly.implementation-spec/SKILL.md body after the brief; declare dependencies [research, implementation-planning, code-review].

Reason: The retired skill is not installed. Its body and live reusable dependencies retain the composed method without restoring a product skill.

## 8

Original: implement.spec-review: file or external brief reference workflows/steps/fly.spec-review.md, including its YAML frontmatter.

Replacement: Inline the exact body as brief, with its name, dependencies, subagents, and output beside it. Keep writes unchanged.

Reason: Current workflows hold inline briefs. The step frontmatter description has no agent-record equivalent; the procedure and output contract are unchanged.

## 9

Original: implement.spec-review: output: bundled:contracts/implementation-plan.json

Replacement: Inline the full implementation-plan.json contract.

Reason: The workflow must be self-contained; the retained contract remains under src/workflows/workflows/contracts/implementation-plan.json.

## 10

Original: implement.implement: file or external brief reference workflows/steps/fly.implement.md, including its YAML frontmatter.

Replacement: Inline the exact body as brief, with its name, dependencies, subagents, and output beside it. Keep writes unchanged.

Reason: Current workflows hold inline briefs. The step frontmatter description has no agent-record equivalent; the procedure and output contract are unchanged.

## 11

Original: implement.yaml: steps declarations plus flow [spec-create, spec-review, implement].

Replacement: phases [spec-create, spec-review, implement], in the same order.

Reason: The current grammar uses phases. Durable writes and supersession remain unchanged.

## 12

Original: qa.yaml: use_when: "The user wants an exhaustive QA pass on the current project: \"QA the app\", \"do a full quality pass\", \"test every surface\". Every follow-up pass also exercises the complete surface from scratch. Produces a timestamped run directory under docs/qa/runs/ with a changelog and unclear-findings document, and applies fixes in the same pass.\n"

Replacement: Keep the exact folded value as YAML comments above the definition and in both handcrafted patch catalogs.

Reason: use_when is a retired runtime key. Comments retain selection metadata without invoking compatibility conversion or a warning.

## 13

Original: qa.yaml: confirmation_template: qa

Replacement: Omit the retired key.

Reason: Current path launches have no confirmation-template or description requirement key. The campaign supplies the same task description to each arm.

## 14

Original: qa.yaml: requires_description: false

Replacement: Omit the retired key.

Reason: Current path launches have no confirmation-template or description requirement key. The campaign supplies the same task description to each arm.

## 15

Original: qa.surface-map: file or external brief reference workflows/steps/qa.surface-map.md, including its YAML frontmatter.

Replacement: Inline the exact body as brief, with its name, dependencies, subagents, and output beside it. Keep writes unchanged.

Reason: Current workflows hold inline briefs. The step frontmatter description has no agent-record equivalent; the procedure and output contract are unchanged.

## 16

Original: qa.test-fix-surface: file or external brief reference workflows/steps/qa.test-fix-surface.md, including its YAML frontmatter.

Replacement: Inline the exact body as brief, with its name, dependencies, subagents, and output beside it. Keep writes unchanged.

Reason: Current workflows hold inline briefs. The step frontmatter description has no agent-record equivalent; the procedure and output contract are unchanged.

## 17

Original: qa.review-fixes: file or external brief reference workflows/steps/qa.review-fixes.md, including its YAML frontmatter.

Replacement: Inline the exact body as brief, with its name, dependencies, subagents, and output beside it. Keep writes unchanged.

Reason: Current workflows hold inline briefs. The step frontmatter description has no agent-record equivalent; the procedure and output contract are unchanged.

## 18

Original: qa.yaml: flow surface-map, test-fix-surface, while review-fixes.findings do review-fixes then test-fix-surface, maxIterations: 5, detectStuck: true.

Replacement: phases surface-map, test-fix-surface, repeat { while: review-fixes.findings, max: 5, stuck: true } with phases review-fixes and retest (runs: test-fix-surface).

Reason: The current repeat spelling keeps the same review-first loop, bounds, and stuck detection. A phase id is unique, so repeated test-fix-surface is retest. The retained findings output remains the loop condition.

## 19

Original: debug.yaml: use_when: "Use for a small investigation and fix when the user reports a specific bug and the root cause is not known. The workflow separates root-cause analysis, the fix, and verification. Keep obvious fixes and clear local changes in-process.\n"

Replacement: Keep the exact folded value as YAML comments above the definition and in both handcrafted patch catalogs.

Reason: use_when is a retired runtime key. Comments retain selection metadata without invoking compatibility conversion or a warning.

## 20

Original: debug.yaml: confirmation_template: debug

Replacement: Omit the retired key.

Reason: Current path launches have no confirmation-template or description requirement key. The campaign supplies the same task description to each arm.

## 21

Original: debug.investigate: file or external brief reference workflows/briefs/debug.investigate.md, including its YAML frontmatter.

Replacement: Inline the exact body as brief, with its name, dependencies, subagents, and output beside it. Keep writes unchanged.

Reason: Current workflows hold inline briefs. The step frontmatter description has no agent-record equivalent; the procedure and output contract are unchanged.

## 22

Original: debug.fix: file or external brief reference workflows/briefs/debug.fix.md, including its YAML frontmatter.

Replacement: Inline the exact body as brief, with its name, dependencies, subagents, and output beside it. Keep writes unchanged.

Reason: Current workflows hold inline briefs. The step frontmatter description has no agent-record equivalent; the procedure and output contract are unchanged.

## 23

Original: debug.verify: file or external brief reference workflows/briefs/debug.verify.md, including its YAML frontmatter.

Replacement: Inline the exact body as brief, with its name, dependencies, subagents, and output beside it. Keep writes unchanged.

Reason: Current workflows hold inline briefs. The step frontmatter description has no agent-record equivalent; the procedure and output contract are unchanged.

## 24

Original: debug.yaml: implicit brief names investigate, fix, and verify, and runs: fix on refix.

Replacement: Declare their retained briefs and output contracts inline; keep if: investigate.hypothesis, repeat.while: verify.defects, max: 3, refix runs: fix, and all writes unchanged.

Reason: The current file must own its briefs. The nullable hypothesis and defects list keep the original condition semantics. No stuck detection existed in debug, so none is added.

## 25

Original: ORCHESTRATION_SECTION: Write a workflow file for the task and launch it by content or path with the workflow tool.

Replacement: Choose the predefined workflow whose purpose fits the task and launch it by path with the workflow tool; do not write workflow files. Add the frozen name, description, use_when, and runtime absolute path catalog. Replace only FILE_DESCRIPTION's authoring sentences with predefined selection instructions. Keep ORCHESTRATION_REMINDER, ON_GUIDANCE, and ASK_GUIDANCE unchanged.

Reason: Arm A changes only authoring guidance and adds the required catalog. createWorkflowTool exposes FILE_DESCRIPTION to the model. Neither reminders nor mode guidance instruct the model to write workflow files. Every delegation-pressure sentence and the tool's launch mechanics remain identical. node:path resolve and import.meta.dir find files in the treatment checkout.

## 26

Original: Arm A discretionary guidance.

Replacement: Append "You must launch a workflow for the task, even when the task looks small; this requirement comes before every sizing rule in this section." to the section's selection bullet, and insert "You must launch a workflow for the task, even when the task looks small." into ORCHESTRATION_REMINDER.on before "Refer to the Orchestrating with workflows section."

Reason: A-forced requires a predefined launch without imposing a launch count. Both forced arms use the same statements at the same two locations. The pilot smoke showed the section clause alone did not make the authored arm launch on a small task, because the sizing rules let it work alone. All other guidance equals discretionary A.

## 27

Original: Arm B unpatched guidance.

Replacement: Append "You must launch a workflow for the task, even when the task looks small; this requirement comes before every sizing rule in this section." to the section's authoring bullet, and insert "You must launch a workflow for the task, even when the task looks small." into ORCHESTRATION_REMINDER.on before "Refer to the Orchestrating with workflows section."

Reason: B-forced requires authoring and launch without imposing a launch count. Both forced arms use the same statements at the same two locations. The pilot smoke showed the section clause alone did not make the authored arm launch on a small task, because the sizing rules let it work alone. All other guidance equals unpatched B.

## 28

Original: Both forced arms expose the ordinary root chat tool surface.

Replacement: Apply root-workflow-only.patch to both forced arms. At the tool exposure planner's final surface boundary, keep only workflow, skill, read, list, search, and process for interactive-chat. Remove every other eligible and provider-visible tool, including Code Mode and MCP tools. Leave workflow-agent and subagent purposes unchanged.

Reason: Smoke runs showed that wording alone did not force the authored arm to launch on small or medium tasks. The shared allowlist removes inline execution and non-workflow delegation without changing workflow agents. Process lets the root wait on its workflow. This benchmark-owned source patch adds no product configuration and its hash enters treatment identity.

## 29

Original: Every arm runs Flywheel's background learning reviews at the account's review intervals.

Replacement: Apply no-learning-review.patch to every arm. learningReviewPolicy returns memory and skill review intervals of 0, which turns off both reviews for chat and workflow sessions.

Reason: The pilots ran 40 background skill reviews on gpt-6.1-sol inside the cells. Their cost entered the cell totals unevenly across arms ($0.59 authored and $0.18 handcrafted in the forced pilot), outside the work under test. The earlier workflow audit comparison excluded learning for the same reason. The patch changes no account setting, and its hash enters treatment identity.
