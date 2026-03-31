import type { HandoffFieldSpec } from "../../shared/handoff-render";

export const SPRINT_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of what was implemented and verified during this sprint iteration",
    example: '"Implemented hello-world endpoint with Express, wrote verification script that curls the endpoint and asserts 200 response."',
    required: true,
  },
  {
    key: "verification_script_path",
    description: "Path to the verification script written during this sprint iteration (must be in .flywheel/verify/)",
    example: '".flywheel/verify/sprint-hello-world.ts"',
  },
  {
    key: "artifacts",
    description: "Files created, modified, and commands run during this sprint iteration. IMPORTANT: commands_run entries will be RE-EXECUTED by a verification agent — only list commands you actually ran, with accurate exit codes",
    example: '{"files_created": ["src/hello.ts", ".flywheel/verify/sprint-hello-world.ts"], "files_modified": ["src/app.ts"], "commands_run": [{"command": "bun test", "exitCode": 0, "observation": "5/5 tests pass"}]}',
  },
  {
    key: "verification",
    description: "Whether tests passed and a brief summary of test output",
    example: '{"tests_passed": true, "test_output_summary": "5/5 tests pass, verification script exits 0"}',
  },
  {
    key: "decisions",
    description: "Key implementation decisions made during this iteration",
    example: '["Used Express over Hono for consistency with existing codebase"]',
  },
  {
    key: "warnings",
    description: "Issues or risks discovered during execution",
    example: '["Verification script only covers happy path"]',
  },
  {
    key: "files_to_review",
    description: "Files that should be reviewed by the evaluator",
    example: '["src/hello.ts", ".flywheel/verify/sprint-hello-world.ts"]',
  },
  {
    key: "needs_plan",
    description: "Set to true if the task is too complex for sprint and requires full planning (only when worker_can_escalate is enabled)",
    example: "false",
  },
];
