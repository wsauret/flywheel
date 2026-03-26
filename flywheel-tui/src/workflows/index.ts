/**
 * Workflow definitions for all workflow types.
 *
 * Each workflow type has a definition that specifies steps, prompts,
 * and validation criteria. Execution is handled by the queue-based
 * step executor (src/queue/executor.ts).
 */

export { planWorkflow } from "./plan";
export { reviewWorkflow } from "./review";
export { shipWorkflow } from "./ship";
export { debugWorkflow } from "./debug";
export { researchWorkflow } from "./research";
export { sprintWorkflow } from "./sprint";

export { buildWorkflowPrompt } from "./prompt-builder";

import type { WorkflowDefinition } from "../schemas/workflow";
import { planWorkflow } from "./plan";
import { reviewWorkflow } from "./review";
import { shipWorkflow } from "./ship";
import { debugWorkflow } from "./debug";
import { researchWorkflow } from "./research";
import { sprintWorkflow } from "./sprint";

/**
 * Registry of all non-work workflow definitions, keyed by name.
 */
export const workflowRegistry: Record<string, WorkflowDefinition> = {
  plan: planWorkflow,
  review: reviewWorkflow,
  ship: shipWorkflow,
  debug: debugWorkflow,
  research: researchWorkflow,
  sprint: sprintWorkflow,
};
