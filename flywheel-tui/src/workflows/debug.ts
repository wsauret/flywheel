import type { WorkflowDefinition } from "../schemas/workflow";

export const debugWorkflow: WorkflowDefinition = {
  name: "debug",
  description: "Debug a failing test or issue",
  steps: [
    {
      description: "Investigate: gather context, form hypothesis",
      dispatcherHint:
        "Use debug/investigate prompt template. Read error output, search codebase, form hypothesis.",
      validationCriteria:
        "Hypothesis formed with evidence and likelihood assessment",
    },
    {
      description: "Fix: apply minimum change to address root cause",
      dispatcherHint:
        "Apply smallest possible fix based on hypothesis. One logical change only.",
      validationCriteria:
        "Fix applied with file:line references documenting the change",
    },
    {
      description: "Verify: run verification command, confirm fix",
      dispatcherHint:
        "Run verification command and confirm the fix resolves the issue.",
      validationCriteria:
        "Verification command output shows the issue is resolved",
    },
  ],
};
