import type { HandoffFieldSpec } from "../../shared/handoff-render";

export const SHIP_COMMIT_FIELDS: HandoffFieldSpec[] = [
  { key: "summary", description: "100-5000 char summary of staged changes, commit, and PR", example: '"Staged 12 files, committed with message feat: add auth middleware, opened PR #42..."', required: true },
  { key: "artifacts", description: "Files staged, branch name, commit hash, PR URL", example: '{"files_modified": ["src/auth.ts"], "commands_run": [{"command": "git push -u origin feat/auth", "exitCode": 0, "observation": "PR opened"}]}' },
  { key: "decisions", description: "Decisions about commit scope and PR description", example: '["Split into single commit for clean history"]' },
];

export const SHIP_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of what was shipped (commit, PR, learnings)",
    example: '"Committed auth feature, opened PR #42, extracted 2 learnings..."',
    required: true,
  },
  {
    key: "compound_docs",
    description: "Learnings extracted and saved as compound solution documents",
    example: '[{"title": "Fix flaky test", "type": "bug-fix", "tags": ["testing"], "problem": "Timing issue", "solution": "Added retry"}]',
  },
];
