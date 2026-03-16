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

export const TOKEN_LIMITS = `## Token Limits

- Locator output: max 500 tokens
- Analyzer output: max 750 tokens
- Research output: max 500 tokens
- Reviewer output: max 1000 tokens`;

export const VERIFICATION_BANNED_PHRASES = `## Verification — Banned Phrases

Never claim without evidence. The following phrases are BANNED unless accompanied by concrete proof (command output, test result, file content):

"Done", "Fixed", "Complete", "Passing", "Working", "Should work", "Probably", "Seems to", "Great!", "Perfect!", "Looks good!"`;
