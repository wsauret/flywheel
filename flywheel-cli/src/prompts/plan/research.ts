import type { WorkflowStepContext } from "../index.js";
import {
  DOCUMENTARIAN_MODE,
  LOCATOR_ANALYZER_PATTERN,
  TOKEN_LIMITS,
  READ_FULLY_RULE,
  FILE_LINE_DISCIPLINE,
} from "../conventions.js";

/**
 * Builds a prompt for the plan research phase (locator → analyzer dispatch).
 */
export function buildPlanResearchPrompt(ctx: WorkflowStepContext): string {
  const files =
    ctx.fileReferences.length > 0
      ? ctx.fileReferences.map((f) => `- \`${f}\``).join("\n")
      : "_No initial file references._";

  return `# Plan Research

## Research Objective

${ctx.planContent}

## Known File References

${files}

${ctx.projectCwd ? `## Working Directory\n\n\`${ctx.projectCwd}\`` : ""}

---

${LOCATOR_ANALYZER_PATTERN}

${DOCUMENTARIAN_MODE}

${READ_FULLY_RULE}

${FILE_LINE_DISCIPLINE}

${TOKEN_LIMITS}

## BLOCKING Rule

Do NOT use Read/Grep/Glob for target codebase research directly. Dispatch locator Tasks first to find relevant files, then dispatch analyzer Tasks to understand them.

## Locator Dispatch Templates

### locator-codebase
Find WHERE files and components live. Return file paths and line numbers only. Focus on:
- Entry points and exports
- Directory structure and module boundaries
- Configuration files

### locator-patterns
Find WHERE specific patterns exist in the codebase. Return file paths and line numbers only. Focus on:
- Usage of specific APIs, functions, or types
- Import/dependency chains
- Naming conventions and existing patterns to follow

### locator-docs
Find WHERE documentation lives. Return file paths only. Focus on:
- README files, AGENTS.md, CONTRIBUTING guides
- Inline documentation and JSDoc comments
- Configuration schemas and examples

## Analyzer Dispatch Templates

### analyzer-codebase
Understand HOW code works. Read the files found by locators. Document:
- Function signatures and return types
- Data flow and state management
- Error handling patterns
- Side effects and I/O boundaries

### analyzer-patterns
Extract code examples with context. For each pattern found:
- The exact code with file:line reference
- How it's used by callers
- Constraints or invariants it depends on

## Ranking Locator Results

When multiple locator results come back, prioritize:
1. Files directly related to the feature being planned
2. Files that will need modification
3. Files that establish patterns to follow
4. Files that document constraints or conventions

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

1. **Codebase Map** — Directory structure and key file roles
2. **Relevant Code** — file:line references with brief descriptions
3. **Patterns to Follow** — Existing conventions the implementation should match
4. **Constraints** — Hard limits, dependencies, compatibility requirements
5. **Open Questions** — Anything unclear that needs user input before planning
`;
}
