/**
 * Prompt templates for flywheel workers.
 *
 * Each template is a pure function: (ctx: WorkflowStepContext) => string
 * Templates contain domain knowledge only — no orchestration logic.
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

// ── Re-exports: prompt builders ─────────────────────────────────

export { buildWorkStepPrompt } from "./work/step-prompt.js";
export { buildScrutinyPrompt } from "./work/scrutiny.js";
export { buildBehavioralValidationPrompt } from "./work/behavioral-validation.js";

export { buildPlanResearchPrompt } from "./plan/research.js";
export { buildPlanDraftPrompt } from "./plan/draft.js";
export { buildPlanReviewPrompt } from "./plan/review.js";
export { buildPlanConsolidatePrompt } from "./plan/consolidate.js";

export { buildReviewDispatchPrompt } from "./review/dispatch.js";
export { buildReviewConsolidatePrompt } from "./review/consolidate.js";
export { buildReviewFixPrompt } from "./review/fix.js";

export { buildShipPrompt } from "./ship/workflow.js";
export { buildShipCompoundPrompt } from "./ship/compound.js";

export { buildDebugPrompt } from "./debug/investigate.js";

export {
  buildResearchLocatePrompt,
  buildResearchAnalyzePrompt,
  buildResearchPersistPrompt,
} from "./research/index.js";

export { buildSprintStepPrompt } from "./sprint/step-prompt.js";
export { buildSprintRevisionPrompt } from "./sprint/revision-prompt.js";
export { buildSprintEvaluatorPrompt, SPRINT_EVALUATOR_SYSTEM_PROMPT } from "./sprint/evaluator-prompt.js";

// ── Re-exports: colocated evaluation criteria ───────────────────

export { planResearchEvaluationCriteria } from "./plan/research.js";
export { planDraftEvaluationCriteria } from "./plan/draft.js";
export { planReviewEvaluationCriteria } from "./plan/review.js";
export { planConsolidateEvaluationCriteria } from "./plan/consolidate.js";

export { reviewDispatchEvaluationCriteria } from "./review/dispatch.js";
export { reviewConsolidateEvaluationCriteria } from "./review/consolidate.js";
export { reviewFixEvaluationCriteria } from "./review/fix.js";

export { shipStageEvaluationCriteria, shipCommitEvaluationCriteria, shipPREvaluationCriteria } from "./ship/workflow.js";
export { shipCompoundEvaluationCriteria } from "./ship/compound.js";

export { debugInvestigateEvaluationCriteria, debugFixEvaluationCriteria, debugVerifyEvaluationCriteria } from "./debug/investigate.js";

export { researchLocateEvaluationCriteria } from "./research/locate.js";
export { researchAnalyzeEvaluationCriteria } from "./research/analyze.js";
export { researchPersistEvaluationCriteria } from "./research/persist.js";
