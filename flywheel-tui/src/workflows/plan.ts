import type { WorkflowDefinition } from "../schemas/workflow";
import { planResearchValidationCriteria } from "../prompts/plan/research";
import { planDraftValidationCriteria } from "../prompts/plan/draft";
import { planReviewValidationCriteria } from "../prompts/plan/review";
import { planConsolidateValidationCriteria } from "../prompts/plan/consolidate";

export const planWorkflow: WorkflowDefinition = {
  name: "plan",
  description: "Create a new plan from a feature description",
  steps: [
    {
      description: "Research the codebase for relevant files and patterns",
      dispatcherHint:
        "Use plan/research prompt template. Run parallel locators then analyzers.",
      validationCriteria: planResearchValidationCriteria,
    },
    {
      description: "Draft the plan document",
      dispatcherHint:
        "Use plan/draft prompt template. Include research results.",
      validationCriteria: planDraftValidationCriteria,
    },
    {
      description: "Review the plan with all reviewer agents",
      dispatcherHint:
        "Use plan/review prompt template. Single worker dispatches 5 reviewer subagents.",
      validationCriteria: planReviewValidationCriteria,
    },
    {
      description: "Consolidate review findings into actionable plan",
      dispatcherHint:
        "Use plan/consolidate prompt template. Resolve open questions.",
      validationCriteria: planConsolidateValidationCriteria,
    },
  ],
};
