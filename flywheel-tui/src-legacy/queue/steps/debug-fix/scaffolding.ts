import { renderHandoffInstruction } from "../../shared/handoff-render";
import { registerScaffolding, type ScaffoldingPaths } from "../../shared/scaffolding";
import { FIX_LOOP_RULES, FIX_ITERATION_TEMPLATE } from "./prompts";
import { DEBUG_FIX_FIELDS } from "./fields";

registerScaffolding("debug:fix", (_step, paths: ScaffoldingPaths) => ({
  preamble: "",
  postamble: `---
## Fix Phase

${FIX_LOOP_RULES}

${FIX_ITERATION_TEMPLATE}

${renderHandoffInstruction(DEBUG_FIX_FIELDS, paths.handoffPath)}`,
}));
