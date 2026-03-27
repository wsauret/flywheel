import type { WorkflowDefinition } from "../schemas/workflow";
import { shipStageEvaluationCriteria, shipCommitEvaluationCriteria, shipPREvaluationCriteria } from "../prompts/ship/workflow";
import { shipCompoundEvaluationCriteria } from "../prompts/ship/compound";

export const shipWorkflow: WorkflowDefinition = {
  name: "ship",
  description: "Commit, create PR, and compound learnings",
  steps: [
    {
      description: "Assess current git state and stage changes",
      dispatcherHint:
        "Run git status, review diff, and determine what to stage.",
      evaluationCriteria: shipStageEvaluationCriteria,
    },
    {
      description: "Create branch and commit",
      dispatcherHint:
        "Use ship/workflow prompt template. Create branch and commit with good message.",
      evaluationCriteria: shipCommitEvaluationCriteria,
    },
    {
      description: "Create pull request",
      dispatcherHint:
        "Push branch and create PR with summary and change list.",
      evaluationCriteria: shipPREvaluationCriteria,
    },
    {
      description: "Extract and compound learnings",
      dispatcherHint:
        "Document what was learned during implementation for future reference.",
      evaluationCriteria: shipCompoundEvaluationCriteria,
    },
  ],
};
