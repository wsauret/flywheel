import { renderWorkPostamble } from "../../shared/handoff-render.js";
import { registerScaffolding, type ScaffoldingPaths } from "../../shared/scaffolding.js";
import { WORK_STEP_FIELDS } from "./fields.js";

registerScaffolding("work", (_step, paths: ScaffoldingPaths) => ({
  preamble: "",
  postamble: renderWorkPostamble(WORK_STEP_FIELDS, paths.handoffPath),
}));
