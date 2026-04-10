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
// DispatcherDecision — output of the dispatcher agent (Zod → type)
// ---------------------------------------------------------------------------

export const MutationRequestSchema = z.object({
  type: z.enum(["insert_after", "skip", "remove"]),
  target_step_id: z.string().optional(),
  steps: z.array(
    z.object({
      type: z.string(),
      title: z.string(),
      description: z.string().optional(),
      acceptance_criteria: z.array(z.string()).optional(),
    })
  ).optional(),
  reason: z.string(),
}).strict()

export type MutationRequest = z.infer<typeof MutationRequestSchema>

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
  mutation_requests: z.array(MutationRequestSchema).optional(),
}).strip()

export type DispatcherDecision = z.infer<typeof DispatcherDecisionSchema>

// ---------------------------------------------------------------------------
// EvaluatorResult — output of the evaluator agent (Zod → type)
// ---------------------------------------------------------------------------

export const EvaluatorIssueSchema = z.object({
  description: z.string(),
  severity: z.enum(["blocking", "non_blocking"]),
  category: z.enum(["test_failure", "type_error", "security", "regression", "incomplete", "other"]),
}).strip()

export type EvaluatorIssue = z.infer<typeof EvaluatorIssueSchema>
export type EvaluatorIssueSeverity = EvaluatorIssue["severity"]
export type EvaluatorIssueCategory = EvaluatorIssue["category"]

export const EvaluatorResultSchema = z.object({
  passed: z.boolean(),
  reasoning: z.string(),
  suggestions: z.array(z.string()).optional(),
  confidence: z.number(),
  feedback: z.string(),
  files_to_review: z.array(z.string()),
  issues: z.array(EvaluatorIssueSchema),
  implementation_feedback: z.string().optional(),
  script_feedback: z.string().optional(),
}).strip()

export type EvaluatorResult = z.infer<typeof EvaluatorResultSchema>

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
