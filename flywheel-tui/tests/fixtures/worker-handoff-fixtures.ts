// Shared WorkerHandoff fixtures — used by tests/schemas/handoff.test.ts and
// tests/handoff-types/work-handoff.test.ts so the registered type and the
// underlying schema are exercised against identical inputs.

export const VALID_SUMMARY =
  "Implemented feature X with full test coverage. All 42 tests pass. Typecheck clean.";

export const VALID_FULL_HANDOFF = {
  summary: VALID_SUMMARY,
  artifacts: {
    files_created: ["src/new.ts"],
    files_modified: ["src/existing.ts"],
    commands_run: ["bun test"],
  },
  decisions: ["Used approach A over B"],
  warnings: ["Large file detected"],
  verification: {
    tests_passed: true,
    test_output_summary: "12/12 pass with coverage report showing 95% line coverage.",
  },
  files_to_review: ["src/new.ts"],
  plan_file_path: "docs/plans/plan.md",
  review_file_path: "docs/reviews/review.md",
  finding_counts: { p1_critical: 0, p2_important: 1, p3_suggestion: 3 },
  p3_findings: [
    { description: "Consider caching", location: "src/api.ts:10", suggestion: "Add LRU cache" },
  ],
};

export const VALID_MINIMAL_HANDOFF = {
  summary: VALID_SUMMARY,
};
