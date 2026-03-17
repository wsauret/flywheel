/**
 * WorkflowDefinitionProvider — wraps a WorkflowDefinition into PhaseInfo[].
 *
 * Non-work workflows (plan, review, ship, debug, research) use
 * WorkflowDefinition objects instead of plan markdown files. This
 * provider adapts them to the uniform PhaseProvider interface.
 *
 * All phases always start as "pending" — non-work workflows have
 * no state persistence.
 */

import type { WorkflowDefinition } from "../schemas/workflow";
import type { PhaseInfo, PhaseProvider } from "./phase-provider";

// ---------------------------------------------------------------------------
// WorkflowDefinitionProvider
// ---------------------------------------------------------------------------

export class WorkflowDefinitionProvider implements PhaseProvider {
  private readonly workflow: WorkflowDefinition;
  private cachedPhases: PhaseInfo[] | undefined;

  constructor(workflow: WorkflowDefinition) {
    this.workflow = workflow;
  }

  getPhases(): PhaseInfo[] {
    if (this.cachedPhases) return this.cachedPhases;

    this.cachedPhases = this.workflow.steps.map((step, index) => ({
      index,
      title: step.description,
      description: step.description,
      status: "pending" as const,
      // Non-work workflows don't have checklist steps
      steps: undefined,
    }));
    return this.cachedPhases;
  }

  get phaseCount(): number {
    return this.workflow.steps.length;
  }
}
