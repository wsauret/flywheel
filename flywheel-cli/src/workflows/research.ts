import type { WorkflowDefinition } from "../schemas/workflow";

export const researchWorkflow: WorkflowDefinition = {
  name: "research",
  description: "Research a topic in the codebase",
  steps: [
    {
      description: "Locate relevant files with parallel locator agents",
      dispatcherHint:
        "Use plan/research locator patterns. Dispatch locator-codebase, locator-patterns, locator-docs.",
      validationCriteria:
        "File paths and line numbers for all relevant code identified",
    },
    {
      description: "Analyze located files for implementation details",
      dispatcherHint:
        "Dispatch analyzer agents for each file group. Document function signatures, data flow, patterns.",
      validationCriteria:
        "Detailed analysis of each relevant file with code examples",
    },
    {
      description: "Persist research document",
      dispatcherHint:
        "Compile findings into a structured research document with YAML frontmatter.",
      validationCriteria:
        "Research document with Codebase Map, Relevant Code, Patterns, Constraints, Open Questions",
    },
  ],
};
