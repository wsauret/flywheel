import { renderHandoffInstruction } from "../../shared/handoff-render";
import { registerScaffolding, type ScaffoldingPaths } from "../../shared/scaffolding";
import { WORK_STEP_FIELDS } from "./fields";

registerScaffolding("work", (_step, paths: ScaffoldingPaths) => ({
  preamble: "",
  postamble: `---
## Output Requirements

${renderHandoffInstruction(WORK_STEP_FIELDS, paths.handoffPath)}`,
}));
