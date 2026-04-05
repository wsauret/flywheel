import { renderHandoffInstruction } from "../../shared/handoff-render";
import { registerScaffolding, type ScaffoldingPaths } from "../../shared/scaffolding";
import { RESOLUTION_FORMAT, ESCALATION_FORMAT } from "./prompts";
import { DEBUG_VERIFY_FIELDS } from "./fields";

registerScaffolding("debug:debug-verify", (_step, paths: ScaffoldingPaths) => ({
  preamble: "",
  postamble: `---
## Verification Phase

${RESOLUTION_FORMAT}

${ESCALATION_FORMAT}

${renderHandoffInstruction(DEBUG_VERIFY_FIELDS, paths.handoffPath)}`,
}));
