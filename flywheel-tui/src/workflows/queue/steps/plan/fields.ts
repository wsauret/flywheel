import type { HandoffFieldSpec } from "../../shared/handoff-render.js";

export const PLAN_STEP_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of the planning process, key decisions, and the resulting plan structure",
    example: '"Analyzed the codebase and produced a 4-step implementation plan for the authentication middleware..."',
    required: true,
  },
  {
    key: "artifacts",
    description: "Files created (e.g., plan document) and commands run during research",
    example: '{"files_created": ["docs/plans/auth-middleware.md"], "commands_run": [{"command": "bun run test", "exitCode": 0, "observation": "baseline tests pass"}]}',
  },
  {
    key: "decisions",
    description: "Key architectural or scoping decisions made during planning",
    example: '["Chose JWT over session tokens for statelessness", "Scoped to API routes only — UI auth deferred"]',
  },
  {
    key: "warnings",
    description: "Risks, unknowns, or constraints that could affect implementation",
    example: '["Rate limiting not yet in place — add before production", "Migration requires downtime window"]',
  },
];
