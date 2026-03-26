import { z } from "zod";
import { WorkerHandoffBaseSchema, EvaluatorIssueSchema } from "./handoff";
import { StageContextSchema } from "../controller/stage-context";

/**
 * Subset of WorkerHandoff fields projected for evaluator consumption.
 * Used when structured handoff data is available (Phase 3+).
 * Uses WorkerHandoffBaseSchema (the z.object) for .pick() support;
 * cross-field refinements from WorkerHandoffSchema don't apply here
 * since this is a projection, not full handoff validation.
 */
export const EvaluatorHandoffDataSchema = WorkerHandoffBaseSchema.pick({
  summary: true,
  verification: true,
  artifacts: true,
  files_to_review: true,
  warnings: true,
  decisions: true,
});

export type EvaluatorHandoffData = z.infer<typeof EvaluatorHandoffDataSchema>;

export const EvaluatorInputSchema = z.object({
  worker_output: z.string(),
  validation_criteria: z.string(),
  context_files: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  artifacts_produced: z.array(z.string()),
  tests_passed: z.boolean().nullable(),
  duration_seconds: z.number(),
  task_context: z.string().optional(),
  /** Structured handoff data from worker (optional; when present, used instead of worker_output). */
  handoff: EvaluatorHandoffDataSchema.optional(),
  /** Cumulative stage context from prior phases. Evaluator for phase N sees context from 1..N-1. */
  stage_context: StageContextSchema.optional(),
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
  /** Structured issues from evaluator verdict. Defaults to empty array for backward compat. */
  issues: z.array(EvaluatorIssueSchema).default([]),
  /** Sprint dual-channel feedback: specific feedback on the implementation. */
  implementation_feedback: z.string().optional(),
  /** Sprint dual-channel feedback: specific feedback on the verification script. */
  script_feedback: z.string().optional(),
}).strip();

export type EvaluatorResult = z.infer<typeof EvaluatorResultSchema>;
