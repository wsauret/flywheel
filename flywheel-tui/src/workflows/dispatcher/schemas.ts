import { z } from "zod";
import {
  LastWorkerResultSchema,
  SessionBudgetStatusSchema,
  AvailableContextSchema,
} from "../schemas.js";
import { EvaluationCriteriaSchema, MutationRequestSchema, DispatcherDecisionSchema, WorkerConfigSchema, type DispatcherDecision } from "../../infra/workflow-types.js";
import { StepContextSchema } from "../queue/step-context.js";

// PlanInputSchema — step-based plan representation for the dispatcher

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
}).strip();

const PlanInputSchema = z.object({
  /** Plan steps (replaces steps). */
  steps: z.array(PlanStepInputSchema),
}).strip();

const WorkflowInfoSchema = z.object({
  name: z.string(),
  step_number: z.number(),
  total_steps: z.number(),
  step_description: z.string(),
}).strip();

const DispatcherConfigSchema = z.object({
  max_eval_cycles: z.number(),
  worktree_path: z.string(),
  project_cwd: z.string(),
  worker_model: z.string(),
  dispatcher_model: z.string(),
}).strip();

const DispatcherInputSchema = z.object({
  plan: PlanInputSchema,
  state: z.object({
    completed_steps: z.array(z.number()).optional(),
    current_step_index: z.number().optional(),
  }).strip(),
  workflow_id: z.string(),
  workflow: WorkflowInfoSchema,
  last_worker_result: LastWorkerResultSchema.nullable(),
  config: DispatcherConfigSchema,
  session_budget: SessionBudgetStatusSchema,
  available_context: AvailableContextSchema,
  step_context: StepContextSchema,
  /** Mutation budget — remaining capacity for queue mutations. */
  mutation_budget: z.object({
    max_queue_length: z.number(),
    current_queue_length: z.number(),
    remaining_queue_capacity: z.number(),
    mutations_used_this_step: z.number(),
    mutations_remaining_this_step: z.number(),
    total_session_inserts: z.number(),
    session_inserts_remaining: z.number(),
  }).strip().optional(),
}).strip();

export type DispatcherInput = z.infer<typeof DispatcherInputSchema>;

// DispatcherDecisionHandoffSchema — handoff file written by the dispatcher engine.
// Derived from DispatcherDecisionSchema: required step_index, optional evaluation_criteria,
// no warnings field, passthrough tolerance for extra LLM output.

export const DispatcherDecisionHandoffSchema = DispatcherDecisionSchema
  .omit({ warnings: true })
  .extend({
    step_index: z.number(),
    evaluation_criteria: EvaluationCriteriaSchema.optional(),
  })
  .passthrough();

export type DispatcherDecisionHandoff = z.infer<typeof DispatcherDecisionHandoffSchema>;

/** Convert a handoff file into the full DispatcherDecision, filling defaults
 *  that the Zod schema makes optional for LLM tolerance. */
export function handoffToDecision(handoff: DispatcherDecisionHandoff): DispatcherDecision {
  return {
    ...handoff,
    evaluation_criteria: handoff.evaluation_criteria
      ?? { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
    worker_config: handoff.worker_config ? {
      ...handoff.worker_config,
      tool_scoping: handoff.worker_config.tool_scoping
        ? { ...handoff.worker_config.tool_scoping, task: handoff.worker_config.tool_scoping.task ?? false }
        : undefined,
    } : undefined,
  };
}
