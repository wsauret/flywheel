import { renderWorkPostamble } from "../../shared/handoff-render.js";
import {
  registerScaffolding,
  type ScaffoldingPaths,
  type ScaffoldingResult,
} from "../../shared/scaffolding.js";
import { WORK_STEP_FIELDS } from "./fields.js";

registerScaffolding(
  "work",
  (_step, paths: ScaffoldingPaths): ScaffoldingResult => ({
    preamble: "",
    postamble: renderWorkPostamble(WORK_STEP_FIELDS, paths.handoffPath),
  }),
  "work-handoff",
);
