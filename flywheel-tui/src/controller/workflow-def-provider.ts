/**
 * WorkflowDefinitionProvider — wraps a WorkflowDefinition into StepInfo[].
 *
 * Non-work workflows (plan, review, ship, debug, research) use
 * WorkflowDefinition objects instead of plan markdown files. This
 * provider adapts them to the uniform StepProvider interface.
 *
 * All steps always start as "pending" — non-work workflows have
 * no state persistence.
 */

import type { WorkflowDefinition } from "../schemas/workflow";
import type { StepInfo, StepProvider } from "./step-provider";

// ---------------------------------------------------------------------------
// WorkflowDefinitionProvider
// ---------------------------------------------------------------------------

export class WorkflowDefinitionProvider implements StepProvider {
  private readonly workflow: WorkflowDefinition;
  private cachedSteps: StepInfo[] | undefined;

  constructor(workflow: WorkflowDefinition) {
    this.workflow = workflow;
  }

  getSteps(): StepInfo[] {
    if (this.cachedSteps) return this.cachedSteps;

    this.cachedSteps = this.workflow.steps.map((step, index) => ({
      index,
      title: step.description,
      description: step.description,
      status: "pending" as const,
      // Non-work workflows don't have checklist steps
      steps: undefined,
    }));
    return this.cachedSteps;
  }

  get stepCount(): number {
    return this.workflow.steps.length;
  }
}
