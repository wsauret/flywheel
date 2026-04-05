import type { HandoffFieldSpec } from "../../shared/handoff-render";

export const DEBUG_VERIFY_FIELDS: HandoffFieldSpec[] = [
  { key: "summary", description: "100-5000 char summary of verification results", example: '"Verification confirmed the fix resolves the original issue. All tests pass..."', required: true },
  { key: "verification", description: "Verification command output and result", example: '{"tests_passed": true, "test_output_summary": "42/42 tests pass, no regressions"}' },
  { key: "artifacts", description: "Commands run during verification", example: '{"commands_run": [{"command": "bun test", "exitCode": 0, "observation": "42/42 pass"}]}' },
];
