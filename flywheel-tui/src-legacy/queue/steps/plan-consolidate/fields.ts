import type { HandoffFieldSpec } from "../../shared/handoff-render";

export const PLAN_CONSOLIDATE_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of the consolidated plan",
    example: '"Consolidated plan with user decisions applied..."',
    required: true,
  },
  {
    key: "plan_file_path",
    description: "Path to the final consolidated JSON plan file (use the exact path from Output Requirements)",
    example: '".flywheel/sessions/<session-id>/plan.json"',
  },
  {
    key: "decisions",
    description: "Decisions incorporated from user answers",
    example: '["User chose Auth0 over Cognito"]',
  },
];
