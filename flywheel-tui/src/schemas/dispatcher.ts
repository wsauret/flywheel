import { z } from "zod";
import {
  WorkflowStepBaseSchema,
  LastWorkerResultSchema,
  SessionBudgetStatusSchema,
  AvailableContextSchema,
  EvaluationCriteriaSchema,
  WorkerConfigSchema,
} from "./shared";
import { StepContextSchema } from "../controller/step-context";

// ---------------------------------------------------------------------------
// PlanInputSchema — step-based plan representation for the dispatcher
// ---------------------------------------------------------------------------

const PlanStepInputSchema = z.object({
  /** Step title. */
  title: z.string(),
  /** Step description or first step detail. */
  description: z.string(),
  /** Testable acceptance criteria (JSON plans). */
  acceptanceCriteria: z.array(z.string()).optional(),
  /** Files to create or modify. */
  fileReferences: z.array(z.string()).optional(),
  /** Feature grouping. */
  feature: z.string().optional(),
  /** Behavioral contract assertion IDs. */
  fulfills: z.array(z.string()).optional(),
}).strip();

export type PlanStepInput = z.infer<typeof PlanStepInputSchema>;

const PlanInputSchema = z.object({
  /** Plan steps (replaces steps). */
  steps: z.array(PlanStepInputSchema),
}).strip();

export type PlanInput = z.infer<typeof PlanInputSchema>;

// Legacy step-based schemas have been deleted — only step-based PlanInputSchema remains.

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
    completed_steps: z.array(z.number()).optional(),
    current_step_index: z.number().optional(),
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
  /** Cumulative context from completed steps. Optional for backward compat. */
  step_context: StepContextSchema.optional(),
  /** Mutation budget — remaining capacity for queue mutations. */
  mutation_budget: z.object({
    max_queue_length: z.number(),
    current_queue_length: z.number(),
    remaining_queue_capacity: z.number(),
    mutations_used_this_step: z.number(),
    mutations_remaining_this_step: z.number(),
    total_session_inserts: z.number(),
    session_inserts_remaining: z.number(),
    session_objective: z.string(),
  }).strip().optional(),
}).strip();

export type DispatcherInput = z.infer<typeof DispatcherInputSchema>;

// REMOVED: adapted_plan — Decision #7
// REMOVED: top-level parallel — use worker_config.parallel instead
// REMOVED: top-level timeout_minutes — canonical field is worker_config.timeout_minutes
export const DispatcherDecisionSchema = z.object({
  schema_version: z.literal(1),
  step_index: z.number().optional(),
  task_content: z.string(),
  context_files: z.array(z.string()),
  context_to_inline: z.array(z.string()).optional(),
  evaluation_criteria: EvaluationCriteriaSchema,
  reasoning: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  worker_config: WorkerConfigSchema.optional(),
  /** Short session name (2-5 words) summarizing the task. Generated on the first dispatcher call. */
  session_name: z.string().optional(),
}).strip();

export type DispatcherDecision = z.infer<typeof DispatcherDecisionSchema>;
