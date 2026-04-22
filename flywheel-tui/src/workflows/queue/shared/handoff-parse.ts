interface ParsedHandoff {
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

function isString(v: unknown): v is string {
  return typeof v === "string";
}

export function parseRawHandoff(raw: Record<string, unknown>): ParsedHandoff {
  const summary = typeof raw.summary === "string"
    ? raw.summary
    : JSON.stringify(raw).slice(0, 500);

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

  const verification = raw.verification as Record<string, unknown> | undefined;
  const testsPassed = verification?.tests_passed != null
    ? Boolean(verification.tests_passed)
    : null;
  const testOutputSummary = typeof verification?.test_output_summary === "string"
    ? verification.test_output_summary
    : undefined;

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
