import { z } from "zod";
import { WorkerConfigSchema } from "../schemas/shared";

// ---------------------------------------------------------------------------
// Sub-schemas (all .strict() — LLM typos should cause retries)
// ---------------------------------------------------------------------------

export const ArtifactsSchema = z.object({
  files_created: z.array(z.string()),
  files_modified: z.array(z.string()),
  commands_run: z.array(z.string()),
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
// WorkerHandoffSchema
// Per-workflow fields, all optional except summary.
// ---------------------------------------------------------------------------

export const WorkerHandoffSchema = z.object({
  summary: z.string().min(100).max(5000),
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
}).strict();

export type WorkerHandoff = z.infer<typeof WorkerHandoffSchema>;

// ---------------------------------------------------------------------------
// EvaluatorVerdictSchema (fixed fields)
// ---------------------------------------------------------------------------

export const EvaluatorVerdictSchema = z.object({
  passed: z.boolean(),
  reasoning: z.string(),
  suggestions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  feedback: z.string(),
  files_to_review: z.array(z.string()),
}).strict();

export type EvaluatorVerdict = z.infer<typeof EvaluatorVerdictSchema>;

// ---------------------------------------------------------------------------
// DispatcherDecisionHandoffSchema
// ---------------------------------------------------------------------------

export const DispatcherDecisionHandoffSchema = z.object({
  schema_version: z.literal(1),
  phase_index: z.number(),
  task_content: z.string(),
  validation_criteria: z.string().optional(),
  context_files: z.array(z.string()),
  session_name: z.string().optional(),
  reasoning: z.string().optional(),
  worker_config: WorkerConfigSchema.optional(),
}).strict();

export type DispatcherDecisionHandoff = z.infer<typeof DispatcherDecisionHandoffSchema>;
