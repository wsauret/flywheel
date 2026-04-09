import { z } from "zod";
import {
  EvaluationCriteriaSchema,
  type EvaluationCriteria,
  ToolScopingSchema,
  type ToolScoping,
  WorkerConfigSchema,
  type WorkerConfig,
} from "../infra/workflow-types";

// Re-export canonical schemas from infra (single source of truth — ADR-006)
export { EvaluationCriteriaSchema, type EvaluationCriteria, ToolScopingSchema, type ToolScoping, WorkerConfigSchema, type WorkerConfig };

/** Serialize evaluation criteria to a human-readable string (for evaluator prompts). */
export function serializeEvaluationCriteria(criteria: EvaluationCriteria): string {
  const parts: string[] = [];
  if (criteria.acceptance_criteria.length > 0) {
    parts.push("Acceptance criteria:", ...criteria.acceptance_criteria.map((c) => `- ${c}`));
  }
  if (criteria.required_tests) {
    parts.push("Required: tests must pass");
  }
  if (criteria.custom_checks.length > 0) {
    parts.push("Custom checks:", ...criteria.custom_checks.map((c) => `- ${c}`));
  }
  if (criteria.required_outputs.length > 0) {
    parts.push("Required outputs:", ...criteria.required_outputs.map((o) => `- ${o}`));
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// BudgetLimitsSchema — limits only (WP2)
// ---------------------------------------------------------------------------
export const BudgetLimitsSchema = z.object({
  max_invocations: z.number().min(0),
  max_tokens: z.number().nullable(),
  wall_clock_deadline: z.string().nullable(),
}).strip();

export type BudgetLimits = z.infer<typeof BudgetLimitsSchema>;

// ---------------------------------------------------------------------------
// BudgetUsageSchema — usage only (WP2)
// ---------------------------------------------------------------------------
export const BudgetUsageSchema = z.object({
  invocations_used: z.number().min(0),
  tokens_used: z.number().min(0),
  cost_usd: z.number().min(0),
}).strip();

export type BudgetUsage = z.infer<typeof BudgetUsageSchema>;

// ---------------------------------------------------------------------------
// SessionBudgetStatusSchema
// Budget status sent to dispatcher — tracks remaining budget.
// ---------------------------------------------------------------------------
export const SessionBudgetStatusSchema = z.object({
  invocations_remaining: z.number().nullable(),
  token_budget_remaining: z.number().nullable(),
  wall_clock_deadline: z.string().nullable(),
}).strip();

export type SessionBudgetStatus = z.infer<typeof SessionBudgetStatusSchema>;

// WorkerConfigSchema — re-exported from infra/workflow-types (see top of file)

// ---------------------------------------------------------------------------
// AvailableContextSchema
// ---------------------------------------------------------------------------
export const ContextEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  summary: z.string(),
});

export type ContextEntry = z.infer<typeof ContextEntrySchema>;

export const AvailableContextSchema = z.object({
  conventions: z.array(ContextEntrySchema).max(20),
  standards: z.array(ContextEntrySchema).max(20),
  learnings: z.array(ContextEntrySchema).max(20),
}).strip();

export type AvailableContext = z.infer<typeof AvailableContextSchema>;

// ---------------------------------------------------------------------------
// LastWorkerResultSchema
// ---------------------------------------------------------------------------
export const LastWorkerResultSchema = z.object({
  step: z.number(),
  status: z.string(),
  output_summary: z.string(),
  artifacts_produced: z.array(z.string()),
  tests_passed: z.boolean().nullable(),
  decisions: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  commands_run: z.array(z.string()).optional(),
  files_to_review: z.array(z.string()).optional(),
}).strip();

export type LastWorkerResult = z.infer<typeof LastWorkerResultSchema>;

// ---------------------------------------------------------------------------
// WorkflowStepBaseSchema
// Base fields shared by PlanStepStepSchema and WorkflowStepSchema.
// ---------------------------------------------------------------------------
export const WorkflowStepBaseSchema = z.object({
  description: z.string(),
  dispatcherHint: z.string().optional(),
  evaluationCriteria: z.string().optional(),
});

export type WorkflowStepBase = z.infer<typeof WorkflowStepBaseSchema>;
