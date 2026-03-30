import type { WorkflowStepContext } from "../index.js";
import {
  DOCUMENTARIAN_MODE,
  LOCATOR_ANALYZER_PATTERN,
  FILE_LINE_DISCIPLINE,
  READ_FULLY_RULE,
  buildProjectContextSection,
} from "../conventions.js";

export const researchAnalyzeEvaluationCriteria =
  "Findings extracted from sources with supporting references relevant to the research topic";

// ---------------------------------------------------------------------------
// Reusable prompt constants
// ---------------------------------------------------------------------------

/** Analyzer dispatch instructions for research. */
export const ANALYZER_DISPATCH_INSTRUCTIONS = `## Analyzer Dispatch

Dispatch analyzer agents on TOP FINDINGS ONLY using the Task tool. Each analyzer reads actual files and extracts structured findings in documentarian mode. Max 750 tokens output each.

### Analyzer Agents (installed as \`fly/*\` agents)

These agents are pre-installed and available via the Task tool. Use \`subagent_type\` to reference each one:

1. **fly/analyzer-codebase** — Understand HOW code works. Reads files, documents function signatures, data flow, error handling, side effects, dependencies.
2. **fly/analyzer-patterns** — Extract code examples with context. For each pattern: exact code reference, caller usage, constraints, variations.
3. **fly/analyzer-docs** — Extract insights from documentation. Reads docs, synthesizes decisions, constraints, setup instructions, warnings.
4. **fly/analyzer-web** — Fetch and analyze web content deeply. Retrieves URLs, extracts code examples, configuration, version constraints.

### How to Dispatch

\`\`\`
Task(subagent_type="fly/analyzer-codebase", prompt="Analyze these implementation files related to [research topic]:\\n[list of file paths from locator output]\\nDocument: function signatures, data flow, error handling, side effects, dependencies. File:line references required. Documentarian mode only — do NOT suggest improvements.")
Task(subagent_type="fly/analyzer-patterns", prompt="Analyze these pattern locations related to [research topic]:\\n[list of file:line refs from locator output]\\nFor each: exact code reference, caller usage, constraints, variations. File:line references required. Documentarian mode only — do NOT suggest alternatives.")
Task(subagent_type="fly/analyzer-docs", prompt="Analyze this documentation related to [research topic]:\\n[list of doc paths from locator output]\\nExtract: decisions, constraints, setup instructions, warnings. Filter aggressively — skip tangential mentions. Documentarian mode only.")
Task(subagent_type="fly/analyzer-web", prompt="Fetch and analyze these URLs related to [research topic]:\\n[list of URLs from locator-web output]\\nExtract: code examples, configuration, version constraints, warnings. Documentarian mode only.")
\`\`\`

Launch ALL applicable analyzer Task calls in a SINGLE response message so they run in parallel. Skip fly/analyzer-web if no URLs were found by locator-web. Skip fly/analyzer-docs if no documentation paths were found.`;

// ---------------------------------------------------------------------------
// Main prompt builder
// ---------------------------------------------------------------------------

/**
 * Builds a prompt for the research analyze step (step 1 of standalone /research).
 * Dispatches analyzer sub-agents on top findings from the locate step.
 */
export function buildResearchAnalyzePrompt(ctx: WorkflowStepContext): string {
  const previousResult = ctx.previousResult ?? "_No locator output available._";
  const projectContext = buildProjectContextSection(ctx.extra);

  return `# Research: Analyze Sources

## Research Topic

${ctx.planContent}

${ctx.projectCwd ? `## Working Directory\n\n\`${ctx.projectCwd}\`` : ""}

${projectContext}

## Locator Output (from previous step)

${previousResult}

---

${LOCATOR_ANALYZER_PATTERN}

${DOCUMENTARIAN_MODE}

${READ_FULLY_RULE}

${FILE_LINE_DISCIPLINE}

## Filtering Instructions

Before dispatching analyzers, select the top findings from the locator output:
- **Max 15 file paths** for fly/analyzer-codebase (most relevant implementation files)
- **Max 10 pattern locations** for fly/analyzer-patterns (most relevant file:line refs)
- **Max 5 documentation paths** for fly/analyzer-docs (most relevant docs)
- **Max 10 URLs** for fly/analyzer-web (most relevant external resources)

If total findings are fewer than 10, you may skip the filtering step and send all findings directly.

${ANALYZER_DISPATCH_INSTRUCTIONS}

## Output

Return the consolidated analysis results. Synthesize findings from all analyzers into a coherent understanding of the researched topic. Use file:line references throughout.
`;
}
