import { renderHandoffInstruction } from "../../shared/handoff-render";
import { registerScaffolding, type ScaffoldingPaths } from "../../shared/scaffolding";
import {
  NO_AI_ATTRIBUTION_RULE,
  STAGING_RULES,
  PR_FORMAT,
  BRANCH_NAMING,
} from "./prompts";
import { SHIP_COMMIT_FIELDS } from "./fields";

registerScaffolding("ship:ship", (_step, paths: ScaffoldingPaths) => ({
  preamble: "",
  postamble: `---
## Output Requirements

${NO_AI_ATTRIBUTION_RULE}

${BRANCH_NAMING}

${STAGING_RULES}

${PR_FORMAT}

${renderHandoffInstruction(SHIP_COMMIT_FIELDS, paths.handoffPath)}`,
}));
