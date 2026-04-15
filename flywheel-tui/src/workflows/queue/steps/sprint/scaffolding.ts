import { renderWorkPostamble } from "../../shared/handoff-render.js";
import { registerScaffolding, variantKey, type ScaffoldingPaths } from "../../shared/scaffolding.js";
import { WORK_STEP_FIELDS } from "../work/fields.js";
import { SPRINT_HINT } from "./types.js";
import { SPRINT_PREAMBLE } from "./prompts.js";

registerScaffolding(variantKey("work", SPRINT_HINT), (_step, paths: ScaffoldingPaths) => ({
  preamble: SPRINT_PREAMBLE,
  postamble: renderWorkPostamble(WORK_STEP_FIELDS, paths.handoffPath),
}));
