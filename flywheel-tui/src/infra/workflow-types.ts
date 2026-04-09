/**
 * Workflow payload types — canonical home for infra-layer consumption.
 *
 * These are pure TypeScript types (no Zod dependency). The Zod schemas
 * that validate these shapes live in their respective workflow modules.
 */

// ---------------------------------------------------------------------------
// DispatcherDecision — output of the dispatcher agent
// ---------------------------------------------------------------------------

export interface EvaluationCriteria {
  acceptance_criteria: string[];
  required_tests: boolean;
  custom_checks: string[];
  required_outputs: string[];
}

export interface ToolScoping {
  read: boolean;
  bash: boolean;
  write: boolean;
  edit: boolean;
  task?: boolean;
}

export interface ParallelVariant {
  name: string;
  prompt: string;
}

export interface WorkerConfig {
  model_override?: string | null;
  timeout_minutes?: number;
  retry_on_failure?: boolean;
  max_retries?: number;
  iteration_budget?: number;
  tool_scoping?: ToolScoping;
  parallel?: boolean;
  parallel_variants?: ParallelVariant[] | null;
}

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
