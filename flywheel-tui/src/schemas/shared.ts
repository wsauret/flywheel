import { z } from "zod";

// ---------------------------------------------------------------------------
// ValidationCriteriaSchema
// ---------------------------------------------------------------------------
export const ValidationCriteriaSchema = z.object({
  acceptance_criteria: z.array(z.string()),
  required_tests: z.boolean(),
  custom_checks: z.array(z.string()),
  required_outputs: z.array(z.string()),
}).strip();

export type ValidationCriteria = z.infer<typeof ValidationCriteriaSchema>;

// ---------------------------------------------------------------------------
// ToolScopingSchema
// ---------------------------------------------------------------------------
export const ToolScopingSchema = z.object({
  read: z.boolean(),
  bash: z.boolean(),
  write: z.boolean(),
  edit: z.boolean(),
}).strip();

export type ToolScoping = z.infer<typeof ToolScopingSchema>;

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

// ---------------------------------------------------------------------------
// WorkerConfigSchema
// ---------------------------------------------------------------------------
const ParallelVariantSchema = z.object({
  name: z.string(),
  prompt: z.string(),
});

export const WorkerConfigSchema = z.object({
  model_override: z.string().nullable().optional(),
  timeout_minutes: z.number().optional(),
  retry_on_failure: z.boolean().optional(),
  max_retries: z.number().optional(),
  iteration_budget: z.number().optional(),
  tool_scoping: ToolScopingSchema.optional(),
  parallel: z.boolean().optional(),
  parallel_variants: z.array(ParallelVariantSchema).nullable().optional(),
}).strip();

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

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
  duration_seconds: z.number(),
  decisions: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  commands_run: z.array(z.string()).optional(),
  files_to_review: z.array(z.string()).optional(),
}).strip();

export type LastWorkerResult = z.infer<typeof LastWorkerResultSchema>;

// ---------------------------------------------------------------------------
// WorkflowStepBaseSchema
// Base fields shared by PlanPhaseStepSchema and WorkflowStepSchema.
// ---------------------------------------------------------------------------
export const WorkflowStepBaseSchema = z.object({
  description: z.string(),
  dispatcherHint: z.string().optional(),
  validationCriteria: z.string().optional(),
});

export type WorkflowStepBase = z.infer<typeof WorkflowStepBaseSchema>;
