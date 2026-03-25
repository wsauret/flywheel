import type { WorkflowDefinition } from "../schemas/workflow";
import { reviewDispatchValidationCriteria } from "../prompts/review/dispatch";
import { reviewConsolidateValidationCriteria } from "../prompts/review/consolidate";
import { reviewFixValidationCriteria } from "../prompts/review/fix";

export const reviewWorkflow: WorkflowDefinition = {
  name: "review",
  description: "Review current code changes",
  steps: [
    {
      description: "Run multi-agent code review",
      dispatcherHint:
        "Use review/dispatch prompt template. Collect diff and dispatch parallel reviewer agents.",
      validationCriteria: reviewDispatchValidationCriteria,
    },
    {
      description: "Consolidate findings into review document",
      dispatcherHint:
        "Deduplicate, rank by severity, and produce final review document.",
      validationCriteria: reviewConsolidateValidationCriteria,
    },
    {
      description: "Implement review findings",
      dispatcherHint: "Read the review document and implement P1/P2 fixes. Skip if no actionable findings.",
      validationCriteria: reviewFixValidationCriteria,
    },
  ],
};
