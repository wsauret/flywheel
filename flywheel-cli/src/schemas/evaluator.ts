import { z } from "zod";

export const EvaluatorInputSchema = z.object({
  worker_output: z.string(),
  validation_criteria: z.string(),
  context_files: z.array(z.string()),
}).strip();

export type EvaluatorInput = z.infer<typeof EvaluatorInputSchema>;

export const EvaluatorResultSchema = z.object({
  passed: z.boolean(),
  reasoning: z.string(),
  suggestions: z.array(z.string()).optional(),
}).strip();

export type EvaluatorResult = z.infer<typeof EvaluatorResultSchema>;
