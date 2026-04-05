import { renderHandoffInstruction, withFieldExample } from "../../shared/handoff-render";
import { registerScaffolding, type ScaffoldingPaths } from "../../shared/scaffolding";
import { CLEAN_JSON_EXAMPLE, PLAN_CONSOLIDATE_SYNTHESIS, PLAN_CONSOLIDATE_QUALITY_CHECKS } from "./prompts";
import { PLAN_CONSOLIDATE_FIELDS } from "./fields";

function buildScaffolding(paths: ScaffoldingPaths): string {
  const planPath = paths.planPath ?? "plan.json";
  const fields = paths.planPath
    ? withFieldExample(PLAN_CONSOLIDATE_FIELDS, "plan_file_path", `"${planPath}"`)
    : PLAN_CONSOLIDATE_FIELDS;
  return `---
## Output Requirements

Produce a CLEAN JSON plan that:
1. Incorporates all P1 and P2 findings into step content
2. Resolves all open questions (document resolutions in \`decisions[]\`)
3. Strips all \`review\` annotations from steps
4. Strips the \`openQuestions\` array
5. Updates \`decisions[]\` with new decisions from review
6. Updates \`risks[]\` with new risks from review

Write the final clean JSON to:
\`${planPath}\`

This should overwrite the annotated version at the same path.

### Output Schema

\`\`\`json
${CLEAN_JSON_EXAMPLE}
\`\`\`

${PLAN_CONSOLIDATE_SYNTHESIS}

${PLAN_CONSOLIDATE_QUALITY_CHECKS}

${renderHandoffInstruction(fields, paths.handoffPath)}`;
}

registerScaffolding("plan:consolidate", (_step, paths) => ({ preamble: "", postamble: buildScaffolding(paths) }));
