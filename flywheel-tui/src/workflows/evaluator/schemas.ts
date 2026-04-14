import { z } from "zod";
import { SubprocessHandoffBaseSchema } from "../../infra/handoff-schemas.js";
import { EvaluatorResultSchema } from "../../infra/workflow-types.js";

export const EvaluatorVerdictSchema = EvaluatorResultSchema
  .omit({ implementation_feedback: true, script_feedback: true })
  .extend({ suggestions: z.array(z.string()) })
  .passthrough();

export type EvaluatorVerdict = z.infer<typeof EvaluatorVerdictSchema>;

const EvaluatorHandoffDataSchema = SubprocessHandoffBaseSchema.pick({
  summary: true,
  verification: true,
  artifacts: true,
  files_to_review: true,
  warnings: true,
  decisions: true,
});

const EvaluatorInputSchema = z.object({
  worker_output: z.string(),
  evaluation_criteria: z.string(),
  acceptance_criteria: z.array(z.string()),
  tests_passed: z.boolean().nullable(),
  task_context: z.string().optional(),
  handoff: EvaluatorHandoffDataSchema.optional(),
}).strip();

export type EvaluatorInput = z.infer<typeof EvaluatorInputSchema>;


