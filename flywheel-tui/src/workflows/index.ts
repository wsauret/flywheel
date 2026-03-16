/**
 * Workflow definitions for all non-work workflows.
 *
 * "work" still uses the dedicated WorkController with plan parsing.
 * These workflows use the generic WorkflowRunner.
 */

export { planWorkflow } from "./plan";
export { reviewWorkflow } from "./review";
export { shipWorkflow } from "./ship";
export { debugWorkflow } from "./debug";
export { researchWorkflow } from "./research";

export { StepExecutor } from "./step-executor";
export type { StepExecutorOptions } from "./step-executor";

export { WorkflowRunner } from "./workflow-runner";
export type { WorkflowRunnerOptions, WorkflowRunResult } from "./workflow-runner";

export { buildWorkflowPrompt } from "./prompt-builder";

import type { WorkflowDefinition } from "../schemas/workflow";
import { planWorkflow } from "./plan";
import { reviewWorkflow } from "./review";
import { shipWorkflow } from "./ship";
import { debugWorkflow } from "./debug";
import { researchWorkflow } from "./research";

/**
 * Registry of all non-work workflow definitions, keyed by name.
 */
export const workflowRegistry: Record<string, WorkflowDefinition> = {
  plan: planWorkflow,
  review: reviewWorkflow,
  ship: shipWorkflow,
  debug: debugWorkflow,
  research: researchWorkflow,
};
