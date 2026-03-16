import type { WorkflowDefinition } from "../schemas/workflow";

export const planWorkflow: WorkflowDefinition = {
  name: "plan",
  description: "Create a new plan from a feature description",
  steps: [
    {
      description: "Research the codebase for relevant files and patterns",
      dispatcherHint:
        "Use plan/research prompt template. Run parallel locators then analyzers.",
      validationCriteria:
        "Produces a .context.md file with file references and patterns",
    },
    {
      description: "Draft the plan document",
      dispatcherHint:
        "Use plan/draft prompt template. Include research results.",
      validationCriteria:
        "Produces a plan.md with phases, checklist items, and technical reference",
    },
    {
      description: "Review the plan with all reviewer agents",
      dispatcherHint:
        "Use plan/review prompt template. Single worker dispatches 5 reviewer subagents.",
      validationCriteria:
        "Review findings appended to plan with P1/P2/P3 categorization",
    },
    {
      description: "Consolidate review findings into actionable plan",
      dispatcherHint:
        "Use plan/consolidate prompt template. Resolve open questions.",
      validationCriteria:
        "Final plan.md with Implementation Checklist, all P1 items addressed",
    },
  ],
};
