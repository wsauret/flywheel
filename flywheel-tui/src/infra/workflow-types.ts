/**
 * Workflow payload types — canonical home for infra-layer consumption.
 *
 * Zod schemas are the single source of truth (ADR-006). Types are derived
 * via z.infer. Workflow modules re-export these schemas for validation.
 */

import { z } from "zod"

// ---------------------------------------------------------------------------
// Shared sub-schemas (Zod → type)
// ---------------------------------------------------------------------------

export const EvaluationCriteriaSchema = z.object({
  acceptance_criteria: z.array(z.string()),
  required_tests: z.boolean(),
  custom_checks: z.array(z.string()),
  required_outputs: z.array(z.string()),
}).strip()

export type EvaluationCriteria = z.infer<typeof EvaluationCriteriaSchema>

export const ToolScopingSchema = z.object({
  read: z.boolean(),
  bash: z.boolean(),
  write: z.boolean(),
  edit: z.boolean(),
  task: z.boolean().optional(),
}).strip()

export type ToolScoping = z.infer<typeof ToolScopingSchema>

export const ParallelVariantSchema = z.object({
  name: z.string(),
  prompt: z.string(),
})

export type ParallelVariant = z.infer<typeof ParallelVariantSchema>

export const WorkerConfigSchema = z.object({
  model_override: z.string().nullish(),
  timeout_minutes: z.number().optional(),
  retry_on_failure: z.boolean().optional(),
  max_retries: z.number().optional(),
  iteration_budget: z.number().optional(),
  tool_scoping: ToolScopingSchema.optional(),
  parallel: z.boolean().optional(),
  parallel_variants: z.array(ParallelVariantSchema).nullish(),
}).strip()

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>

// ---------------------------------------------------------------------------
// DispatcherDecision — output of the dispatcher agent
// ---------------------------------------------------------------------------

export interface MutationRequest {
  type: "insert_after" | "skip" | "remove";
  target_step_id?: string;
  steps?: Array<{
    type: string;
    title: string;
    description?: string;
    acceptance_criteria?: string[];
  }>;
  reason: string;
}

export interface DispatcherDecision {
  schema_version: 1;
  step_index?: number;
  task_content: string;
  context_files: string[];
  context_to_inline?: string[];
  evaluation_criteria: EvaluationCriteria;
  reasoning?: string;
  warnings?: string[];
  worker_config?: WorkerConfig;
  mutation_requests?: MutationRequest[];
}

// ---------------------------------------------------------------------------
// EvaluatorResult — output of the evaluator agent
// ---------------------------------------------------------------------------

export type EvaluatorIssueSeverity = "blocking" | "non_blocking";
export type EvaluatorIssueCategory =
  | "test_failure"
  | "type_error"
  | "security"
  | "regression"
  | "incomplete"
  | "other";

export interface EvaluatorIssue {
  description: string;
  severity: EvaluatorIssueSeverity;
  category: EvaluatorIssueCategory;
}

export interface EvaluatorResult {
  passed: boolean;
  reasoning: string;
  suggestions?: string[];
  confidence: number;
  feedback: string;
  files_to_review: string[];
  issues: EvaluatorIssue[];
  implementation_feedback?: string;
  script_feedback?: string;
}

// ---------------------------------------------------------------------------
// QuestionInfo / QuestionAnswer — question service payload types
// ---------------------------------------------------------------------------

export interface QuestionOption {
  label: string;
  description: string;
}

export interface OpenQuestion {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  source?: string;
  default?: string;
}

export type QuestionInfo = OpenQuestion & {
  custom?: boolean;
  /**
   * When true, the question renders as a bare text input — no options list,
   * no "Type your own answer" indirection. The user types directly and
   * presses Enter to submit. Used for free-form prompts like "What do
   * you want to build?".
   */
  textOnly?: boolean;
};

/** Per-question answer: array of selected option labels or custom text */
export type QuestionAnswer = string[];
