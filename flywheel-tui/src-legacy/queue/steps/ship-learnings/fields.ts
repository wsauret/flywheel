import type { HandoffFieldSpec } from "../../shared/handoff-render";

export const SHIP_LEARNINGS_FIELDS: HandoffFieldSpec[] = [
  { key: "summary", description: "100-5000 char summary of learnings extracted", example: '"Extracted 2 compound solution documents covering the auth middleware pattern..."', required: true },
  { key: "compound_docs", description: "Learnings extracted and saved as compound solution documents", example: '[{"title": "Auth middleware pattern", "type": "pattern", "tags": ["auth"], "problem": "Need reusable auth", "solution": "Middleware chain"}]' },
  { key: "artifacts", description: "Compound doc files created", example: '{"files_created": ["docs/solutions/auth-middleware-pattern.md"]}' },
];
