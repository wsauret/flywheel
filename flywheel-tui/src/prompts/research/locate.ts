import type { WorkflowStepContext } from "../index.js";
import {
  DOCUMENTARIAN_MODE,
  LOCATOR_ANALYZER_PATTERN,
  FILE_LINE_DISCIPLINE,
  READ_FULLY_RULE,
  buildProjectContextSection,
} from "../conventions.js";

export const researchLocateEvaluationCriteria =
  "Relevant sources identified and ranked by relevance to the research objective";

// ---------------------------------------------------------------------------
// Reusable prompt constants
// ---------------------------------------------------------------------------

/** Locator agent dispatch instructions for research. */
export const LOCATOR_DISPATCH_INSTRUCTIONS = `## Locator Dispatch

Dispatch ALL 4 locator agents **in parallel** using the Task tool (single message, multiple Task calls). Each locator returns paths and references only — no file contents. Max 500 tokens output each.

### Locator Agents (installed as \`fly/*\` agents)

These agents are pre-installed and available via the Task tool. Use \`subagent_type\` to reference each one:

1. **fly/locator-codebase** — Find WHERE files and components live. Returns file paths only. Categorized by: implementation, tests, config, types, docs.
2. **fly/locator-patterns** — Find WHERE specific patterns exist. Returns file:line references only, grouped by pattern type.
3. **fly/locator-docs** — Find WHERE documentation lives. Searches README, AGENTS.md, docs/, inline comments. Returns paths only.
4. **fly/locator-web** — Find relevant external URLs and documentation. Returns URLs with descriptions only — does not fetch content.

### How to Dispatch

\`\`\`
Task(subagent_type="fly/locator-codebase", prompt="Find WHERE files and components live related to: [research topic]. Return file paths only, categorized by: implementation, tests, config, types, docs. Max 30 paths.")
Task(subagent_type="fly/locator-patterns", prompt="Find WHERE specific patterns exist related to: [research topic]. Return file:line references only, grouped by pattern type. Max 30 locations.")
Task(subagent_type="fly/locator-docs", prompt="Find WHERE documentation lives related to: [research topic]. Search README, AGENTS.md, docs/, inline comments. Return paths only. Max 20 paths.")
Task(subagent_type="fly/locator-web", prompt="Find documentation and articles about: [research topic]. Return URLs with descriptions only — do not fetch. Categorize: official docs, tutorials, community. Max 15 URLs per category.")
\`\`\`

Launch ALL 4 in a SINGLE response message so they run in parallel.`;

// ---------------------------------------------------------------------------
// Main prompt builder
// ---------------------------------------------------------------------------

/**
 * Builds a prompt for the research locate step (step 0 of standalone /research).
 * Dispatches parallel locator sub-agents to find files, patterns, and docs.
 */
export function buildResearchLocatePrompt(ctx: WorkflowStepContext): string {
  const files =
    ctx.fileReferences.length > 0
      ? ctx.fileReferences.map((f) => `- \`${f}\``).join("\n")
      : "_No initial file references._";

  const projectContext = buildProjectContextSection(ctx.extra);

  return `# Research: Locate Sources

## Research Topic

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

## BLOCKING Rule

Do NOT use Read/Grep/Glob for target codebase research directly. Dispatch locator Tasks first to find relevant files, then return the consolidated results.

**Exception:** Files listed in the Project Context section above (conventions, standards) MUST be read directly before dispatching locators.

${LOCATOR_DISPATCH_INSTRUCTIONS}

## Ranking Locator Results

After all locators complete, rank and deduplicate results. Prioritize:
1. **Direct relevance** — files directly implementing the researched concept
2. **Modification targets** — files that would need changes if extending the concept
3. **Pattern exemplars** — files that establish patterns related to the concept
4. **Constraint docs** — files documenting constraints, conventions, or boundaries

## Output

Return the consolidated, ranked locator results. Do not analyze file contents — that happens in the next step.
`;
}
