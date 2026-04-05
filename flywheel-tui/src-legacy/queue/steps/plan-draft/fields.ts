import type { HandoffFieldSpec } from "../../shared/handoff-render";

export const PLAN_DRAFT_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of the plan created, its scope, and approach",
    example: '"Created a 4-step plan for implementing the auth system..."',
    required: true,
  },
  {
    key: "plan_file_path",
    description: "Path to the JSON plan file produced by the draft step (use the exact path from Output Requirements)",
    example: '".flywheel/sessions/<session-id>/plan.json"',
  },
  {
    key: "decisions",
    description: "Key decisions made while drafting the plan",
    example: '["Split into 4 steps for incremental delivery"]',
  },
  {
    key: "warnings",
    description: "Risks or concerns identified during planning",
    example: '["Migration may require downtime"]',
  },
];
