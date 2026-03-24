import type { WorkflowDefinition } from "../schemas/workflow";

export const reviewWorkflow: WorkflowDefinition = {
  name: "review",
  description: "Review current code changes",
  steps: [
    {
      description: "Collect diff and identify changed files",
      dispatcherHint:
        "Run git diff and git status to collect the change set.",
      validationCriteria:
        "Produces a list of changed files with diff content",
    },
    {
      description: "Run multi-agent code review",
      dispatcherHint:
        "Use review/dispatch prompt template. Dispatch parallel reviewer agents.",
      validationCriteria:
        "Each reviewer returns findings categorized by severity, or confirms no issues if changes are clean",
    },
    {
      description: "Consolidate findings into review document",
      dispatcherHint:
        "Deduplicate, rank by severity, and produce final review document.",
      validationCriteria:
        "Review document with P1/P2/P3 findings and implementation order, or clean summary if no significant issues found",
    },
    {
      description: "Implement review findings",
      dispatcherHint: "Read the review document and implement P1/P2 fixes. Skip if no actionable findings.",
      validationCriteria: "All P1 findings addressed, P2 findings addressed where feasible, tests pass",
    },
  ],
};
