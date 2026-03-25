import type { WorkflowStepContext } from "../index.js";
import {
  DOCUMENTARIAN_MODE,
  LOCATOR_ANALYZER_PATTERN,
  FILE_LINE_DISCIPLINE,
  READ_FULLY_RULE,
  buildProjectContextSection,
} from "../conventions.js";

export const researchLocateValidationCriteria =
  "Relevant sources identified and ranked by relevance to the research objective";

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

## Locator Dispatch Templates

Dispatch ALL 3 locator agents in parallel (single message, multiple Task calls). Each locator returns paths and references only — no file contents. Max 500 tokens output each.

### locator-codebase

Find WHERE files and components live related to the research topic. Return file paths and line numbers only. Focus on:
- Entry points and exports
- Directory structure and module boundaries
- Configuration files
- Type definitions and interfaces

Expected return format: categorized list of file paths (implementation, tests, config, types, docs). Max 30 paths.

### locator-patterns

Find WHERE specific patterns exist related to the research topic. Return file:line references only. Focus on:
- Usage of specific APIs, functions, or types
- Import/dependency chains
- Naming conventions and existing patterns
- Error handling patterns

Expected return format: grouped file:line references by pattern type. Max 30 locations.

### locator-docs

Find WHERE documentation lives related to the research topic. Return file paths only. Focus on:
- README files, AGENTS.md, CONTRIBUTING guides
- Inline documentation and JSDoc comments
- Configuration schemas and examples
- Architecture decision records

Expected return format: list of documentation file paths with brief relevance notes. Max 20 paths.

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
