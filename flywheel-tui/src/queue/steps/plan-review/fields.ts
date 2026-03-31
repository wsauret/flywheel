import type { HandoffFieldSpec } from "../../shared/handoff-render";

export const PLAN_REVIEW_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of the plan review findings",
    example: '"Reviewed the 4-step auth plan. Found 2 open questions..."',
    required: true,
  },
  {
    key: "plan_file_path",
    description: "Path to the annotated JSON plan file (use the exact path from Output Requirements)",
    example: '".flywheel/sessions/<session-id>/plan.json"',
  },
  {
    key: "open_questions",
    description: "Questions that need user input before proceeding",
    example: '[{"question": "Which auth provider?", "options": ["Auth0", "Cognito"], "header": "Auth"}]',
  },
];
