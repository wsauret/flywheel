import type { WorkflowDefinition } from "../schemas/workflow";
import {
  debugInvestigateValidationCriteria,
  debugFixValidationCriteria,
  debugVerifyValidationCriteria,
} from "../prompts/debug/investigate";

export const debugWorkflow: WorkflowDefinition = {
  name: "debug",
  description: "Debug a failing test or issue",
  steps: [
    {
      description: "Investigate: gather context, form hypothesis",
      dispatcherHint:
        "Use debug/investigate prompt template. Read error output, search codebase, form hypothesis.",
      validationCriteria: debugInvestigateValidationCriteria,
    },
    {
      description: "Fix: apply minimum change to address root cause",
      dispatcherHint:
        "Apply smallest possible fix based on hypothesis. One logical change only.",
      validationCriteria: debugFixValidationCriteria,
    },
    {
      description: "Verify: run verification command, confirm fix",
      dispatcherHint:
        "Run verification command and confirm the fix resolves the issue.",
      validationCriteria: debugVerifyValidationCriteria,
    },
  ],
};
