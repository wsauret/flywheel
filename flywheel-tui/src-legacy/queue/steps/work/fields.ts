import type { HandoffFieldSpec } from "../../shared/handoff-render";

export const WORK_STEP_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of what was done, decisions made, and current state",
    example: '"Implemented the authentication middleware with JWT validation..."',
    required: true,
  },
  {
    key: "artifacts",
    description: "Files created, modified, and commands run. IMPORTANT: commands_run entries will be RE-EXECUTED by a verification agent — only list commands you actually ran, with accurate exit codes. Fabricated or inaccurate entries cause the step to fail verification and retry",
    example: '{"files_created": ["src/auth.ts"], "files_modified": ["src/app.ts"], "commands_run": [{"command": "bun test", "exitCode": 0, "observation": "12/12 tests pass"}]}',
  },
  {
    key: "verification",
    description: "Whether tests passed and a brief summary of test output. Must reflect actual results — a verification agent will re-run reported commands to confirm",
    example: '{"tests_passed": true, "test_output_summary": "12/12 tests pass"}',
  },
  {
    key: "decisions",
    description: "Key architectural or implementation decisions made",
    example: '["Used JWT over session tokens for statelessness"]',
  },
  {
    key: "warnings",
    description: "Issues or risks discovered during execution",
    example: '["Rate limiter not yet configured for production"]',
  },
  {
    key: "files_to_review",
    description: "Files that should be reviewed by the evaluator or user",
    example: '["src/auth.ts", "tests/auth.test.ts"]',
  },
];
