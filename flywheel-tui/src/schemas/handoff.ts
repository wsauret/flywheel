import { z } from "zod";
import { ValidationCriteriaSchema, WorkerConfigSchema } from "../schemas/shared";

// ---------------------------------------------------------------------------
// Content quality helpers
// ---------------------------------------------------------------------------

/**
 * Count sentences in text. Normalizes whitespace, strips trailing punctuation,
 * then splits on sentence-ending punctuation followed by whitespace.
 * Adapted from multi-agent mission system patterns.
 */
export function countSentences(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim().replace(/[.!?]+\s*$/, "");
  if (!normalized) return 0;
  return normalized.split(/[.!?]+\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Sub-schemas (all .strict() — LLM typos should cause retries)
// Top-level handoff schemas use .passthrough() to tolerate extra keys from
// LLMs. Sub-schemas keep .strict() since they define small nested structures
// where extra keys are more likely to indicate a malformed response.
// ---------------------------------------------------------------------------

export const ArtifactsSchema = z.object({
  files_created: z.array(z.string()).optional(),
  files_modified: z.array(z.string()).optional(),
  commands_run: z.array(z.string()).optional(),
}).strict();

export type Artifacts = z.infer<typeof ArtifactsSchema>;

export const VerificationSchema = z.object({
  tests_passed: z.boolean().nullable(),
  test_output_summary: z.string().optional(),
}).strict();

export type Verification = z.infer<typeof VerificationSchema>;

export const OpenQuestionSchema = z.object({
  question: z.string(),
  options: z.array(z.string()),
  header: z.string().optional(),
}).strict();

export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

export const FindingCountsSchema = z.object({
  p1_critical: z.number(),
  p2_important: z.number(),
  p3_suggestion: z.number(),
}).strict();

export type FindingCounts = z.infer<typeof FindingCountsSchema>;

export const P3FindingSchema = z.object({
  description: z.string(),
  location: z.string().optional(),
  suggestion: z.string(),
}).strict();

export type P3Finding = z.infer<typeof P3FindingSchema>;

export const CompoundDocSchema = z.object({
  title: z.string(),
  type: z.string(),
  tags: z.array(z.string()),
  problem: z.string(),
  solution: z.string(),
  context: z.string().optional(),
}).strict();

export type CompoundDoc = z.infer<typeof CompoundDocSchema>;

// ---------------------------------------------------------------------------
// Skill feedback sub-schemas
// ---------------------------------------------------------------------------

export const SkillDeviationSchema = z.object({
  step: z.string().describe("Which skill step you deviated from"),
  whatIDidInstead: z.string().describe("What you actually did"),
  why: z.string().describe(
    "Why you deviated (blocked, better approach, unclear instruction, etc.)",
  ),
}).strict();

export type SkillDeviation = z.infer<typeof SkillDeviationSchema>;

export const SkillFeedbackSchema = z.object({
  followedProcedure: z.boolean()
    .describe("Did you follow the skill procedure as written?"),
  deviations: z.array(SkillDeviationSchema)
    .describe("Where and why you deviated from the skill procedure. Empty if followedProcedure is true."),
  suggestedChanges: z.array(z.string()).optional()
    .describe("Suggestions for improving the skill (optional)"),
}).strict();

export type SkillFeedback = z.infer<typeof SkillFeedbackSchema>;

// ---------------------------------------------------------------------------
// WorkerHandoffSchema
// Per-workflow fields, all optional except summary.
// Content quality enforcement for summary fields.
// ---------------------------------------------------------------------------

const SUMMARY_MIN_LENGTH = 20;
const SUMMARY_MAX_LENGTH = 5000;
const SUMMARY_MAX_SENTENCES = 10;
const TEST_OUTPUT_MIN_LENGTH = 10;

/**
 * Base object schema for WorkerHandoff without cross-field refinements.
 * Exported so consumers can use .pick() / .omit() for projections
 * (e.g., EvaluatorHandoffDataSchema). The full WorkerHandoffSchema
 * adds superRefine cross-field checks on top.
 */
export const WorkerHandoffBaseSchema = z.object({
  summary: z.string()
    .min(SUMMARY_MIN_LENGTH, {
      message: `summary must be at least ${SUMMARY_MIN_LENGTH} characters. Provide a more detailed summary describing what was accomplished.`,
    })
    .max(SUMMARY_MAX_LENGTH, {
      message: `summary must be at most ${SUMMARY_MAX_LENGTH} characters. Shorten the summary to be more concise.`,
    })
    .refine(
      (s) => !s.includes("\n") && !s.includes("\r"),
      {
        message: "summary must not contain newline characters (\\n or \\r\\n). Remove all line breaks and write the summary as a single paragraph.",
      },
    )
    .refine(
      (s) => {
        const count = countSentences(s);
        return count >= 1 && count <= SUMMARY_MAX_SENTENCES;
      },
      (s) => {
        const count = countSentences(s);
        return {
          message: `summary has ${count} sentence(s) but must contain between 1 and ${SUMMARY_MAX_SENTENCES} sentences. Adjust the summary to have 1–${SUMMARY_MAX_SENTENCES} sentences.`,
        };
      },
    ),
  artifacts: ArtifactsSchema.optional(),
  decisions: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  verification: VerificationSchema.optional(),
  files_to_review: z.array(z.string()).optional(),
  plan_file_path: z.string().optional(),
  open_questions: z.array(OpenQuestionSchema).optional(),
  review_file_path: z.string().optional(),
  finding_counts: FindingCountsSchema.optional(),
  p3_findings: z.array(P3FindingSchema).optional(),
  compound_docs: z.array(CompoundDocSchema).optional(),
  skillFeedback: SkillFeedbackSchema.optional()
    .describe("Feedback on the skill procedure. Fill this out to help improve future workers."),
  /** Path to the verification script written by the sprint worker. */
  verification_script_path: z.string().optional(),
  /** Current sprint iteration number. */
  iteration_number: z.number().optional(),
  /** Worker signals that the task requires full planning (sprint escalation). */
  needs_plan: z.boolean().optional(),
}).passthrough();

/**
 * Full WorkerHandoffSchema with cross-field quality refinements.
 * This is the schema used for validation at handoff time.
 */
export const WorkerHandoffSchema = WorkerHandoffBaseSchema.superRefine((data, ctx) => {
  // VAL-QUALITY-002: When tests_passed is true, test_output_summary must be
  // present and at least TEST_OUTPUT_MIN_LENGTH characters.
  if (data.verification?.tests_passed === true) {
    const summary = data.verification.test_output_summary;
    if (!summary || summary.length < TEST_OUTPUT_MIN_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verification", "test_output_summary"],
        message: `test_output_summary must be at least ${TEST_OUTPUT_MIN_LENGTH} characters when tests_passed is true. Describe what tests passed and their output.`,
      });
    }
  }
});

