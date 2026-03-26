/**
 * Sprint revision prompt — retry prompt with cumulative context from all
 * previous iterations.
 *
 * Includes: iteration counter, ALL previous attempt summaries, ALL previous
 * evaluator feedback (both implementation and script channels), ALL previous
 * verification outputs, and instruction to update existing work (not restart).
 */

import type { WorkflowStepContext } from "../index.js";
import { renderHandoffInstruction, SPRINT_FIELDS } from "../../handoff/field-specs.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SprintIterationSummary {
  iteration: number;
  workerSummary: string;
  evaluatorFeedback?: {
    implementation: string;
    script: string;
  };
  verificationOutput?: {
    stdout: string;
    stderr: string;
    exitCode: number;
  };
  scriptContent?: string;
}

export interface SprintRevisionInput {
  ctx: WorkflowStepContext;
  currentIteration: number;
  maxIterations: number;
  previousIterations: SprintIterationSummary[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderIterationHistory(iterations: SprintIterationSummary[]): string {
  return iterations
    .map((iter) => {
      const sections: string[] = [];

      sections.push(`### Attempt ${iter.iteration}`);
      sections.push(`**Worker Summary:** ${iter.workerSummary}`);

      if (iter.evaluatorFeedback) {
        sections.push(`**Implementation Feedback:** ${iter.evaluatorFeedback.implementation}`);
        sections.push(`**Script Feedback:** ${iter.evaluatorFeedback.script}`);
      }

      if (iter.verificationOutput) {
        sections.push(`**Verification Output (exit code ${iter.verificationOutput.exitCode}):**`);
        if (iter.verificationOutput.stdout) {
          sections.push("```\n" + iter.verificationOutput.stdout + "\n```");
        }
        if (iter.verificationOutput.stderr) {
          sections.push("stderr:\n```\n" + iter.verificationOutput.stderr + "\n```");
        }
      }

      return sections.join("\n");
    })
    .join("\n\n");
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
- Summary of what was updated
- Path to the verification script
- Evidence of verification (command outputs)`;
}

// ---------------------------------------------------------------------------
// Main prompt builder
// ---------------------------------------------------------------------------

/**
 * Builds a retry prompt for sprint iteration N > 1.
 *
 * Includes cumulative context from ALL previous iterations so the worker
 * can address all prior feedback without restarting from scratch.
 */
export function buildSprintRevisionPrompt(input: SprintRevisionInput): string {
  const { ctx, currentIteration, maxIterations, previousIterations } = input;

  const iterationHistory = renderIterationHistory(previousIterations);

  return `# Sprint Execution — Iteration ${currentIteration} of ${maxIterations}

## Task

${ctx.planContent}

${ctx.projectCwd ? `## Working Directory\n\n\`${ctx.projectCwd}\`` : ""}

## Previous Attempts

The following attempts have been made. Review ALL feedback carefully before proceeding.

${iterationHistory}

## Instructions

**Do not start from scratch.** You have existing work from previous iterations. Update and improve it based on the feedback above.

Focus on:
1. Addressing ALL evaluator feedback from previous iterations (both implementation and script channels)
2. Fixing issues identified in verification output
3. Strengthening the verification script — do NOT weaken or remove assertions
4. Ensuring the verification script tests actual runtime behavior

**Important:** The evaluator will compare your verification script against previous versions. If you remove or trivialize assertions to make them pass, the evaluator will FAIL you. Fix the implementation to make the assertions pass, do not weaken the assertions.

${completionSection(ctx)}
`;
}
