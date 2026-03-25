import type { WorkflowStepContext } from "../index.js";
import {
  TDD_CYCLE,
  UNDERSTAND_ACT_VERIFY,
  VERIFICATION_BANNED_PHRASES,
  SCOPE_DISCIPLINE,
  THREE_STRIKE_PROTOCOL,
  buildIterationBudgetInstruction,
  buildProjectContextSection,
} from "../conventions.js";
import { renderHandoffInstruction, WORK_PHASE_FIELDS } from "../../handoff/field-specs.js";

// ---------------------------------------------------------------------------
// Boundaries section
// ---------------------------------------------------------------------------

interface BoundariesConfig {
  port_ranges?: string[];
  off_limits_dirs?: string[];
  external_services?: string[];
}

/**
 * Build a "Mission Boundaries" section from boundaries config in ctx.extra.
 * Returns an empty string if no boundaries are configured or all fields are empty.
 */
function buildBoundariesSection(extra?: Record<string, unknown>): string {
  if (!extra) return "";

  const boundaries = extra.boundaries as BoundariesConfig | undefined;
  if (!boundaries) return "";

  const subsections: string[] = [];

  if (boundaries.port_ranges && boundaries.port_ranges.length > 0) {
    subsections.push(
      `### Port Ranges\n${boundaries.port_ranges.map((r) => `- ${r}`).join("\n")}`,
    );
  }

  if (boundaries.off_limits_dirs && boundaries.off_limits_dirs.length > 0) {
    subsections.push(
      `### Off-Limits Directories\n${boundaries.off_limits_dirs.map((d) => `- \`${d}\``).join("\n")}`,
    );
  }

  if (boundaries.external_services && boundaries.external_services.length > 0) {
    subsections.push(
      `### External Services\n${boundaries.external_services.map((s) => `- ${s}`).join("\n")}`,
    );
  }

  // If all fields are empty/missing, skip the section entirely
  if (subsections.length === 0) return "";

  return `## Mission Boundaries

**NEVER violate these boundaries.** If you cannot complete your work within these constraints, return to the orchestrator immediately with a description of what is blocked and why.

${subsections.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Completion / Handoff section
// ---------------------------------------------------------------------------

function completionSection(ctx: WorkflowStepContext): string {
  const handoffPath = ctx.extra?.handoffPath;
  if (typeof handoffPath === "string" && handoffPath.length > 0) {
    return renderHandoffInstruction(WORK_PHASE_FIELDS, handoffPath);
  }
  // Backward-compatible fallback when no handoffPath is available
  return `## Completion

When the phase is done, provide:
- Summary of what was implemented
- Evidence of verification (command outputs)
- Any decisions made that affect future phases`;
}

// ---------------------------------------------------------------------------
// Main prompt builder
// ---------------------------------------------------------------------------

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

  const iterationBudget =
    typeof ctx.extra?.iterationBudget === "number"
      ? `\n${buildIterationBudgetInstruction(ctx.extra.iterationBudget)}\n`
      : "";

  const projectContext = buildProjectContextSection(ctx.extra);
  const boundariesSection = buildBoundariesSection(ctx.extra);

  return `# Work Phase Execution

## Task

${ctx.planContent}

${previousOutput}

## Key Decisions from Prior Phases

${decisions}

## File References

${files}

${ctx.projectCwd ? `## Working Directory\n\n\`${ctx.projectCwd}\`` : ""}

${projectContext}

${boundariesSection}

---

${TDD_CYCLE}

${SCOPE_DISCIPLINE}

${UNDERSTAND_ACT_VERIFY}
${iterationBudget}
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

## Shared Knowledge Library

Before starting work, read any existing files in \`.flywheel/library/\` for context from prior phases:
- \`environment.md\` — ports, env vars, service configuration
- \`architecture.md\` — architectural decisions, component relationships, design patterns

Before completing your phase, write any critical discoveries to \`.flywheel/library/\`:
- Ports, environment variables, or service configuration that future phases need
- Architectural decisions or patterns that affect the broader system
- Gotchas, workarounds, or non-obvious constraints discovered during implementation

Create or update files by topic (e.g., \`environment.md\`, \`architecture.md\`). Keep entries concise and actionable.

${completionSection(ctx)}
`;
}
