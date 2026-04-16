import { z } from "zod";
import { WorkerHandoffBaseSchema } from "../../infra/handoff-schemas.js";
import { EvaluatorResultSchema } from "../../infra/workflow-types.js";

// Extends base schema: makes suggestions required (LLMs should always produce it)
// and allows passthrough for forward-compatible handoff fields.
export const EvaluatorVerdictSchema = EvaluatorResultSchema
  .extend({ suggestions: z.array(z.string()) })
  .passthrough();

export type EvaluatorVerdict = z.infer<typeof EvaluatorVerdictSchema>;

const EvaluatorHandoffDataSchema = WorkerHandoffBaseSchema.pick({
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