export type WorkerHandoff = z.infer<typeof WorkerHandoffSchema>;

// ---------------------------------------------------------------------------
// Evaluator issue sub-schemas
// Structured evaluator issue tracking
// ---------------------------------------------------------------------------

export const EvaluatorIssueSeverityEnum = z.enum(["blocking", "non_blocking"]);
export type EvaluatorIssueSeverity = z.infer<typeof EvaluatorIssueSeverityEnum>;

export const EvaluatorIssueCategoryEnum = z.enum([
  "test_failure",
  "type_error",
  "security",
  "regression",
  "incomplete",
  "other",
]);
export type EvaluatorIssueCategory = z.infer<typeof EvaluatorIssueCategoryEnum>;

export const EvaluatorIssueSchema = z.object({
  description: z.string().min(1, {
    message: "Issue description must not be empty.",
  }),
  severity: EvaluatorIssueSeverityEnum,
  category: EvaluatorIssueCategoryEnum,
}).strict();

export type EvaluatorIssue = z.infer<typeof EvaluatorIssueSchema>;

// ---------------------------------------------------------------------------
// EvaluatorVerdictSchema (fixed fields + structured issues)
// ---------------------------------------------------------------------------

export const EvaluatorVerdictSchema = z.object({
  passed: z.boolean(),
  reasoning: z.string(),
  suggestions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  feedback: z.string(),
  files_to_review: z.array(z.string()),
  /** Structured issues extracted from worker output. Defaults to empty array for backward compat. */
  issues: z.array(EvaluatorIssueSchema).default([]),
  /** Sprint dual-channel feedback: specific feedback on the implementation. */
  implementation_feedback: z.string().optional(),
  /** Sprint dual-channel feedback: specific feedback on the verification script. */
  script_feedback: z.string().optional(),
}).passthrough();

export type EvaluatorVerdict = z.infer<typeof EvaluatorVerdictSchema>;

// ---------------------------------------------------------------------------
// DispatcherDecisionHandoffSchema
// ---------------------------------------------------------------------------

export const DispatcherDecisionHandoffSchema = z.object({
  schema_version: z.literal(1),
  step_index: z.number(),
  task_content: z.string(),
  evaluation_criteria: ValidationCriteriaSchema.optional(),
  context_files: z.array(z.string()),
  context_to_inline: z.array(z.string()).optional(),
  session_name: z.string().optional(),
  reasoning: z.string().optional(),
  worker_config: WorkerConfigSchema.optional(),
}).passthrough();

export type DispatcherDecisionHandoff = z.infer<typeof DispatcherDecisionHandoffSchema>;
