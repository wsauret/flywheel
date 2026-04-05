/**
 * Prompt types — sprint-specific prompt building context.
 *
 * Two prompt architectures exist in the queue engine:
 *
 * 1. **Dispatcher + Scaffolding** (all non-sprint steps):
 *    The dispatcher decides WHAT to do (contextual task_content), then
 *    prompt-scaffolding.ts appends deterministic HOW instructions (output
 *    format, handoff, role-specific methodology). These use `StepContext`
 *    (the Zod-validated accumulator from queue/step-context.ts) and the
 *    step's own metadata. Prompt fragments live as exported constants in
 *    the sibling files (conventions.ts, review-dispatch.ts, etc.).
 *
 * 2. **Sprint handler** (sprint work/revision steps only):
 *    Bypasses the dispatcher entirely and builds the full prompt from
 *    scratch via buildSprintStepPrompt() / buildSprintRevisionPrompt().
 *    These need richer context (plan content, key decisions, file refs,
 *    iteration state) so they use WorkflowStepContext below.
 *
 * WorkflowStepContext is sprint-only because sprint is the only step type
 * that owns its entire prompt lifecycle. If other step types need to build
 * full prompts outside the dispatcher+scaffolding pipeline, they should
 * use this type too.
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
