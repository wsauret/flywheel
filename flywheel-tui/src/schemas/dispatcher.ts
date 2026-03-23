import { z } from "zod";
import {
  WorkflowStepBaseSchema,
  LastWorkerResultSchema,
  SessionBudgetStatusSchema,
  AvailableContextSchema,
  ValidationCriteriaSchema,
  WorkerConfigSchema,
} from "./shared";

// REMOVED: full_content — use phases[] only
const PlanPhaseStepSchema = WorkflowStepBaseSchema.strip();

const PlanPhaseSchema = z.object({
  name: z.string(),
  steps: z.array(PlanPhaseStepSchema),
}).strip();

const PlanInputSchema = z.object({
  // REMOVED: full_content — use phases[] only
  phases: z.array(PlanPhaseSchema),
}).strip();

// ---------------------------------------------------------------------------
// WorkflowInfoSchema — current workflow step context for the dispatcher
// ---------------------------------------------------------------------------
export const WorkflowInfoSchema = z.object({
  name: z.string(),
  step_number: z.number(),
  total_steps: z.number(),
  step_description: z.string(),
}).strip();

export type WorkflowInfo = z.infer<typeof WorkflowInfoSchema>;

// ---------------------------------------------------------------------------
// DispatcherConfigSchema — runtime config subset for the dispatcher
// ---------------------------------------------------------------------------
export const DispatcherConfigSchema = z.object({
  max_eval_cycles: z.number(),
  worktree_path: z.string(),
  project_cwd: z.string(),
  worker_model: z.string(),
  dispatcher_model: z.string(),
}).strip();

export type DispatcherConfig = z.infer<typeof DispatcherConfigSchema>;

export const DispatcherInputSchema = z.object({
  plan: PlanInputSchema,
  state: z.object({
    completed_phases: z.array(z.number()),
    current_phase_index: z.number(),
  }).strip(),
  context: z.object({
    files: z.array(z.string()),
  }).strip(),
  plan_truncated: z.boolean().default(false),
  history_truncated: z.boolean().default(false),
  workflow_id: z.string(),
  workflow: WorkflowInfoSchema,
  last_worker_result: LastWorkerResultSchema.nullable(),
  config: DispatcherConfigSchema,
  session_budget: SessionBudgetStatusSchema,
  available_context: AvailableContextSchema,
}).strip();

export type DispatcherInput = z.infer<typeof DispatcherInputSchema>;

// REMOVED: adapted_plan — Decision #7
// REMOVED: top-level parallel — use worker_config.parallel instead
// REMOVED: top-level timeout_minutes — canonical field is worker_config.timeout_minutes
export const DispatcherDecisionSchema = z.object({
  schema_version: z.literal(1),
  phase_index: z.number(),
  step_index: z.number(),
  prompt: z.string(),
  context_files: z.array(z.string()),
  context_to_inline: z.array(z.string()).optional(),
  validation_criteria: ValidationCriteriaSchema,
  reasoning: z.string(),
  warnings: z.array(z.string()),
  worker_config: WorkerConfigSchema,
}).strip();

export type DispatcherDecision = z.infer<typeof DispatcherDecisionSchema>;
