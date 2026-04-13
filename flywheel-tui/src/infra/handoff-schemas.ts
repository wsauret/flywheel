import { z } from "zod";

// Content quality helpers

function countSentences(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim().replace(/[.!?]+\s*$/, "");
  if (!normalized) return 0;
  return normalized.split(/[.!?]+\s+/).filter(Boolean).length;
}

// Sub-schemas (all .strict() — LLM typos should cause retries)
// Exported for direct test validation (tests/schemas/handoff.test.ts).
// Inferred types (Artifacts, Verification, etc.) are file-private — no external consumers.

const CommandRunEntrySchema = z.union([
  z.string(),
  z.object({
    command: z.string(),
    exitCode: z.number().optional(),
    observation: z.string().optional(),
  }).passthrough(),
]);

export const ArtifactsSchema = z.object({
  files_created: z.array(z.string()).optional(),
  files_modified: z.array(z.string()).optional(),
  commands_run: z.array(CommandRunEntrySchema).optional(),
}).strict();

type Artifacts = z.infer<typeof ArtifactsSchema>;

export const VerificationSchema = z.object({
  tests_passed: z.boolean().nullable(),
  test_output_summary: z.string().optional(),
}).strict();

type Verification = z.infer<typeof VerificationSchema>;

export const OpenQuestionSchema = z.object({
  question: z.string(),
  options: z.array(z.string()),
  header: z.string().optional(),
}).strict();

type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

export const FindingCountsSchema = z.object({
  p1_critical: z.number(),
  p2_important: z.number(),
  p3_suggestion: z.number(),
}).strict();

type FindingCounts = z.infer<typeof FindingCountsSchema>;

export const P3FindingSchema = z.object({
  description: z.string(),
  location: z.string().optional(),
  suggestion: z.string(),
}).strict();

type P3Finding = z.infer<typeof P3FindingSchema>;

export const CompoundDocSchema = z.object({
  title: z.string(),
  type: z.string(),
  tags: z.array(z.string()),
  problem: z.string(),
  solution: z.string(),
  context: z.string().optional(),
}).strict();

type CompoundDoc = z.infer<typeof CompoundDocSchema>;

// Skill feedback sub-schemas

export const SkillDeviationSchema = z.object({
  step: z.string().describe("Which skill step you deviated from"),
  whatIDidInstead: z.string().describe("What you actually did"),
  why: z.string().describe(
    "Why you deviated (blocked, better approach, unclear instruction, etc.)",
  ),
}).strict();

type SkillDeviation = z.infer<typeof SkillDeviationSchema>;

export const SkillFeedbackSchema = z.object({
  followedProcedure: z.boolean()
    .describe("Did you follow the skill procedure as written?"),
  deviations: z.array(SkillDeviationSchema)
    .describe("Where and why you deviated from the skill procedure. Empty if followedProcedure is true."),
  suggestedChanges: z.array(z.string()).optional()
    .describe("Suggestions for improving the skill (optional)"),
}).strict();

// SubprocessHandoffSchema

const SUMMARY_MIN_LENGTH = 20;
const SUMMARY_MAX_LENGTH = 5000;
const SUMMARY_MAX_SENTENCES = 10;
const TEST_OUTPUT_MIN_LENGTH = 10;

export const SubprocessHandoffBaseSchema = z.object({
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
    .describe("Feedback on the skill procedure. Fill this out to help improve future subprocesses."),
  verification_script_path: z.string().optional(),
  iteration_number: z.number().optional(),
  needs_plan: z.boolean().optional(),
  hypothesis: z.string().optional(),
  document_path: z.string().optional(),
}).passthrough();

export const SubprocessHandoffSchema = SubprocessHandoffBaseSchema.superRefine((data, ctx) => {
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

export type SubprocessHandoff = z.infer<typeof SubprocessHandoffSchema>;
