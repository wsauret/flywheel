import { renderHandoffInstruction } from "../../shared/handoff-render";
import { registerScaffolding, type ScaffoldingPaths } from "../../shared/scaffolding";
import { SPRINT_FIELDS } from "../sprint-work/fields";

registerScaffolding("verify", (_step, paths: ScaffoldingPaths) => ({
  preamble: "",
  postamble: `---
## Output Requirements

${renderHandoffInstruction(SPRINT_FIELDS, paths.handoffPath)}`,
}));
