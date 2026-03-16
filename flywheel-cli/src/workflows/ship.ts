import type { WorkflowDefinition } from "../schemas/workflow";

export const shipWorkflow: WorkflowDefinition = {
  name: "ship",
  description: "Commit, create PR, and compound learnings",
  steps: [
    {
      description: "Assess current git state and stage changes",
      dispatcherHint:
        "Run git status, review diff, and determine what to stage.",
      validationCriteria: "Changes are staged with specific paths",
    },
    {
      description: "Create branch and commit",
      dispatcherHint:
        "Use ship/workflow prompt template. Create branch and commit with good message.",
      validationCriteria:
        "Branch created with descriptive name, commit with imperative mood message",
    },
    {
      description: "Create pull request",
      dispatcherHint:
        "Push branch and create PR with summary and change list.",
      validationCriteria:
        "PR created with concise title and body, no AI attribution",
    },
    {
      description: "Extract and compound learnings",
      dispatcherHint:
        "Document what was learned during implementation for future reference.",
      validationCriteria:
        "Learnings document created with categorized insights",
    },
  ],
};
