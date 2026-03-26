// ---------------------------------------------------------------------------
// JSON Plan Schema & Parser (ADR-004 Decision 5)
//
// Validates and parses JSON plan files produced by the plan draft step.
// Replaces the markdown plan parser (plan-parser.ts) for the JSON-native
// plan pipeline.
//
// Three schema variants:
//   PlanJsonSchema       — draft output (clean steps, no review annotations)
//   PlanReviewOutputSchema — review annotated (steps with findings + openQuestions)
//   PlanConsolidationOutput — same as draft (clean after merging findings)
// ---------------------------------------------------------------------------

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

/**
 * Estimated complexity for a plan step.
 * Maps to the same enum used in ProtoStep.
 */
export const EstimatedComplexitySchema = z.enum([
  "trivial",
  "low",
  "medium",
  "high",
  "critical",
]);

export type EstimatedComplexity = z.infer<typeof EstimatedComplexitySchema>;

// ---------------------------------------------------------------------------
// PlanStep — individual step in a JSON plan
// ---------------------------------------------------------------------------

export const PlanStepSchema = z.object({
  /** Short, specific action title. */
  title: z.string().min(1),
  /** Detailed description of what to implement. */
  description: z.string().min(1),
  /** Testable pass/fail criteria (min 1). */
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  /** Files to create or modify. */
  fileReferences: z.array(z.string()).optional(),
  /** Feature grouping for boundary detection. */
  feature: z.string().optional(),
  /** Behavioral contract assertion IDs this step fulfills. */
  fulfills: z.array(z.string()).optional(),
  /** Milestone grouping. */
  milestone: z.string().optional(),
  /** Estimated effort complexity. */
  estimatedComplexity: EstimatedComplexitySchema.optional(),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;

// ---------------------------------------------------------------------------
// BehavioralAssertion — testable behavioral contract entry
// ---------------------------------------------------------------------------

export const BehavioralAssertionSchema = z.object({
  /** Unique ID, format: BC-{AREA}-{NNN}. */
  id: z.string().min(1),
  /** Short description of the behavior. */
  title: z.string().min(1),
  /** Behavioral pass/fail description. */
  description: z.string().min(1),
  /** How to verify (test output, curl command, etc.). */
  evidence: z.string().min(1),
  /** Functional area name (e.g., "Auth", "API"). */
  area: z.string().min(1),
});

export type BehavioralAssertion = z.infer<typeof BehavioralAssertionSchema>;

// ---------------------------------------------------------------------------
// PlanJsonSchema — draft & consolidation output
// ---------------------------------------------------------------------------

export const PlanJsonSchema = z.object({
  /** Ordered plan steps (min 1). */
  steps: z.array(PlanStepSchema).min(1),
  /** Behavioral contract assertions. */
  behavioralContract: z.array(BehavioralAssertionSchema),
  /** Architectural decisions made during planning. */
  decisions: z.array(z.string()),
  /** Identified risks and concerns. */
  risks: z.array(z.string()),
});

export type PlanJson = z.infer<typeof PlanJsonSchema>;

// ---------------------------------------------------------------------------
// Review annotations — added by the review step
// ---------------------------------------------------------------------------

export const ReviewFindingSchema = z.object({
  /** Finding severity: P1 (critical), P2 (important), P3 (minor). */
  severity: z.enum(["P1", "P2", "P3"]),
  /** Description of the finding. */
  description: z.string().min(1),
  /** Which reviewer found it. */
  reviewer: z.string().min(1),
  /** What action is required to address it (optional). */
  actionRequired: z.string().optional(),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const StepReviewSchema = z.object({
  findings: z.array(ReviewFindingSchema),
});

export type StepReview = z.infer<typeof StepReviewSchema>;

// ---------------------------------------------------------------------------
// OpenQuestion — raised during plan review
// ---------------------------------------------------------------------------

export const OpenQuestionSchema = z.object({
  /** The question text. */
  question: z.string().min(1),
  /** Which reviewer raised it. */
  raisedBy: z.string().min(1),
  /** Suggested answer options (optional). */
  options: z.array(z.string()).optional(),
});

export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

// ---------------------------------------------------------------------------
// PlanReviewOutputSchema — annotated plan from review step
// ---------------------------------------------------------------------------

const ReviewAnnotatedStepSchema = PlanStepSchema.extend({
  review: StepReviewSchema.optional(),
});

export const PlanReviewOutputSchema = z.object({
  steps: z.array(ReviewAnnotatedStepSchema).min(1),
  behavioralContract: z.array(BehavioralAssertionSchema),
  decisions: z.array(z.string()),
  risks: z.array(z.string()),
  openQuestions: z.array(OpenQuestionSchema),
});

export type PlanReviewOutput = z.infer<typeof PlanReviewOutputSchema>;

// ---------------------------------------------------------------------------
// Parse result type
// ---------------------------------------------------------------------------

export type ParseJsonPlanResult =
  | { ok: true; plan: PlanJson }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Public API: parseJsonPlan
// ---------------------------------------------------------------------------

/**
 * Parse and validate a JSON plan string.
 *
 * @param content - Raw JSON string content
 * @returns Discriminated union: { ok: true, plan } or { ok: false, error }
 */
export function parseJsonPlan(content: string): ParseJsonPlanResult {
  // Step 1: Parse JSON
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 2: Validate against schema
  const result = PlanJsonSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return { ok: false, error: issues };
  }

  return { ok: true, plan: result.data };
}
