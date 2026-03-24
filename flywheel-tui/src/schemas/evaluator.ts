import { z } from "zod";

export const EvaluatorInputSchema = z.object({
  worker_output: z.string(),
  validation_criteria: z.string(),
  context_files: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  artifacts_produced: z.array(z.string()),
  tests_passed: z.boolean().nullable(),
  duration_seconds: z.number(),
  task_context: z.string().optional(),
}).strip();

export type EvaluatorInput = z.infer<typeof EvaluatorInputSchema>;

export const EvaluatorResultSchema = z.object({
  passed: z.boolean(),
  // ADR spec uses 'reason'; kept as 'reasoning' for backward compat — intentional deviation
  reasoning: z.string(),
  suggestions: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1),
  feedback: z.string(),
  files_to_review: z.array(z.string()),
}).strip();

export type EvaluatorResult = z.infer<typeof EvaluatorResultSchema>;
