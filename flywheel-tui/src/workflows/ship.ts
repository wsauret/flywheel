import type { WorkflowDefinition } from "../schemas/workflow";
import { shipStageValidationCriteria, shipCommitValidationCriteria, shipPRValidationCriteria } from "../prompts/ship/workflow";
import { shipCompoundValidationCriteria } from "../prompts/ship/compound";

export const shipWorkflow: WorkflowDefinition = {
  name: "ship",
  description: "Commit, create PR, and compound learnings",
  steps: [
    {
      description: "Assess current git state and stage changes",
      dispatcherHint:
        "Run git status, review diff, and determine what to stage.",
      validationCriteria: shipStageValidationCriteria,
    },
    {
      description: "Create branch and commit",
      dispatcherHint:
        "Use ship/workflow prompt template. Create branch and commit with good message.",
      validationCriteria: shipCommitValidationCriteria,
    },
    {
      description: "Create pull request",
      dispatcherHint:
        "Push branch and create PR with summary and change list.",
      validationCriteria: shipPRValidationCriteria,
    },
    {
      description: "Extract and compound learnings",
      dispatcherHint:
        "Document what was learned during implementation for future reference.",
      validationCriteria: shipCompoundValidationCriteria,
    },
  ],
};
