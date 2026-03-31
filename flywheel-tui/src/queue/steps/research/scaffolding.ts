import { renderHandoffInstruction } from "../../shared/handoff-render";
import { registerScaffolding, type ScaffoldingResult, type ScaffoldingPaths } from "../../shared/scaffolding";
import { LOCATOR_DISPATCH_INSTRUCTIONS } from "../../shared/research-locate";
import { ANALYZER_DISPATCH_INSTRUCTIONS } from "../../shared/research-analyze";
import {
  RESEARCH_DOC_TEMPLATE,
  RESEARCH_PERSISTENCE_INSTRUCTIONS,
} from "./prompts";
import { RESEARCH_FIELDS } from "./fields";

function buildScaffolding(paths: ScaffoldingPaths): ScaffoldingResult {
  const researchPath = paths.researchPath ?? "research.md";
  const preamble = `## YOUR PRIMARY TASK: Research via Locator-Analyzer Pattern

You will execute a three-phase research process within a single worker context:

**Phase 1 — Locate:** Dispatch 4 locator agents in parallel to find relevant files, patterns, docs, and web resources.
**Phase 2 — Analyze:** Rank and deduplicate locator results, then dispatch analyzer agents on top findings.
**Phase 3 — Persist:** Compile findings into a comprehensive research document.

${LOCATOR_DISPATCH_INSTRUCTIONS}

After ranking locator results:

${ANALYZER_DISPATCH_INSTRUCTIONS}

---`;

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
