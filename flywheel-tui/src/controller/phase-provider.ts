/**
 * PhaseProvider interface — abstracts the source of execution phases.
 *
 * PlanFileProvider parses markdown plan files; WorkflowDefinitionProvider
 * wraps WorkflowDefinition objects. Both return a uniform PhaseInfo[].
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PhaseInfo {
  /** 0-based index */
  index: number;
  /** Phase title */
  title: string;
  /** Full content for prompt building (raw markdown or step description) */
  description: string;
  /** Execution status */
  status: "completed" | "pending" | "in_progress";
  /** Top-level checklist items (work path only) */
  steps?: string[];
  /** Milestone this phase belongs to (from `## Milestone: <name>` markers in plan) */
  milestone?: string;
}

export interface PhaseProvider {
  /** Return all phases with their current status. */
  getPhases(): PhaseInfo[];
  /** Total number of phases. */
  readonly phaseCount: number;
}
