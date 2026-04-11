// ---------------------------------------------------------------------------
// Shared handoff data parser
// ---------------------------------------------------------------------------
//
// Extracts common fields from a raw `Record<string, unknown>` handoff.
// Used by both the step-dispatcher (LastWorkerResult) and the evaluator
// (EvaluatorInput handoff) to avoid duplicating extraction logic.
// ---------------------------------------------------------------------------

/** Parsed handoff — the shared superset of fields both consumers need. */
export interface ParsedHandoff {
  summary: string;
  filesCreated: string[];
  filesModified: string[];
  commandsRun: unknown[];
  testsPassed: boolean | null;
  testOutputSummary: string | undefined;
  decisions: string[];
  warnings: string[];
  filesToReview: string[];
}

/** Type guard: value is a non-null string. */
function isString(v: unknown): v is string {
  return typeof v === "string";
}

/**
 * Parse common fields from a raw handoff record.
 * Tolerant of missing/malformed data — returns safe defaults.
 */
export function parseRawHandoff(raw: Record<string, unknown>): ParsedHandoff {
  const summary = typeof raw.summary === "string"
    ? raw.summary
    : JSON.stringify(raw).slice(0, 500);

  // Nested artifacts object
  let filesCreated: string[] = [];
  let filesModified: string[] = [];
  let commandsRun: unknown[] = [];
  const artObj = raw.artifacts;
  if (artObj && typeof artObj === "object") {
    const a = artObj as Record<string, unknown>;
    filesCreated = Array.isArray(a.files_created) ? a.files_created.filter(isString) : [];
    filesModified = Array.isArray(a.files_modified) ? a.files_modified.filter(isString) : [];
    commandsRun = Array.isArray(a.commands_run) ? a.commands_run : [];
  }

  // Verification
  const verification = raw.verification as Record<string, unknown> | undefined;
  const testsPassed = verification?.tests_passed != null
    ? Boolean(verification.tests_passed)
    : null;
  const testOutputSummary = typeof verification?.test_output_summary === "string"
    ? verification.test_output_summary
    : undefined;

  // Array fields
  const decisions = Array.isArray(raw.decisions) ? raw.decisions.filter(isString) : [];
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter(isString) : [];
  const filesToReview = Array.isArray(raw.files_to_review) ? raw.files_to_review.filter(isString) : [];

  return {
    summary,
    filesCreated,
    filesModified,
    commandsRun,
    testsPassed,
    testOutputSummary,
    decisions,
    warnings,
    filesToReview,
  };
}
