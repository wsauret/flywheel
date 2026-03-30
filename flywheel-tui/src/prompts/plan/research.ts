import type { WorkflowStepContext } from "../index.js";
import {
  DOCUMENTARIAN_MODE,
  LOCATOR_ANALYZER_PATTERN,
  TOKEN_LIMITS,
  READ_FULLY_RULE,
  FILE_LINE_DISCIPLINE,
  buildProjectContextSection,
} from "../conventions.js";
import { renderHandoffInstruction, PLAN_RESEARCH_FIELDS } from "../../handoff/field-specs.js";

export const planResearchEvaluationCriteria =
  "Produces a .context.md file with file references and patterns";

/**
 * Builds a prompt for the plan research step (locator → analyzer dispatch).
 *
 * Mirrors the plan-review dispatch pattern: explicit fly/* agent names,
 * Task(subagent_type=...) syntax, parallel dispatch in a single message.
 */
export function buildPlanResearchPrompt(ctx: WorkflowStepContext): string {
  const files =
    ctx.fileReferences.length > 0
      ? ctx.fileReferences.map((f) => `- \`${f}\``).join("\n")
      : "_No initial file references._";

  const projectContext = buildProjectContextSection(ctx.extra);

  return `# Plan Research

## Research Objective

${ctx.planContent}

## Known File References

${files}

${ctx.projectCwd ? `## Working Directory\n\n\`${ctx.projectCwd}\`` : ""}

${projectContext}

---

${LOCATOR_ANALYZER_PATTERN}

${DOCUMENTARIAN_MODE}

${READ_FULLY_RULE}

${FILE_LINE_DISCIPLINE}

${TOKEN_LIMITS}

## BLOCKING Rule

Do NOT use Read/Grep/Glob for target codebase research directly. Dispatch locator Tasks first to find relevant files, then dispatch analyzer Tasks to understand them.

**Exception:** Files listed in the Project Context section above (conventions, standards) MUST be read directly before dispatching locators.

## Phase 1: Locator Dispatch

Dispatch ALL 3 locator agents **in parallel** using the Task tool. Launch ALL of them in a SINGLE message with multiple Task calls. Each locator returns paths and references only — no file contents. Max 500 tokens output each.

### Locator Agents (installed as \`fly/*\` agents)

These agents are pre-installed and available via the Task tool. Use \`subagent_type\` to reference each one:

1. **fly/locator-codebase** — Find WHERE files and components live. Returns file paths only. Focus on entry points, directory structure, module boundaries, configuration files.
2. **fly/locator-patterns** — Find WHERE specific patterns exist. Returns file:line references only. Focus on API usage, import/dependency chains, naming conventions, existing patterns to follow.
3. **fly/locator-docs** — Find WHERE documentation lives. Returns file paths only. Focus on README, AGENTS.md, CONTRIBUTING guides, inline docs, config schemas.

### How to Dispatch

For each locator, use the Task tool like this:

\`\`\`
Task(subagent_type="fly/locator-codebase", prompt="Find WHERE files and components live related to: [research objective]. Return file paths only, categorized by: implementation, tests, config, types, docs. Max 30 paths.")
Task(subagent_type="fly/locator-patterns", prompt="Find WHERE specific patterns exist related to: [research objective]. Return file:line references only, grouped by pattern type. Max 30 locations.")
Task(subagent_type="fly/locator-docs", prompt="Find WHERE documentation lives related to: [research objective]. Search README, AGENTS.md, docs/, inline comments. Return paths only. Max 20 paths.")
\`\`\`

Launch ALL 3 Task calls in a SINGLE response message so they run in parallel.

## Phase 1b: Rank Locator Results

After all locators complete, deduplicate and rank results before dispatching analyzers:
1. **Direct relevance** — files directly implementing the researched concept
2. **Modification targets** — files that would need changes if extending the concept
3. **Pattern exemplars** — files that establish patterns related to the concept
4. **Constraint docs** — files documenting constraints, conventions, or boundaries

Select top findings for analyzers:
- **Max 15 file paths** for fly/analyzer-codebase
- **Max 10 pattern locations** for fly/analyzer-patterns

If total findings < 10, send all findings directly without filtering.

## Phase 2: Analyzer Dispatch

Dispatch analyzer agents on TOP FINDINGS ONLY using the Task tool. Each analyzer reads actual files and extracts structured findings in documentarian mode. Max 750 tokens output each.

### Analyzer Agents (installed as \`fly/*\` agents)

These agents are pre-installed and available via the Task tool. Use \`subagent_type\` to reference each one:

1. **fly/analyzer-codebase** — Understand HOW code works. Reads files, documents function signatures, data flow, error handling, side effects, dependencies. File:line references required.
2. **fly/analyzer-patterns** — Extract code examples with context. For each pattern: exact code reference, caller usage, constraints, variations. File:line references required.

### How to Dispatch

\`\`\`
Task(subagent_type="fly/analyzer-codebase", prompt="Analyze these implementation files related to [research objective]:\\n[list of top file paths from locator output]\\nDocument: function signatures, data flow, error handling, side effects, dependencies. File:line references required. Documentarian mode only — do NOT suggest improvements.")
Task(subagent_type="fly/analyzer-patterns", prompt="Analyze these pattern locations related to [research objective]:\\n[list of top file:line refs from locator output]\\nFor each: exact code reference, caller usage, constraints, variations. File:line references required. Documentarian mode only — do NOT suggest alternatives.")
\`\`\`

Launch both Task calls in a SINGLE response message so they run in parallel.

## Persistence

Write the research output to a \`.context.md\` file on disk. Name it \`<description-slug>.context.md\` in the working directory (e.g., \`user-authentication.context.md\`). The slug should be a kebab-case version of the research objective. This file will be consumed by the next planning step.

## Code Block Rule

Keep ALL code blocks under 15 lines. If a listing (directory tree, code excerpt, etc.) would exceed 15 lines, split it into multiple smaller blocks or use inline \`file:line\` references instead. Directory trees should be flattened or split by module.

## Research Document Output Format

\`\`\`yaml
---
type: research
feature: <feature name>
date: <ISO date>
status: complete
---
\`\`\`

### Sections

1. **Codebase Map** — Directory structure and key file roles (use multiple small code blocks if needed, max 15 lines each)
2. **Relevant Code** — file:line references with brief descriptions
3. **Patterns to Follow** — Existing conventions the implementation should match
4. **Constraints** — Hard limits, dependencies, compatibility requirements
5. **Open Questions** — Anything unclear that needs user input before planning
${ctx.extra?.handoffPath ? `\n${renderHandoffInstruction(PLAN_RESEARCH_FIELDS, ctx.extra.handoffPath as string)}` : ""}
`;
}
