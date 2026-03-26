/**
 * Sprint workflow definition.
 *
 * Sprint mode uses queue-based execution (src/queue/sprint.ts) with
 * work+verify step pairs and dynamic retry/escalation insertion.
 *
 * This definition exists for:
 * - Registry inclusion in workflowRegistry
 * - Synthetic plan content generation for dispatcher context
 * - WorkflowDefinitionProvider compatibility
 */

import type { WorkflowDefinition } from "../schemas/workflow";

export const sprintWorkflow: WorkflowDefinition = {
  name: "sprint",
  description: "Fast iteration — implement, verify, retry. Skips planning/review overhead.",
  steps: [
    {
      description: "Sprint execution: implement task with verification script, iterate until passing",
      dispatcherHint:
        "Use sprint/phase-prompt template. Worker explores codebase, implements, writes verification script.",
      validationCriteria: "Verification script passes (exit code 0), implementation complete.",
    },
  ],
};
