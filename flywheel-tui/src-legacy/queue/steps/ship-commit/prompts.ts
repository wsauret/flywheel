// ---------------------------------------------------------------------------
// Ship workflow — reusable constants for prompt scaffolding
// ---------------------------------------------------------------------------

export const shipStageEvaluationCriteria =
  "Changes are staged with specific paths";
export const shipCommitEvaluationCriteria =
  "Branch created with descriptive name, commit with imperative mood message";
export const shipPREvaluationCriteria =
  "PR created with concise title and body, no AI attribution";

// ---------------------------------------------------------------------------
// Reusable prompt constants
// ---------------------------------------------------------------------------

/** No-AI-attribution rule for commits and PRs. */
export const NO_AI_ATTRIBUTION_RULE = `## CRITICAL Rules

- **NEVER** add Co-Authored-By lines or AI attribution to commits.
- **NEVER** mention AI, assistant, copilot, or any automated tool in PR descriptions or commit messages.
- Write everything as if the user wrote it themselves.`;

/** Branch naming convention. */
export const BRANCH_NAMING = `## Branch Naming

Format: \`<type>/<short-description>\`

Types: \`feat\`, \`fix\`, \`refactor\`, \`docs\`, \`test\`, \`chore\`

Examples:
- \`feat/jwt-auth\`
- \`fix/memory-leak-ws-handler\`
- \`refactor/extract-parser-module\``;

/** Staging rules for ship workflow. */
export const STAGING_RULES = `## Commit Practices

1. **Review the diff** before committing. Understand what changed and why.
2. **Group related changes** into logical commits. One commit per logical change.
3. **Stage with specific paths** — never use \`git add -A\` or \`git add .\`. Stage exactly what belongs in each commit.
4. **Commit message format:**
   - First line: imperative mood, max 72 characters, focus on "why" not "what"
   - Blank line
   - Body (optional): additional context if the "why" isn't obvious from the diff
5. **Examples:**
   - Good: \`add rate limiting to auth endpoints\`
   - Good: \`fix connection leak in WebSocket handler\`
   - Bad: \`update files\`
   - Bad: \`fix bug\`
   - Bad: \`AI-generated changes for authentication feature\``;

/** PR format template. */
export const PR_FORMAT = `## PR Format

### Title
- Short, under 70 characters
- Imperative mood (same as commit messages)
- Examples: "Add JWT auth to API endpoints", "Fix memory leak in WS handler"

### Body

\`\`\`markdown
## Summary

<1-3 sentences explaining what this PR does and why>

## Changes

- <bulleted list of concrete changes>
- <each bullet is one logical change>
\`\`\`

**Rules:**
- No filler ("This PR...", "In this change...")
- No boilerplate ("## Testing", "## Screenshots" if empty)
- No AI disclaimers or attribution of any kind
- Link to relevant issues if they exist`;
