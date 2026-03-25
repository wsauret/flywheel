import type { WorkflowStepContext } from "../index.js";

export const shipStageValidationCriteria =
  "Changes are staged with specific paths";
export const shipCommitValidationCriteria =
  "Branch created with descriptive name, commit with imperative mood message";
export const shipPRValidationCriteria =
  "PR created with concise title and body, no AI attribution";

/**
 * Builds a prompt for the ship workflow (branch → commit → PR → compound).
 */
export function buildShipPrompt(ctx: WorkflowStepContext): string {
  return `# Ship Workflow

## Changes to Ship

${ctx.planContent}

${ctx.projectCwd ? `## Working Directory\n\n\`${ctx.projectCwd}\`` : ""}

---

## CRITICAL Rules

- **NEVER** add Co-Authored-By lines or AI attribution to commits.
- **NEVER** mention AI, assistant, copilot, or any automated tool in PR descriptions or commit messages.
- Write everything as if the user wrote it themselves.

## Branch Naming

Format: \`<type>/<short-description>\`

Types: \`feat\`, \`fix\`, \`refactor\`, \`docs\`, \`test\`, \`chore\`

Examples:
- \`feat/jwt-auth\`
- \`fix/memory-leak-ws-handler\`
- \`refactor/extract-parser-module\`

## Commit Practices

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
   - Bad: \`AI-generated changes for authentication feature\`

## PR Format

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
- Link to relevant issues if they exist

## Edge Cases

### Empty diff
If there are no changes to commit, report this and stop. Do not create empty commits or PRs.

### Merge conflicts
If the branch has merge conflicts with the base:
1. Report the conflicting files
2. Do NOT attempt to resolve automatically unless the resolution is trivial (e.g., both sides added different items to a list)
3. Ask the user how they want to proceed

### Already pushed
If the branch already exists on remote with commits, verify the local branch is up to date before pushing.
`;
}
