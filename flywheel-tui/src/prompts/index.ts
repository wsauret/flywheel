/**
 * Prompt templates for flywheel workers.
 *
 * Each template is a pure function: (ctx: WorkflowStepContext) => string
 * Templates contain domain knowledge only — no orchestration logic.
 */

// ── Context type ────────────────────────────────────────────────

export interface WorkflowStepContext {
  /** Full plan content or phase content */
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

// ── Re-exports ──────────────────────────────────────────────────

export { buildWorkPhasePrompt } from "./work/phase-prompt.js";

export { buildPlanResearchPrompt } from "./plan/research.js";
export { buildPlanDraftPrompt } from "./plan/draft.js";
export { buildPlanReviewPrompt } from "./plan/review.js";
export { buildPlanConsolidatePrompt } from "./plan/consolidate.js";

export { buildReviewDispatchPrompt } from "./review/dispatch.js";
export { buildReviewConsolidatePrompt } from "./review/consolidate.js";

export { buildShipPrompt } from "./ship/workflow.js";

export { buildDebugPrompt } from "./debug/investigate.js";
