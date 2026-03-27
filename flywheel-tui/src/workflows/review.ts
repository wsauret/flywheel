import type { WorkflowDefinition } from "../schemas/workflow";
import { reviewDispatchEvaluationCriteria } from "../prompts/review/dispatch";
import { reviewConsolidateEvaluationCriteria } from "../prompts/review/consolidate";
import { reviewFixEvaluationCriteria } from "../prompts/review/fix";

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
        "Deduplicate, rank by severity, and produce final review document. Worker writes to .flywheel/reviews/<date>-<slug>.md.",
      evaluationCriteria: reviewConsolidateEvaluationCriteria,
    },
    {
      description: "Implement review findings",
      dispatcherHint: "Read the review document and implement P1/P2 fixes. Skip if no actionable findings.",
      evaluationCriteria: reviewFixEvaluationCriteria,
    },
  ],
};
