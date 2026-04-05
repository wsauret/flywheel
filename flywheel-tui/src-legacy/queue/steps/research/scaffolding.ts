import { renderHandoffInstruction } from "../../shared/handoff-render";
import { registerScaffolding, type ScaffoldingResult, type ScaffoldingPaths } from "../../shared/scaffolding";
import {
  RESEARCH_PREAMBLE,
  RESEARCH_DOC_TEMPLATE,
  RESEARCH_PERSISTENCE_INSTRUCTIONS,
} from "./prompts";
import { RESEARCH_FIELDS } from "./fields";

function buildScaffolding(paths: ScaffoldingPaths): ScaffoldingResult {
  const researchPath = paths.researchPath ?? "research.md";

  const preamble = `${RESEARCH_PREAMBLE}\n\n---`;

  const postamble = `---
## Output Requirements

${RESEARCH_PERSISTENCE_INSTRUCTIONS}

Write the research document to:
\`${researchPath}\`

${RESEARCH_DOC_TEMPLATE}

${renderHandoffInstruction(RESEARCH_FIELDS, paths.handoffPath)}`;

  return { preamble, postamble };
}

registerScaffolding("research", (_step, paths) => buildScaffolding(paths));
