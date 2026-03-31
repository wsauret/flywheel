import { renderHandoffInstruction } from "../../shared/handoff-render";
import { registerScaffolding, type ScaffoldingPaths } from "../../shared/scaffolding";
import {
  COMPOUND_DOC_FORMAT,
  COMPOUND_DEDUP_RULES,
} from "./prompts";
import { SHIP_LEARNINGS_FIELDS } from "./fields";

registerScaffolding("ship:learnings", (_step, paths: ScaffoldingPaths) => ({
  preamble: "",
  postamble: `---
## Output Requirements

${COMPOUND_DOC_FORMAT}

${COMPOUND_DEDUP_RULES}

${renderHandoffInstruction(SHIP_LEARNINGS_FIELDS, paths.handoffPath)}`,
}));
