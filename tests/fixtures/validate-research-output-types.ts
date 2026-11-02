/**
 * validate-research-output-types.ts — Types and constants for research output validation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResearchVariant = "plan" | "standalone";

export interface CriterionResult {
  criterion: string;
  passed: boolean;
  details: string;
  violations?: Array<{ line: number; text: string }>;
}

export interface ValidationResult {
  file: string;
  variant: ResearchVariant;
  passed: boolean;
  criteria: CriterionResult[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PLAN_REQUIRED_SECTIONS = [
  "Codebase Map",
  "Relevant Code",
  "Patterns to Follow",
  "Constraints",
  "Open Questions",
];

export const STANDALONE_REQUIRED_SECTIONS = [
  "Research Question",
  "Summary",
  "Detailed Findings",
  "Code References",
  "Patterns Identified",
  "Open Questions",
];

export const MIN_FILE_LINE_REFS_PLAN = 3;
export const MIN_FILE_LINE_REFS_STANDALONE = 5;
export const MAX_CODE_BLOCK_LINES = 15;

// Prescriptive language patterns (case-insensitive)
export const PRESCRIPTIVE_PATTERNS = [
  /\bshould\b/i,
  /\bcould improve\b/i,
  /\bconsider\b/i,
  /\brecommend\b/i,
  /\bsuggest\b/i,
  /\bit would be better\b/i,
  /\bideally\b/i,
];

// Evaluative language patterns (case-insensitive)
export const EVALUATIVE_PATTERNS = [
  /\bbad\b/i,
  /\bpoorly\b/i,
  /\bmessy\b/i,
  /\bhacky\b/i,
  /\bwell-designed\b/i,
  /\bproblematic\b/i,
  /\banti-pattern\b/i,
  /\bcode smell\b/i,
  /\btechnical debt\b/i,
];

// Debugging language patterns (case-insensitive)
export const DEBUGGING_PATTERNS = [
  /\broot cause\b/i,
  /\bthe bug\b/i,
  /\bthe fix\b/i,
  /\bstack trace\b/i,
  /\bfails when\b/i,
  /\bbreaks because\b/i,
  /\bthe error occurs\b/i,
];

// Plan contamination section titles
export const PLAN_CONTAMINATION_SECTIONS = [
  "Implementation Checklist",
  "Phases",
  "Action Items",
  "Next Steps",
  "Root Cause",
  "Fix",
  "Reproduction Steps",
];
