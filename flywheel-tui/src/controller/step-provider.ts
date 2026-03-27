/**
 * StepProvider interface — abstracts the source of execution steps.
 *
 * PlanFileProvider parses markdown plan files; WorkflowDefinitionProvider
 * wraps WorkflowDefinition objects. Both return a uniform StepInfo[].
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StepInfo {
  /** 0-based index */
  index: number;
  /** Step title */
  title: string;
  /** Full content for prompt building (raw markdown or step description) */
  description: string;
  /** Execution status */
  status: "completed" | "pending" | "in_progress";
  /** Top-level checklist items (work path only) */
  steps?: string[];
  /** Milestone this step belongs to (from `## Milestone: <name>` markers in plan) */
  milestone?: string;
  /** Validation contract assertion IDs this step fulfills (from `<!-- fulfills: ... -->` annotations) */
  fulfills?: string[];
}

export interface StepProvider {
  /** Return all steps with their current status. */
  getSteps(): StepInfo[];
  /** Total number of steps. */
  readonly stepCount: number;
}
