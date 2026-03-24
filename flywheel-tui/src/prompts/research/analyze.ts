import type { WorkflowStepContext } from "../index.js";
import {
  DOCUMENTARIAN_MODE,
  LOCATOR_ANALYZER_PATTERN,
  FILE_LINE_DISCIPLINE,
  READ_FULLY_RULE,
} from "../conventions.js";

/**
 * Builds a prompt for the research analyze step (step 1 of standalone /research).
 * Dispatches analyzer sub-agents on top findings from the locate step.
 */
export function buildResearchAnalyzePrompt(ctx: WorkflowStepContext): string {
  const previousResult = ctx.previousResult ?? "_No locator output available._";

  return `# Research: Analyze Sources

## Research Topic

${ctx.planContent}

${ctx.projectCwd ? `## Working Directory\n\n\`${ctx.projectCwd}\`` : ""}

## Locator Output (from previous step)

${previousResult}

---

${LOCATOR_ANALYZER_PATTERN}

${DOCUMENTARIAN_MODE}

${READ_FULLY_RULE}

${FILE_LINE_DISCIPLINE}

## Filtering Instructions

Before dispatching analyzers, select the top findings from the locator output:
- **Max 15 file paths** for analyzer-codebase (most relevant implementation files)
- **Max 10 pattern locations** for analyzer-patterns (most relevant file:line refs)
- **Max 5 documentation paths** for analyzer-docs (most relevant docs)

If total findings are fewer than 10, you may skip the filtering step and send all findings directly.

## Analyzer Dispatch Templates

Dispatch analyzer agents on TOP FINDINGS ONLY. Each analyzer reads actual files and extracts structured findings in documentarian mode. Max 750 tokens output each.

### analyzer-codebase

Analyze the selected implementation files. Read each file and document:
- Function signatures and return types
- Data flow and state management
- Error handling patterns
- Side effects and I/O boundaries
- Component interactions and dependencies

Expected return format: per-file findings with file:line references. DO NOT suggest improvements — documentarian mode only.

### analyzer-patterns

Analyze the selected pattern locations. For each pattern found:
- The exact code reference (file:line)
- How the pattern is used by callers
- Constraints or invariants the pattern depends on
- Variations of the same pattern across the codebase

Expected return format: grouped findings by pattern with file:line references. DO NOT suggest alternative patterns — document what exists.

## Output

Return the consolidated analysis results. Synthesize findings from all analyzers into a coherent understanding of the researched topic. Use file:line references throughout.
`;
}
