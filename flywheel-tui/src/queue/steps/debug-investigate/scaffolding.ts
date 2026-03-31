import { renderHandoffInstruction } from "../../shared/handoff-render";
import { registerScaffolding, type ScaffoldingResult, type ScaffoldingPaths } from "../../shared/scaffolding";
import { INVESTIGATION_METHODOLOGY } from "./prompts";
import { DEBUG_INVESTIGATE_FIELDS } from "./fields";

function buildScaffolding(paths: ScaffoldingPaths): ScaffoldingResult {
  const preamble = `## Investigation Phase

${INVESTIGATION_METHODOLOGY}

---`;

  const postamble = `---
## Output Requirements

${renderHandoffInstruction(DEBUG_INVESTIGATE_FIELDS, paths.handoffPath)}`;

  return { preamble, postamble };
}

registerScaffolding("debug:investigate", (_step, paths) => buildScaffolding(paths));
