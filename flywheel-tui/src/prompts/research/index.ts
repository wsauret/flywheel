/**
 * Research prompt templates — standalone /research workflow.
 *
 * Three-step workflow: locate → analyze → persist.
 * Each step has a dedicated prompt builder following the WorkflowStepContext signature.
 */

export { buildResearchLocatePrompt } from "./locate.js";
export { buildResearchAnalyzePrompt } from "./analyze.js";
export { buildResearchPersistPrompt } from "./persist.js";

export { researchLocateEvaluationCriteria } from "./locate.js";
export { researchAnalyzeEvaluationCriteria } from "./analyze.js";
export { researchPersistEvaluationCriteria } from "./persist.js";
