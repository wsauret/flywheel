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
        "Relevant files and references identified for the research objective",
    },
    {
      description: "Analyze located sources for key findings",
      dispatcherHint:
        "Analyze located sources for patterns, implementation details, and insights relevant to the research topic.",
      validationCriteria:
        "Analysis of located sources relevant to the research topic",
    },
    {
      description: "Persist structured research document",
      dispatcherHint:
        "Compile findings into a structured research document with YAML frontmatter.",
      validationCriteria:
        "Structured research document covering the topic with relevant findings",
    },
  ],
};
