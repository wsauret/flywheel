import { renderHandoffInstruction } from "../../shared/handoff-render.js";
import { registerScaffolding, type ScaffoldingPaths } from "../../shared/scaffolding.js";
import { PLAN_STEP_FIELDS } from "./fields.js";
import { PLAN_PREAMBLE } from "./prompts.js";

registerScaffolding("plan", (_step, paths: ScaffoldingPaths) => ({
  preamble: PLAN_PREAMBLE,

  postamble: `---
## Output Requirements

${renderHandoffInstruction(PLAN_STEP_FIELDS, paths.handoffPath)}`,
}));
