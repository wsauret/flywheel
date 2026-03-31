import { renderHandoffInstruction } from "../../shared/handoff-render";
import { registerScaffolding, type ScaffoldingResult, type ScaffoldingPaths } from "../../shared/scaffolding";
import { PLAN_RESEARCH_PREAMBLE } from "./prompts";
import { PLAN_RESEARCH_FIELDS } from "./fields";

function buildScaffolding(paths: ScaffoldingPaths): ScaffoldingResult {
  return {
    preamble: `${PLAN_RESEARCH_PREAMBLE}\n\n---`,
    postamble: `---\n## Output Requirements\n\n${renderHandoffInstruction(PLAN_RESEARCH_FIELDS, paths.handoffPath)}`,
  };
}

registerScaffolding("plan:research", (_step, paths) => buildScaffolding(paths));
