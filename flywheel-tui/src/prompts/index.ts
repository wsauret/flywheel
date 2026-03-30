/**
 * Prompt templates — shared types and re-exports.
 *
 * Build*Prompt functions are colocated with their constants in subdirectories.
 * The queue executor's prompt-scaffolding layer imports constants directly;
 * only the WorkflowStepContext type is shared across all prompt modules.
 */

// ── Context type ────────────────────────────────────────────────

export interface WorkflowStepContext {
  /** Full plan content or step content */
  planContent: string;
  /** Key decisions from state file */
  keyDecisions: string[];
  /** File references from context file */
  fileReferences: string[];
  /** Results from previous step (if any) */
  previousResult?: string;
  /** Working directory */
  projectCwd?: string;
  /** Additional step-specific context */
  extra?: Record<string, unknown>;
}
