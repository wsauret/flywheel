import type { WorkflowStepContext } from "../index.js";
import {
  THREE_STRIKE_PROTOCOL,
  VERIFICATION_BANNED_PHRASES,
  SCOPE_DISCIPLINE,
  READ_FULLY_RULE,
} from "../conventions.js";

export const debugInvestigateEvaluationCriteria =
  "Hypothesis formed with evidence and likelihood assessment";
export const debugFixEvaluationCriteria =
  "Fix applied with references documenting the change";
export const debugVerifyEvaluationCriteria =
  "Verification command output shows the issue is resolved";

/**
 * Builds a prompt for debugging (error diagnosis + fix-verify loop).
 */
export function buildDebugPrompt(ctx: WorkflowStepContext): string {
  const verificationCommand = ctx.extra?.verificationCommand;
  const verificationSection =
    typeof verificationCommand === "string"
      ? `## Verification Command\n\nUse this command to verify the fix:\n\`\`\`\n${verificationCommand}\n\`\`\``
      : "## Verification Command\n\n_No verification command provided. Determine the appropriate command from context._";

  const files =
    ctx.fileReferences.length > 0
      ? ctx.fileReferences.map((f) => `- \`${f}\``).join("\n")
      : "_No initial file references._";

  return `# Debug Investigation

## Problem Description

${ctx.planContent}

${verificationSection}

## Known File References

${files}

${ctx.projectCwd ? `## Working Directory\n\n\`${ctx.projectCwd}\`` : ""}

---

${READ_FULLY_RULE}

${SCOPE_DISCIPLINE}

## Investigation Methodology

Follow this order:

1. **Read error output carefully.** The error message usually points to the root cause. Do not skim.
2. **Search codebase for related code.** Find the function/module where the error originates.
3. **Check recent git changes.** \`git log --oneline -10\` and \`git diff HEAD~3\` can reveal what broke it.
4. **Form a hypothesis:**

\`\`\`
Hypothesis: <summary of what you think is wrong>
Evidence: <what supports this hypothesis>
Likelihood: <high / medium / low>
\`\`\`

Only proceed to fix after forming a hypothesis. Do NOT make changes based on guesses.

## Fix Loop Rules

1. **Minimum change principle:** The fix should be as small as possible. If your fix is >5 lines, explain why a smaller fix isn't possible.
2. **No shotgun debugging:** Do not change multiple things at once hoping one works. Fix the root cause.
3. **Changes accumulate:** Do not stash or revert between iterations. Each fix builds on the previous state.
4. **One fix per iteration:** Make one logical change, then verify. If it doesn't work, understand why before the next attempt.

## Fix Iteration Template

For each fix attempt:

\`\`\`
### Attempt N

**Hypothesis:** <what you think is wrong>
**Change:** <what you're changing and why>
**File(s):** <file:line references>
**Verification:** <command run and its output>
**Result:** PASS / FAIL
**Next step:** <if FAIL, what the output tells you>
\`\`\`

${THREE_STRIKE_PROTOCOL}

${VERIFICATION_BANNED_PHRASES}

## Escalation Format (after 10 iterations)

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
\`\`\`

## Completion Format

When the bug is fixed:

\`\`\`markdown
## Resolution

**Root cause:** <clear explanation of what was wrong>
**Fix applied:** <what was changed, with file:line references>
**Verification evidence:** <command output proving the fix works>
\`\`\`
`;
}
