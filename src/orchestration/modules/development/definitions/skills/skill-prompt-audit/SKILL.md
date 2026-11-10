---
description: Use when auditing a bundled skill package or workflow brief as the prompt an agent reads.
related: workflow-authoring
---

# Skill Prompt Audit

{{if:workflow}}
Input: the skill packages to audit, from `src/agent-skills/` and the development bundle under `src/orchestration/modules/development/definitions/skills/`, with their shared and package references, or the inline briefs of a workflow file. The deliverable is a directed, focused prompt: every rule stated once, in execution order, with mandatory constraints first.
{{else}}
Input: the skill packages to audit, from `src/agent-skills/` and the development bundle under `src/orchestration/modules/development/definitions/skills/`, with their shared and package references. The deliverable is a directed, focused prompt: every rule stated once, in execution order, with mandatory constraints first.
{{end}}

Run the audit when a prompt has grown through iteration, after merging packages or extracting references, or on a schedule.

## Procedure

1. **Audit the rendered prompt, not the source files.** The model reads the assembled prompt: dependency closure, body, resolved `{{ref:...}}` includes, and host postamble. Render every host that applies:
   - Direct invocation: `assembleSkillInvocation` (`src/workflows/skill-invocation.ts`). The model `skill` tool's load action, and a built-in command that starts a skill's method, such as `/bug-report-triage`, return exactly this text in a source run.
   - Persona: `personaInstructions` (`src/workflows/agents/persona-instructions.ts`), the dependency-first `renderSkillClosure` (`src/workflows/skill-render.ts`) followed by the persona instructions. `bun run scripts/dump-prompt.ts subagent <persona>` prints it.
{{if:workflow}}
   - Agent of a workflow: `assembleAgentPrompt` (`src/workflows/context-bundle/prompt-assembly.ts`). `bun run scripts/dump-prompt.ts worker <workflow-file> <agent>` prints it; add `--sizes` for a per-layer size table.
{{end}}
2. **Build a restatement inventory.** For each rule, list every place it appears (dependency, body, reference, persona, template, postamble) with line numbers. A rule stated more than once for one audience is a finding.
3. **Check the outline** (the headings in order) against the execution order of the work.
4. Apply the rules below, then verify.

## Rules

### R1. One home per rule

Every instruction has exactly one canonical location. When a rule appears twice, pick the home by where the rule is used (for example, evidence standards live where findings are judged, not where the target is determined), and delete the other occurrence or reduce it to a one-line reference.

### R2. Position carries emphasis, not repetition

Agents weight earlier content. The mandatory guards (role boundary, mandatory actions, output format) go in the first screen of the prompt. Never restate a rule to emphasize it; move it up instead.

### R3. Body in execution order

Sections appear in the order the agent does the work: inputs, selection, procedure, integration, output. A `{{ref:...}}` include can go anywhere in the body; a shared procedure belongs at its chronological position, not appended at the end.

### R4. Anti-pattern lists must add information

An anti-pattern bullet earns its place only when it describes a failure mode that negating an earlier rule does not give. Delete a list whose every bullet restates a rule already given.

### R5. No rationale or changelog prose

Sentences that explain why the skill exists, what procedures it merged, or how the surrounding architecture works are maintainer documentation, not agent instruction. Move them to `docs/architecture-intent/` or delete them.

### R6. Do not narrate the plumbing

State what the input is ("The draft plan is your input"), not how it traveled ("it arrives in the context bundle"). When the content is visibly present in the assembled prompt, the agent does not need directions to it.

### R7. Separate audiences before deduplicating

Content pasted into subagent prompts (templates, paste blocks) and instructions to the orchestrating agent have different readers; the same sentence in both is principled, not duplication. Within one audience, deduplicate. Corollary: a rule for the subagent belongs inside the paste block, not loose in the orchestrator's instructions.

### R8. Templates are canonical for composed prompts

When a dispatch template shows the required elements concretely, do not also list them abstractly ("each prompt MUST include..."). The template is the single statement.

### R9. Bodies are host-neutral; hosts own delivery

This is the most consequential rule, because the hosts differ in kind, not only in strictness: an agent of a workflow receives typed outputs of earlier agents and writes its own output through the handoff tool; a directly invoked skill receives whatever the conversation supplies and never calls the handoff tool.

Input side: a body names inputs as concepts ("the input plan", "the findings"), never as transport ("the prior handoff file", "the context bundle"). Canonical field names (`success_criteria`, `context.constraints`) are acceptable because they name concepts. Container-shape suffixes are not ("the `phases[]` array"): they assert a serialization the input may not have, and a Markdown plan has phases, not an array. Workflow strictness comes from the agent's prompt assembly (typed context bundle and handoff postamble).

Output side: a body describes the deliverable (a refined specification, a prioritized findings list, a research document), not the delivery channel. The host decides the channel: for an agent of a workflow the deliverable becomes the handoff payload; under direct invocation the agent writes it to a project file the user asked for or returns it in chat for its next actions. A package that needs a direct-invocation result shape declares it in its `direct-output` frontmatter, which direct invocation alone renders as a `## Direct Result` section. Nothing on the direct host supersedes body text, so a body that binds its deliverable to the handoff tool or to a workflow artifact path is a finding. State the deliverable and its required structure (fields, severity levels, evidence) and leave delivery to the host.

A body that works on only one host, on either side, is a finding. Fix the phrasing before you add a `direct-output` contract or a host-specific reference.

### R10. Vocabulary coherence

Define or map every term that the prompt demands at output time where it demands it (for example, severity "critical" = P1). A test must anchor each schema field name that prompt text cites to its owning schema.

### R11. Shared text lives in references

Extract a passage that two skill bodies share to `src/agent-skills/references/` and include it with `{{ref:<name>}}`. Text with one consumer stays inline in its body; add no speculative references. A package's own `references/` files hold detail that one body would otherwise bury, and the body names each one at the step that needs it.

## Verification

- Run `bun run test` and `bun run lint` after every edit. Tests pin only load-bearing strings, never prose that this audit may rewrite.
- Render the direct, a representative persona, and the workflow compositions again. Check dependency order, package-id deduplication, outline order, and the first screen.
- Confirm that a `## Direct Result` section appears only under direct invocation and the handoff postamble only for an agent of a workflow.
- When a change affects bundled roots, references, package identity, development filtering, or composition, run `bun run scripts/verify-production-composition.ts`. It builds one production executable, asserts filesystem provenance for the source run and manifest provenance for the executable, and compares the normalized compositions.
