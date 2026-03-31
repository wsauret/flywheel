import type { HandoffFieldSpec } from "../../shared/handoff-render";

export const RESEARCH_FIELDS: HandoffFieldSpec[] = [
  { key: "summary", description: "100-5000 char summary of research findings covering locate, analyze, and persist phases", example: '"Researched authentication patterns in the codebase. Located 12 relevant files across 3 modules..."', required: true },
  { key: "document_path", description: "Path to the persisted research document", example: '"docs/research/2026-03-29-auth-patterns.md"' },
  { key: "artifacts", description: "Files created during research (research doc, context files)", example: '{"files_created": ["docs/research/2026-03-29-auth-patterns.md"]}' },
  { key: "decisions", description: "Key decisions about research scope and findings", example: '["Focused on middleware-based auth patterns as dominant pattern"]' },
  { key: "files_to_review", description: "Key files discovered during research", example: '["src/middleware/auth.ts", "src/services/jwt.ts"]' },
];
