/**
 * Shared conventions — composable string fragments for prompt templates.
 * Import and include relevant fragments in domain-specific templates.
 */

export const SEVERITY_DEFINITIONS = `## Severity Definitions

- **P1 (Critical):** Blocks correctness, security, or data integrity. Must fix before merge.
- **P2 (Important):** Significant quality/maintainability impact. Should fix.
- **P3 (Minor):** Style, nice-to-have, or speculative improvement. Fix if convenient.`;

export const TDD_CYCLE = `## TDD Cycle

**RED:** Write a failing test first. One test, one behavior. Run tests — confirm FAILS for the expected reason (not a syntax error). If it passes immediately, the test is wrong; rewrite it.

**GREEN:** Write the minimum code to make the test pass. No refactoring, no extras. Run tests — confirm PASSES.

**REFACTOR:** Clean up while green. Run tests after each change.

**Skip TDD for:** pure refactoring (existing tests cover), config-only changes, documentation changes.
**Do NOT skip for:** security configurations, API contracts, data migrations.`;

export const DOCUMENTARIAN_MODE = `## Documentarian Mode

Document what IS, not what SHOULD BE. No suggestions, critiques, or recommendations. Pure technical mapping of the existing system.`;

export const FILE_LINE_DISCIPLINE = `## File/Line Citation

Always cite as \`file:line\` references. Prefer file:line references over quoting code. The reader can look up the context themselves.`;

export const READ_FULLY_RULE = `## Read Fully Rule

Partial reads cause hallucination. Read fully once, not partially multiple times. For files >500 lines, read in chunks but ensure complete coverage.`;

export const LOCATOR_ANALYZER_PATTERN = `## Locator → Analyzer Pattern

- **Locators** find WHERE things are (file paths, line numbers).
- **Analyzers** understand HOW things work (read files, document implementation).
- Always locate first, then analyze.`;

export const SCOPE_DISCIPLINE = `## Scope Discipline

When in doubt, do less. Premature abstraction costs more than duplication. YAGNI — implement what's needed now, not what might be needed later.`;

export const THREE_STRIKE_PROTOCOL = `## Three-Strike Protocol

- **Strike 1 — Diagnose:** Understand the error, research if needed.
- **Strike 2 — Alternative approach:** Different strategy for the same goal.
- **Strike 3 — Broader rethink:** Question assumptions, reduce scope.
- **After 3 strikes:** Escalate to user with full context of what was tried and why it failed.`;

export const AGENT_DISCOVERY_PHASE = `## Phase 0: Discover Available Agents

Before dispatching ANY agents via Task, you MUST first discover which agents are actually installed. Run these commands:

\`\`\`bash
# Project-local agents
find .claude/agents -name "*.md" 2>/dev/null

# User's global agents
find ~/.claude/agents -name "*.md" 2>/dev/null

# Plugin agents
find ~/.claude/plugins/cache -path "*/agents/*.md" 2>/dev/null
\`\`\`

Use the discovered agent filenames (without .md extension) as the \`subagent_type\` values in your Task calls. For agents in subdirectories (e.g., \`fly/agent-name.md\`), use the subdirectory-prefixed name (e.g., \`fly/agent-name\`).

**Do NOT dispatch agents that were not found by the discovery commands above.**`;

export const TOKEN_LIMITS = `## Token Limits

- Locator output: max 500 tokens
- Analyzer output: max 750 tokens
- Research output: max 2000 tokens
- Reviewer output: max 1000 tokens`;

export const UNDERSTAND_ACT_VERIFY = `## Understand-Act-Verify

Before making ANY change, follow this loop:

1. **UNDERSTAND:** Read existing code, understand context, review acceptance criteria. Do not guess — read the actual files.
2. **ACT:** Implement the change using all available tools. Do not stop and explain what you would do — do it.
3. **VERIFY:** Run the actual code. Check real outputs against acceptance criteria. Do not declare success based on unit tests alone — verify actual behavior.

Keep iterating this loop until acceptance criteria pass or your iteration budget is exhausted. Every iteration must make measurable progress.`;

export const VERIFICATION_BANNED_PHRASES = `## Verification — Banned Phrases

Never claim without evidence. The following phrases are BANNED unless accompanied by concrete proof (command output, test result, file content):

"Done", "Fixed", "Complete", "Passing", "Working", "Should work", "Probably", "Seems to", "Great!", "Perfect!", "Looks good!"`;

// ---------------------------------------------------------------------------
// Project Context section builder
// ---------------------------------------------------------------------------

import type { ContextEntry } from "../schemas/shared.js";

/**
 * Build a "Project Context" section from context entries in ctx.extra.
 * Returns an empty string if no entries are present.
 */
export function buildProjectContextSection(extra?: Record<string, unknown>): string {
  if (!extra) return "";

  const conventions = (extra.conventions ?? []) as ContextEntry[];
  const standards = (extra.standards ?? []) as ContextEntry[];
  const learnings = (extra.learnings ?? []) as ContextEntry[];

  const hasAny = conventions.length > 0 || standards.length > 0 || learnings.length > 0;
  if (!hasAny) return "";

  const formatEntries = (entries: ContextEntry[]): string =>
    entries.map((e) => `- \`${e.path}\` — ${e.summary}`).join("\n");

  const sections: string[] = [];

  if (conventions.length > 0) {
    sections.push(`### Conventions\n${formatEntries(conventions)}`);
  }
  if (standards.length > 0) {
    sections.push(`### Standards\n${formatEntries(standards)}`);
  }
  if (learnings.length > 0) {
    sections.push(`### Learnings\n${formatEntries(learnings)}`);
  }

  return `## Project Context

The following project files contain conventions and standards relevant to this step.
Read them before starting implementation.

${sections.join("\n\n")}`;
}

/**
 * Builds an iteration budget instruction for a worker prompt.
 * @param budget - Number of internal iteration cycles allowed (must be >= 1, finite)
 */
export function buildIterationBudgetInstruction(budget: number): string {
  if (budget < 1 || !Number.isFinite(budget)) {
    throw new Error(
      `Invalid iteration budget: ${budget}. Must be a finite number >= 1.`,
    );
  }
  return `You have ${budget} internal iteration cycles. Use them to refine your output. Do not signal completion until acceptance criteria are met or you've exhausted all ${budget} cycles.`;
}
