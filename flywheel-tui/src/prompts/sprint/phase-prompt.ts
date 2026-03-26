/**
 * Sprint phase prompt — first iteration prompt for sprint workers.
 *
 * Instructs the worker to: explore the codebase, implement the task,
 * write a behavioral verification script, and produce a handoff JSON
 * with verification_script_path via renderHandoffInstruction(SPRINT_FIELDS).
 */

import type { WorkflowStepContext } from "../index.js";
import {
  TDD_CYCLE,
  SCOPE_DISCIPLINE,
  THREE_STRIKE_PROTOCOL,
  buildProjectContextSection,
} from "../conventions.js";
import { renderHandoffInstruction, SPRINT_FIELDS } from "../../handoff/field-specs.js";
import type { BoundariesConfig } from "../../config/loader.js";

// ---------------------------------------------------------------------------
// Boundaries section (reused pattern from work/phase-prompt.ts)
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
 * Includes: task description, codebase exploration, implementation instruction,
 * verification script requirements, handoff instruction with SPRINT_FIELDS,
 * working directory, TDD cycle, scope discipline, three-strike protocol,
 * knowledge library instruction, and boundaries (when configured).
 */
export function buildSprintPhasePrompt(ctx: WorkflowStepContext): string {
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

## Implementation

Implement the task described above. Follow existing patterns and conventions.

${TDD_CYCLE}

${SCOPE_DISCIPLINE}

${THREE_STRIKE_PROTOCOL}

## Verification Script

**CRITICAL:** You MUST write a verification script that validates your implementation works correctly.

### Requirements

- Write the script to \`.flywheel/verify/\` (create the directory if it doesn't exist)
- The script must be a \`.ts\` or \`.sh\` file
- **Exit code 0 = pass, non-zero = fail** — this is the primary acceptance gate
- The script must test actual runtime behavior, not just compilation or file existence
- The script must produce meaningful output describing what was tested and whether it passed
- The script must be executable and self-contained

### What Makes a Good Verification Script

- Tests the actual feature end-to-end (e.g., starts a server, makes a request, checks the response)
- Verifies all acceptance criteria from the task description
- Tests error cases and edge cases, not just the happy path
- Prints clear pass/fail messages for each check
- Exits with non-zero code if ANY check fails

### What to AVOID

- Scripts that only check if files exist — that is not behavioral testing
- Scripts that only run the compiler — compilation is not sufficient, not just compilation of the project
- Scripts that always exit 0 regardless of results — this is useless
- Trivial scripts that test nothing meaningful — the evaluator will catch this and fail you

## Shared Knowledge Library

Before starting work, read any existing files in \`.flywheel/library/\` for context from prior phases:
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
