import type { WorkflowDefinition } from "../schemas/workflow";
import { reviewDispatchEvaluationCriteria } from "../prompts/review/dispatch";
import { reviewConsolidateEvaluationCriteria } from "../prompts/review/consolidate";

export const reviewWorkflow: WorkflowDefinition = {
  name: "review",
  description: "Review current code changes",
  steps: [
    {
      description: "Run multi-agent code review",
      dispatcherHint:
        "Use review/dispatch prompt template. Collect diff and dispatch parallel reviewer agents.",
      evaluationCriteria: reviewDispatchEvaluationCriteria,
    },
    {
      description: "Consolidate findings into review document",
      dispatcherHint:
        "Deduplicate, rank by severity, and produce final review document. Worker writes to session review.md path.",
      evaluationCriteria: reviewConsolidateEvaluationCriteria,
    },
    // NOTE: The work/fix step is no longer statically defined here.
    // It is dynamically injected by the review-fix-injection hook
    // in the queue executor when review findings warrant it.
  ],
};
