import { renderHandoffInstruction, withFieldExample } from "../../shared/handoff-render";
import { registerScaffolding, type ScaffoldingResult, type ScaffoldingPaths } from "../../shared/scaffolding";
import { PLAN_REVIEW_DISPATCH_PREAMBLE, PLAN_REVIEW_ANNOTATION_RULES } from "./prompts";
import { PLAN_REVIEW_FIELDS } from "./fields";

function buildScaffolding(paths: ScaffoldingPaths): ScaffoldingResult {
  const preamble = `${PLAN_REVIEW_DISPATCH_PREAMBLE}\n\n---`;

  const postamble = `---
## Output Requirements

After all reviewer agents respond, merge their findings and produce annotated JSON.
Read the original JSON plan and produce a new JSON document that:
1. Preserves ALL original fields exactly as-is (do NOT modify title, description, acceptanceCriteria, fileReferences, feature, fulfills, milestone, or estimatedComplexity)
2. Adds a \`review\` object to each step that has findings
3. Adds an \`openQuestions\` array at the top level

Write the annotated JSON to the SAME file path as the original plan (overwrite it).

${PLAN_REVIEW_ANNOTATION_RULES}

${renderHandoffInstruction(
    paths.planPath
      ? withFieldExample(PLAN_REVIEW_FIELDS, "plan_file_path", `"${paths.planPath}"`)
      : PLAN_REVIEW_FIELDS,
    paths.handoffPath,
  )}`;

  return { preamble, postamble };
}

registerScaffolding("plan:review", (_step, paths) => buildScaffolding(paths));
