/**
 * Research prompt templates — standalone /research workflow.
 *
 * Three-step workflow: locate → analyze → persist.
 * Each step has a dedicated prompt builder following the WorkflowStepContext signature.
 */

export { buildResearchLocatePrompt } from "./locate.js";
export { buildResearchAnalyzePrompt } from "./analyze.js";
export { buildResearchPersistPrompt } from "./persist.js";

export { researchLocateValidationCriteria } from "./locate.js";
export { researchAnalyzeValidationCriteria } from "./analyze.js";
export { researchPersistValidationCriteria } from "./persist.js";
