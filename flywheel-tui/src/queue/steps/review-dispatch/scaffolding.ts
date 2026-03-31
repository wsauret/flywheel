import { renderHandoffInstruction } from "../../shared/handoff-render";
import { registerScaffolding, type ScaffoldingResult, type ScaffoldingPaths } from "../../shared/scaffolding";
import { AGENT_DISCOVERY_PHASE } from "../../shared/conventions";
import {
  REVIEWER_DISPATCH_INSTRUCTIONS,
  FINDING_SYNTHESIS_INSTRUCTIONS,
  REVIEW_OUTPUT_FORMAT,
} from "./prompts";
import { REVIEW_DISPATCH_FIELDS } from "./fields";

function buildScaffolding(paths: ScaffoldingPaths): ScaffoldingResult {
  const preamble = `## YOUR PRIMARY TASK: Dispatch Review Agents

${AGENT_DISCOVERY_PHASE}

${REVIEWER_DISPATCH_INSTRUCTIONS}

${FINDING_SYNTHESIS_INSTRUCTIONS}

${REVIEW_OUTPUT_FORMAT}

---`;

  const postamble = `---
## Output Requirements

${renderHandoffInstruction(REVIEW_DISPATCH_FIELDS, paths.handoffPath)}`;

  return { preamble, postamble };
}

registerScaffolding("review:dispatch-reviewers", (_step, paths) => buildScaffolding(paths));
