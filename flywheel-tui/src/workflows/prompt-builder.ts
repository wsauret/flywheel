/**
 * Workflow prompt builder — maps workflow steps to prompt templates.
 *
 * Uses the prompt templates from src/prompts/ (Phase 0 deliverables).
 * Each workflow type has a mapping from step index to the appropriate
 * template function.
 */

import type { WorkflowDefinition } from "../schemas/workflow";
import type { WorkflowStepContext } from "../prompts/index";
import {
  buildPlanResearchPrompt,
  buildPlanDraftPrompt,
  buildPlanReviewPrompt,
  buildPlanConsolidatePrompt,
  buildReviewDispatchPrompt,
  buildShipPrompt,
  buildDebugPrompt,
} from "../prompts/index";

// ---------------------------------------------------------------------------
// Per-workflow prompt builders (stepIndex → template function)
// ---------------------------------------------------------------------------

type PromptFn = (ctx: WorkflowStepContext) => string;

const planPrompts: PromptFn[] = [
  buildPlanResearchPrompt,
  buildPlanDraftPrompt,
  buildPlanReviewPrompt,
  buildPlanConsolidatePrompt,
];

const reviewPrompts: PromptFn[] = [
  // Step 0: Collect diff — uses the review dispatch template with just the diff
  buildReviewDispatchPrompt,
  // Step 1: Multi-agent review — same template, dispatches reviewers
  buildReviewDispatchPrompt,
  // Step 2: Consolidate — same template, consolidation pass
  buildReviewDispatchPrompt,
];

const shipPrompts: PromptFn[] = [
  // All ship steps use the same comprehensive ship prompt
  buildShipPrompt,
  buildShipPrompt,
  buildShipPrompt,
  buildShipPrompt,
];

const debugPrompts: PromptFn[] = [
  // All debug steps use the same debug prompt (investigate/fix/verify cycle)
  buildDebugPrompt,
  buildDebugPrompt,
  buildDebugPrompt,
];

const researchPrompts: PromptFn[] = [
  // Research reuses the plan research template for locating and analyzing
  buildPlanResearchPrompt,
  buildPlanResearchPrompt,
  buildPlanResearchPrompt,
];

const workflowPromptMap: Record<string, PromptFn[]> = {
  plan: planPrompts,
  review: reviewPrompts,
  ship: shipPrompts,
  debug: debugPrompts,
  research: researchPrompts,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a prompt for a given workflow step.
 *
 * @param stepIndex - Zero-based step index
 * @param workflow - The workflow definition
 * @param args - Workflow-specific arguments (description, topic, etc.)
 * @param previousResult - Output from the previous step (if any)
 * @param projectCwd - Working directory for the project
 * @param extra - Optional extra data to merge into ctx.extra (e.g. resolvedQuestions from onStepComplete accumulator)
 * @returns The assembled prompt string
 */
export function buildWorkflowPrompt(
  stepIndex: number,
  workflow: WorkflowDefinition,
  args: Record<string, string>,
  previousResult?: string,
  projectCwd?: string,
  extra?: Record<string, unknown>,
): string {
  const prompts = workflowPromptMap[workflow.name];

  // Build the context that all prompt templates expect
  const ctx: WorkflowStepContext = {
    planContent: args.description ?? args.topic ?? args.planPath ?? "",
    keyDecisions: [],
    fileReferences: [],
    previousResult,
    projectCwd,
    extra,
  };

  if (prompts && stepIndex < prompts.length) {
    return prompts[stepIndex](ctx);
  }

  // Fallback: generic prompt built from step description
  const step = workflow.steps[stepIndex];
  if (!step) {
    return `Execute step ${stepIndex + 1} of ${workflow.name} workflow.`;
  }

  return [
    `# ${workflow.name} — Step ${stepIndex + 1}`,
    "",
    `## Objective`,
    "",
    step.description,
    "",
    step.dispatcherHint ? `## Approach\n\n${step.dispatcherHint}` : "",
    step.validationCriteria
      ? `## Success Criteria\n\n${step.validationCriteria}`
      : "",
    "",
    ctx.planContent ? `## Context\n\n${ctx.planContent}` : "",
    previousResult ? `## Previous Step Result\n\n${previousResult}` : "",
    projectCwd ? `## Working Directory\n\n\`${projectCwd}\`` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
