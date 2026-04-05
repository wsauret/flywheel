export const debugVerifyEvaluationCriteria =
  "Verification command output shows the issue is resolved";

export const ESCALATION_FORMAT = `## Escalation Format (after 10 iterations)

If the fix loop exceeds 10 iterations without resolution:

\`\`\`markdown
## Escalation

**Problem:** <original problem statement>
**Attempts:** <count>
**Root cause hypothesis:** <best current understanding>
**What was tried:**
1. <attempt 1 summary + result>
2. <attempt 2 summary + result>
...
**Blocking on:** <what specifically is preventing resolution>
**Suggested next steps:** <what a human should investigate>
\`\`\``;

export const RESOLUTION_FORMAT = `## Completion Format

When the bug is fixed:

\`\`\`markdown
## Resolution

**Root cause:** <clear explanation of what was wrong>
**Fix applied:** <what was changed, with file:line references>
**Verification evidence:** <command output proving the fix works>
\`\`\``;
