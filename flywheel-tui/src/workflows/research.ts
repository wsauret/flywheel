import type { WorkflowDefinition } from "../schemas/workflow";
import { researchLocateValidationCriteria } from "../prompts/research/locate";
import { researchAnalyzeValidationCriteria } from "../prompts/research/analyze";
import { researchPersistValidationCriteria } from "../prompts/research/persist";

export const researchWorkflow: WorkflowDefinition = {
  name: "research",
  description: "Research a topic in the codebase",
  steps: [
    {
      description: "Locate relevant sources for the research objective",
      dispatcherHint:
        "Identify and locate files, documentation, and references relevant to the research topic.",
      validationCriteria: researchLocateValidationCriteria,
    },
    {
      description: "Analyze located sources for key findings",
      dispatcherHint:
        "Analyze located sources for patterns, implementation details, and insights relevant to the research topic.",
      validationCriteria: researchAnalyzeValidationCriteria,
    },
    {
      description: "Persist structured research document",
      dispatcherHint:
        "Compile findings into a structured research document with YAML frontmatter.",
      validationCriteria: researchPersistValidationCriteria,
    },
  ],
};
