import type { WorkflowStepContext } from "../index.js";
import {
  TDD_CYCLE,
  VERIFICATION_BANNED_PHRASES,
  SCOPE_DISCIPLINE,
  THREE_STRIKE_PROTOCOL,
} from "../conventions.js";

/**
 * Builds a prompt for executing a single work phase (TDD, verification gates).
 */
export function buildWorkPhasePrompt(ctx: WorkflowStepContext): string {
  const decisions =
    ctx.keyDecisions.length > 0
      ? ctx.keyDecisions.map((d) => `- ${d}`).join("\n")
      : "_No prior decisions._";

  const files =
    ctx.fileReferences.length > 0
      ? ctx.fileReferences.map((f) => `- \`${f}\``).join("\n")
      : "_No file references._";

  const previousOutput = ctx.previousResult
    ? `## Previous Phase Result\n\n${ctx.previousResult}`
    : "";

  return `# Work Phase Execution

## Task

${ctx.planContent}

${previousOutput}

## Key Decisions from Prior Phases

${decisions}

## File References

${files}

${ctx.projectCwd ? `## Working Directory\n\n\`${ctx.projectCwd}\`` : ""}

---

${TDD_CYCLE}

${SCOPE_DISCIPLINE}

## Verification Protocol

Before making ANY claim about the state of the code, follow this protocol:

1. **IDENTIFY:** What command proves this claim?
2. **RUN:** Execute the FULL command fresh (do not rely on cached or remembered output).
3. **READ:** Read the full output. Check the exit code.
4. **VERIFY:** Does the output actually confirm the claim?
5. **ONLY THEN:** Make the claim, citing the evidence.

### Evidence Requirements

| Claim | Required Evidence |
|-------|-------------------|
| "Tests pass" | Full test runner output with exit code 0 |
| "Build succeeds" | Full build output with exit code 0 |
| "Type-checks clean" | \`tsc --noEmit\` output with exit code 0 |
| "Bug is fixed" | Before/after showing the behavior change |
| "No regressions" | Full test suite output, not a subset |
| "Feature works" | Concrete demonstration (test or command output) |

## Two-Stage Review

After completing the implementation:

1. **Spec compliance:** Does the implementation match every requirement in the task description? Walk through each checklist item.
2. **Code quality:** Are there obvious issues — dead code, missing error handling, incorrect types, untested branches?

${VERIFICATION_BANNED_PHRASES}

${THREE_STRIKE_PROTOCOL}

## Completion

When the phase is done, provide:
- Summary of what was implemented
- Evidence of verification (command outputs)
- Any decisions made that affect future phases
`;
}
