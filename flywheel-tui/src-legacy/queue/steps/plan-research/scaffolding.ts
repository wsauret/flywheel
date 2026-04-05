import { renderHandoffInstruction } from "../../shared/handoff-render";
import { registerScaffolding, type ScaffoldingResult, type ScaffoldingPaths } from "../../shared/scaffolding";
import { PLAN_RESEARCH_PREAMBLE } from "./prompts";
import { PLAN_RESEARCH_FIELDS } from "./fields";

function buildScaffolding(paths: ScaffoldingPaths): ScaffoldingResult {
  const contextPath = paths.contextPath ?? "context.md";

  return {
    preamble: `${PLAN_RESEARCH_PREAMBLE}\n\n---`,
    postamble: `---
## Output Requirements

Write the context/research file to:
\`${contextPath}\`

${renderHandoffInstruction(PLAN_RESEARCH_FIELDS, paths.handoffPath)}`,
  };
}

registerScaffolding("plan:research", (_step, paths) => buildScaffolding(paths));
