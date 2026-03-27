import type { WorkflowDefinition } from "../schemas/workflow";
import { planResearchEvaluationCriteria } from "../prompts/plan/research";
import { planDraftEvaluationCriteria } from "../prompts/plan/draft";
import { planReviewEvaluationCriteria } from "../prompts/plan/review";
import { planConsolidateEvaluationCriteria } from "../prompts/plan/consolidate";

export const planWorkflow: WorkflowDefinition = {
  name: "plan",
  description: "Create a new plan from a feature description",
  steps: [
    {
      description: "Research the codebase for relevant files and patterns",
      dispatcherHint:
        "Use plan/research prompt template. Run parallel locators then analyzers.",
      evaluationCriteria: planResearchEvaluationCriteria,
    },
    {
      description: "Draft the plan document",
      dispatcherHint:
        "Use plan/draft prompt template. Include research results.",
      evaluationCriteria: planDraftEvaluationCriteria,
    },
    {
      description: "Review the plan with all reviewer agents",
      dispatcherHint:
        "Use plan/review prompt template. Single worker dispatches 6 reviewer subagents and produces annotated JSON.",
      evaluationCriteria: planReviewEvaluationCriteria,
    },
    {
      description: "Consolidate review findings into actionable plan",
      dispatcherHint:
        "Use plan/consolidate prompt template. Resolve open questions.",
      evaluationCriteria: planConsolidateEvaluationCriteria,
    },
  ],
};
