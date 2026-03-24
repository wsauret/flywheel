import type { WorkflowDefinition } from "../schemas/workflow";

export const researchWorkflow: WorkflowDefinition = {
  name: "research",
  description: "Research a topic in the codebase",
  steps: [
    {
      description: "Locate relevant sources for the research objective",
      dispatcherHint:
        "Identify and locate files, documentation, and references relevant to the research topic.",
      validationCriteria:
        "Relevant sources identified and ranked by relevance to the research objective",
    },
    {
      description: "Analyze located sources for key findings",
      dispatcherHint:
        "Analyze located sources for patterns, implementation details, and insights relevant to the research topic.",
      validationCriteria:
        "Findings extracted from sources with supporting references relevant to the research topic",
    },
    {
      description: "Persist structured research document",
      dispatcherHint:
        "Compile findings into a structured research document with YAML frontmatter.",
      validationCriteria:
        "Comprehensive research document persisted with findings and source references",
    },
  ],
};
