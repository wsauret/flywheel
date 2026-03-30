// ---------------------------------------------------------------------------
// Research locate — reusable constants for prompt scaffolding
// ---------------------------------------------------------------------------

export const researchLocateEvaluationCriteria =
  "Relevant sources identified and ranked by relevance to the research objective";

// ---------------------------------------------------------------------------
// Reusable prompt constants
// ---------------------------------------------------------------------------

/** Locator agent dispatch instructions for research. */
export const LOCATOR_DISPATCH_INSTRUCTIONS = `## Locator Dispatch

Dispatch ALL 4 locator agents **in parallel** using the Task tool (single message, multiple Task calls). Each locator returns paths and references only — no file contents. Max 500 tokens output each.

### Locator Agents (installed as \`fly/*\` agents)

These agents are pre-installed and available via the Task tool. Use \`subagent_type\` to reference each one:

1. **fly/locator-codebase** — Find WHERE files and components live. Returns file paths only. Categorized by: implementation, tests, config, types, docs.
2. **fly/locator-patterns** — Find WHERE specific patterns exist. Returns file:line references only, grouped by pattern type.
3. **fly/locator-docs** — Find WHERE documentation lives. Searches README, AGENTS.md, docs/, inline comments. Returns paths only.
4. **fly/locator-web** — Find relevant external URLs and documentation. Returns URLs with descriptions only — does not fetch content.

### How to Dispatch

\`\`\`
Task(subagent_type="fly/locator-codebase", prompt="Find WHERE files and components live related to: [research topic]. Return file paths only, categorized by: implementation, tests, config, types, docs. Max 30 paths.")
Task(subagent_type="fly/locator-patterns", prompt="Find WHERE specific patterns exist related to: [research topic]. Return file:line references only, grouped by pattern type. Max 30 locations.")
Task(subagent_type="fly/locator-docs", prompt="Find WHERE documentation lives related to: [research topic]. Search README, AGENTS.md, docs/, inline comments. Return paths only. Max 20 paths.")
Task(subagent_type="fly/locator-web", prompt="Find documentation and articles about: [research topic]. Return URLs with descriptions only — do not fetch. Categorize: official docs, tutorials, community. Max 15 URLs per category.")
\`\`\`

Launch ALL 4 in a SINGLE response message so they run in parallel.`;
