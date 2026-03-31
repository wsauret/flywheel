import type { HandoffFieldSpec } from "../../shared/handoff-render";

export const DEBUG_INVESTIGATE_FIELDS: HandoffFieldSpec[] = [
  { key: "summary", description: "100-5000 char summary of investigation findings, root cause hypothesis, and evidence gathered", example: '"Investigated the failing test and identified a race condition in the event handler..."', required: true },
  { key: "hypothesis", description: "Root cause hypothesis based on investigation", example: '"The race condition occurs because the event listener is registered after the initial emit"' },
  { key: "artifacts", description: "Files examined and commands run during investigation", example: '{"files_modified": [], "commands_run": [{"command": "bun test tests/event.test.ts", "exitCode": 1, "observation": "Timeout on line 42"}]}' },
  { key: "decisions", description: "Key decisions about the investigation approach", example: '["Focused on event handler timing based on stack trace"]' },
];
