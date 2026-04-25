import { fileURLToPath } from "node:url";

import { formatChecklistLabels } from "../../shared/quality-checklist.js";
import { loadStepMarkdown } from "../../shared/load-step-markdown.js";

/** Sprint evaluator system prompt addendum — aligns the evaluator with the 7-point self-review checklist. */
export const SPRINT_EVALUATOR_ADDENDUM =
  "You are evaluating sprint mode work. Evaluate against the self-review checklist " +
  `(${formatChecklistLabels()}). ` +
  "PASS work that meets the task requirements. " +
  "Only FAIL for hard evidence: tests failing, critical deliverables missing, or fundamentally broken output."

/** Sprint mode preamble — injected into every sprint worker prompt. */
export const SPRINT_PREAMBLE = loadStepMarkdown(
  fileURLToPath(new URL("./preamble.md", import.meta.url)),
  "workflows/queue/steps/sprint/preamble.md",
  "sprint preamble",
);
