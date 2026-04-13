import { z } from "zod";
import { SubprocessHandoffBaseSchema } from "../../infra/handoff-schemas";
import { StepContextSchema } from "../queue/step-context";
import { EvaluatorResultSchema } from "../../infra/workflow-types";

export const EvaluatorVerdictSchema = EvaluatorResultSchema
  .omit({ implementation_feedback: true, script_feedback: true })
  .extend({ suggestions: z.array(z.string()) })
  .passthrough();

export type EvaluatorVerdict = z.infer<typeof EvaluatorVerdictSchema>;

export const EvaluatorHandoffDataSchema = SubprocessHandoffBaseSchema.pick({
  summary: true,
  verification: true,
  artifacts: true,
  files_to_review: true,
  warnings: true,
  decisions: true,
});

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


