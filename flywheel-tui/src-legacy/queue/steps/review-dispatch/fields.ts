import type { HandoffFieldSpec } from "../../shared/handoff-render";

export const REVIEW_DISPATCH_FIELDS: HandoffFieldSpec[] = [
  { key: "summary", description: "100-5000 char summary of review dispatch and per-reviewer findings", example: '"Dispatched 5 review agents. Found 1 P1, 3 P2, 7 P3 findings across 12 files..."', required: true },
  { key: "finding_counts", description: "Count of findings by severity", example: '{"p1_critical": 1, "p2_important": 3, "p3_suggestion": 7}' },
  { key: "p3_findings", description: "Low-priority suggestions for optional triage", example: '[{"description": "Consider caching", "location": "src/api.ts:10", "suggestion": "Add LRU cache"}]' },
  { key: "files_to_review", description: "Files that were reviewed", example: '["src/auth.ts", "src/middleware.ts"]' },
];
