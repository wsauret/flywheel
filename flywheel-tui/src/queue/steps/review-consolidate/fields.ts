import type { HandoffFieldSpec } from "../../shared/handoff-render";

export const REVIEW_CONSOLIDATE_FIELDS: HandoffFieldSpec[] = [
  { key: "summary", description: "100-5000 char summary of consolidated review with incorporated findings", example: '"Consolidated review: 1 P1 fixed, 3 P2 addressed. Review doc written to docs/reviews/..."', required: true },
  { key: "review_file_path", description: "Path to the full review document", example: '"docs/reviews/2026-03-29-auth-review.md"' },
  { key: "finding_counts", description: "Final finding counts after triage", example: '{"p1_critical": 1, "p2_important": 3, "p3_suggestion": 5}' },
  { key: "files_to_review", description: "Files that need attention based on review", example: '["src/auth.ts"]' },
];

export const REVIEW_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of the code review",
    example: '"Reviewed 12 files across 3 modules. Found 1 critical issue..."',
    required: true,
  },
  {
    key: "review_file_path",
    description: "Path to the full review document (use the exact path from Output Requirements)",
    example: '".flywheel/sessions/<session-id>/review.md"',
  },
  {
    key: "finding_counts",
    description: "Count of findings by severity",
    example: '{"p1_critical": 1, "p2_important": 3, "p3_suggestion": 7}',
  },
  {
    key: "p3_findings",
    description: "Low-priority suggestions (P3) with descriptions and suggested fixes",
    example: '[{"description": "Consider caching", "location": "src/api.ts:10", "suggestion": "Add LRU cache"}]',
  },
  {
    key: "files_to_review",
    description: "Files that were reviewed",
    example: '["src/auth.ts", "src/middleware.ts"]',
  },
];
