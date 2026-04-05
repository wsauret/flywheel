import type { HandoffFieldSpec } from "../../shared/handoff-render";

export const DEBUG_FIX_FIELDS: HandoffFieldSpec[] = [
  { key: "summary", description: "100-5000 char summary of the fix applied and rationale", example: '"Applied minimum-change fix to register the event listener before the initial emit..."', required: true },
  { key: "artifacts", description: "Files modified and commands run to apply the fix. IMPORTANT: commands_run entries will be RE-EXECUTED by verification", example: '{"files_modified": ["src/events/handler.ts"], "commands_run": [{"command": "bun test", "exitCode": 0, "observation": "All tests pass"}]}' },
  { key: "verification", description: "Whether tests passed after the fix", example: '{"tests_passed": true, "test_output_summary": "42/42 tests pass"}' },
  { key: "files_to_review", description: "Files changed by the fix", example: '["src/events/handler.ts"]' },
];
