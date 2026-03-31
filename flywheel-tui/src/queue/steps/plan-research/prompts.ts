import { AGENT_DISCOVERY_PHASE } from "../../shared/conventions";
import { LOCATOR_DISPATCH_INSTRUCTIONS } from "../../shared/research-locate";
import { ANALYZER_DISPATCH_INSTRUCTIONS } from "../../shared/research-analyze";

export const PLAN_RESEARCH_PREAMBLE = `## YOUR PRIMARY TASK: Dispatch Locator and Analyzer Agents

${AGENT_DISCOVERY_PHASE}

After discovering agents, follow this two-phase dispatch pattern:

**Phase 1 — Locators (parallel):** Dispatch ALL 3 locator agents in a SINGLE message with multiple Task calls. They find WHERE things are.
**Phase 1b — Rank:** Deduplicate and rank locator results. Select top findings for analyzers.
**Phase 2 — Analyzers (parallel):** Dispatch analyzer agents on TOP FINDINGS ONLY in a SINGLE message.

Do NOT do the research yourself — delegate to these specialized agents.

### Locator Agents (use the prefix discovered in Phase 0, match by base name)

1. **locator-codebase** — Finds implementation files, tests, configs, types, docs.
2. **locator-patterns** — Finds file:line references for specific patterns, imports, APIs.
3. **locator-docs** — Finds README, AGENTS.md, docs/, inline documentation.

### Analyzer Agents (use the prefix discovered in Phase 0, match by base name)

1. **analyzer-codebase** — Reads files, documents function signatures, data flow, error handling.
2. **analyzer-patterns** — Extracts code examples with context, caller usage, constraints.

### How to Dispatch Locators

Launch ALL 3 in a SINGLE response message (replace \`<PREFIX>\` with the discovered prefix):

\`\`\`
Task(subagent_type="<PREFIX>/locator-codebase", prompt="Find WHERE files and components live related to: [topic]. Return file paths only, max 30 paths.")
Task(subagent_type="<PREFIX>/locator-patterns", prompt="Find WHERE specific patterns exist related to: [topic]. Return file:line references only, max 30 locations.")
Task(subagent_type="<PREFIX>/locator-docs", prompt="Find WHERE documentation lives related to: [topic]. Return paths only. Max 20 paths.")
\`\`\`

### How to Dispatch Analyzers (after ranking locator results)

Launch both in a SINGLE response message:

\`\`\`
Task(subagent_type="<PREFIX>/analyzer-codebase", prompt="Analyze these files related to [topic]:\\n[top 15 file paths]\\nDocument function signatures, data flow, error handling. File:line references required. Documentarian mode — do NOT suggest improvements.")
Task(subagent_type="<PREFIX>/analyzer-patterns", prompt="Analyze these patterns related to [topic]:\\n[top 10 file:line refs]\\nFor each: exact code, caller usage, constraints. File:line references required. Documentarian mode — do NOT suggest alternatives.")
\`\`\``;
