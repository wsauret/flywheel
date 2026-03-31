/**
 * Sprint step prompt — first iteration prompt for sprint workers.
 *
 * Enforces TDD ordering: explore codebase, write verification script FIRST
 * (RED), then implement until verification passes (GREEN), and produce a
 * handoff JSON with verification_script_path via renderHandoffInstruction(SPRINT_FIELDS).
 */

import type { WorkflowStepContext } from "./types.js";
import {
  SCOPE_DISCIPLINE,
  THREE_STRIKE_PROTOCOL,
  buildProjectContextSection,
} from "./conventions.js";
import { renderHandoffInstruction, SPRINT_FIELDS } from "../../handoff/field-specs.js";
import type { BoundariesConfig } from "../../config/loader.js";

// ---------------------------------------------------------------------------
// Boundaries section (reused pattern from work/step-prompt.ts)
// ---------------------------------------------------------------------------

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

  if (subsections.length === 0) return "";

  return `## Mission Boundaries

**NEVER violate these boundaries.** If you cannot complete your work within these constraints, stop immediately and explain what is blocked and why.

${subsections.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Handoff section
// ---------------------------------------------------------------------------

function completionSection(ctx: WorkflowStepContext): string {
  const handoffPath = ctx.extra?.handoffPath;
  if (typeof handoffPath === "string" && handoffPath.length > 0) {
    return renderHandoffInstruction(SPRINT_FIELDS, handoffPath);
  }
  return `## Handoff

When done, provide:
- Summary of what was implemented
- Path to the verification script
- Evidence of verification (command outputs)`;
}

// ---------------------------------------------------------------------------
// Main prompt builder
// ---------------------------------------------------------------------------

/**
 * Builds the first-iteration sprint prompt for a worker.
 *
 * Enforces TDD ordering: explore codebase, write verification script FIRST
 * (RED phase), then implement until verification passes (GREEN phase).
 * Includes handoff instruction with SPRINT_FIELDS, working directory,
 * scope discipline, three-strike protocol, knowledge library instruction,
 * and boundaries (when configured).
 */
export function buildSprintStepPrompt(ctx: WorkflowStepContext): string {
  const projectContext = buildProjectContextSection(ctx.extra);
  const boundariesSection = buildBoundariesSection(ctx.extra);

  return `# Sprint Execution

## Task

${ctx.planContent}

${ctx.projectCwd ? `## Working Directory\n\n\`${ctx.projectCwd}\`` : ""}

${projectContext}

${boundariesSection}

## Codebase Exploration

Before implementing anything, explore the codebase to understand:
- Project structure, conventions, and patterns
- Existing code related to this task
- Testing patterns and frameworks in use
- Dependencies and configuration

Read relevant files thoroughly. Do not guess — read the actual code.

## Sprint TDD — Write Verification FIRST

**You MUST follow strict Test-Driven Development in this sprint.** The verification
script is your acceptance gate — the queue will run it automatically after you finish
and FAIL the sprint if it exits non-zero.

### Step 1: RED — Write the Verification Script FIRST

Before writing ANY implementation code, create a verification script that defines
the success criteria for this task.

- Write the script to \`.flywheel/verify/<descriptive-name>.ts\` (or \`.sh\`)
- Create the \`.flywheel/verify/\` directory if it doesn't exist
- The script must be runnable and **exit 0 on success, non-zero on failure**
- The script must test actual runtime behavior, not just compilation or file existence
- The script must produce meaningful output describing what was tested and whether it passed
- The script must be executable and self-contained
- **Run the script now** to confirm it **FAILS** (RED phase) — if it passes before you implement anything, the test is wrong

#### What Makes a Good Verification Script

- Tests the actual feature end-to-end (e.g., starts a server, makes a request, checks the response)
- Verifies all acceptance criteria from the task description
- Tests error cases and edge cases, not just the happy path
- Prints clear pass/fail messages for each check
- Exits with non-zero code if ANY check fails

#### What to AVOID

- Scripts that only check if files exist — that is not behavioral testing
- Scripts that only run the compiler — compilation is not sufficient
- Scripts that always exit 0 regardless of results — this is useless
- Trivial scripts that test nothing meaningful — the evaluator will catch this and fail you

### Step 2: GREEN — Implement Until Verification Passes

Now implement the minimum code to make the verification script pass.

- Follow existing patterns and conventions
- Run the verification script after each significant change
- Stop as soon as the script passes — do not gold-plate

### Step 3: REFACTOR (Optional)

Clean up while green. Run the verification script after each refactoring change.

${SCOPE_DISCIPLINE}

${THREE_STRIKE_PROTOCOL}

## Shared Knowledge Library

Before starting work, read any existing files in \`.flywheel/library/\` for context from prior steps:
- \`environment.md\` — ports, env vars, service configuration
- \`architecture.md\` — architectural decisions, component relationships, design patterns

Before completing your sprint, write any critical discoveries to \`.flywheel/library/\`:
- Ports, environment variables, or service configuration that future work needs
- Architectural decisions or patterns that affect the broader system
- Gotchas, workarounds, or non-obvious constraints discovered during implementation

Create or update files by topic. Keep entries concise and actionable.

${completionSection(ctx)}
`;
}
