import { renderHandoffInstruction, withFieldExample } from "../../shared/handoff-render";
import { registerScaffolding, type ScaffoldingResult, type ScaffoldingPaths } from "../../shared/scaffolding";
import {
  CONSOLIDATION_INSTRUCTIONS,
  REVIEW_DOC_TEMPLATE,
} from "./prompts";
import { REVIEW_CONSOLIDATE_FIELDS } from "./fields";

function buildScaffolding(paths: ScaffoldingPaths): ScaffoldingResult {
  const resolvedPath = paths.reviewPath ?? "review.md";
  const fields = paths.reviewPath
    ? withFieldExample(REVIEW_CONSOLIDATE_FIELDS, "review_file_path", `"${paths.reviewPath}"`)
    : REVIEW_CONSOLIDATE_FIELDS;
  const postamble = `---
## Output Requirements

${CONSOLIDATION_INSTRUCTIONS}

${REVIEW_DOC_TEMPLATE}

## IMPORTANT: Write the review document

Write the final review document to:
\`${resolvedPath}\`

${renderHandoffInstruction(fields, paths.handoffPath)}`;

  return { preamble: "", postamble };
}

registerScaffolding("review:consolidate-review", (_step, paths) => buildScaffolding(paths));
