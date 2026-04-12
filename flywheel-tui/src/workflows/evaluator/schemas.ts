import { z } from "zod";
import { SubprocessHandoffBaseSchema } from "../../infra/handoff-schemas";
import { StepContextSchema } from "../queue/step-context";

// ---------------------------------------------------------------------------
// Evaluator issue sub-schemas
// ---------------------------------------------------------------------------

export const EvaluatorIssueSeverityEnum = z.enum(["blocking", "non_blocking"]);

export const EvaluatorIssueCategoryEnum = z.enum([
  "test_failure",
  "type_error",
  "security",
  "regression",
  "incomplete",
  "other",
]);

export const EvaluatorIssueSchema = z.object({
  description: z.string().min(1, {
    message: "Issue description must not be empty.",
  }),
  severity: EvaluatorIssueSeverityEnum,
  category: EvaluatorIssueCategoryEnum,
}).strict();

// ---------------------------------------------------------------------------
// EvaluatorVerdictSchema (handoff written by evaluator subprocess)
// ---------------------------------------------------------------------------

export const EvaluatorVerdictSchema = z.object({
  passed: z.boolean(),
  reasoning: z.string(),
  suggestions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  feedback: z.string(),
  files_to_review: z.array(z.string()),
  issues: z.array(EvaluatorIssueSchema).default([]),
  implementation_feedback: z.string().optional(),
  script_feedback: z.string().optional(),
}).passthrough();

export type EvaluatorVerdict = z.infer<typeof EvaluatorVerdictSchema>;

// ---------------------------------------------------------------------------
// EvaluatorHandoffDataSchema (projection of worker handoff for evaluator)
// ---------------------------------------------------------------------------

export const EvaluatorHandoffDataSchema = SubprocessHandoffBaseSchema.pick({
  summary: true,
  verification: true,
  artifacts: true,
  files_to_review: true,
  warnings: true,
  decisions: true,
});

// ---------------------------------------------------------------------------
// EvaluatorInputSchema
// ---------------------------------------------------------------------------

export const EvaluatorInputSchema = z.object({
  worker_output: z.string(),
  evaluation_criteria: z.string(),
  context_files: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  artifacts_produced: z.array(z.string()),
  tests_passed: z.boolean().nullable(),
  task_context: z.string().optional(),
  handoff: EvaluatorHandoffDataSchema.optional(),
  step_context: StepContextSchema,
}).strip();

export type EvaluatorInput = z.infer<typeof EvaluatorInputSchema>;

// ---------------------------------------------------------------------------
// EvaluatorResultSchema — derived from EvaluatorVerdictSchema
// ---------------------------------------------------------------------------
// Identical fields, but `suggestions` is optional and passthrough is stripped.

export const EvaluatorResultSchema = EvaluatorVerdictSchema
  .extend({ suggestions: z.array(z.string()).optional() })
  .strip();

