import type { WorkflowDefinition } from "../schemas/workflow";
import {
  debugInvestigateEvaluationCriteria,
  debugFixEvaluationCriteria,
  debugVerifyEvaluationCriteria,
} from "../prompts/debug/investigate";

export const debugWorkflow: WorkflowDefinition = {
  name: "debug",
  description: "Debug a failing test or issue",
  steps: [
    {
      description: "Investigate: gather context, form hypothesis",
      dispatcherHint:
        "Use debug/investigate prompt template. Read error output, search codebase, form hypothesis.",
      evaluationCriteria: debugInvestigateEvaluationCriteria,
    },
    {
      description: "Fix: apply minimum change to address root cause",
      dispatcherHint:
        "Apply smallest possible fix based on hypothesis. One logical change only.",
      evaluationCriteria: debugFixEvaluationCriteria,
    },
    {
      description: "Verify: run verification command, confirm fix",
      dispatcherHint:
        "Run verification command and confirm the fix resolves the issue.",
      evaluationCriteria: debugVerifyEvaluationCriteria,
    },
  ],
};
