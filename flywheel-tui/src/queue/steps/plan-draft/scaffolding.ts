import { renderHandoffInstruction, withFieldExample } from "../../shared/handoff-render";
import { registerScaffolding, type ScaffoldingPaths } from "../../shared/scaffolding";
import { DRAFT_JSON_EXAMPLE, PLAN_DRAFT_SCHEMA_RULES, PLAN_DRAFT_EXCLUSIONS } from "./prompts";
import { PLAN_DRAFT_FIELDS } from "./fields";

function buildScaffolding(paths: ScaffoldingPaths): string {
  const planPath = paths.planPath ?? "plan.json";
  const fields = paths.planPath
    ? withFieldExample(PLAN_DRAFT_FIELDS, "plan_file_path", `"${planPath}"`)
    : PLAN_DRAFT_FIELDS;
  return `---
## Output Requirements

You MUST produce a structured JSON plan. Write a single JSON file to:
\`${planPath}\`

Create the parent directory if it does not exist.

### JSON Structure

The file must contain a valid JSON object with this exact schema:

\`\`\`json
${DRAFT_JSON_EXAMPLE}
\`\`\`

${PLAN_DRAFT_SCHEMA_RULES}

${PLAN_DRAFT_EXCLUSIONS}

${renderHandoffInstruction(fields, paths.handoffPath)}`;
}

registerScaffolding("plan:draft", (_step, paths) => ({ preamble: "", postamble: buildScaffolding(paths) }));
