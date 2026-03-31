export const AGENT_DISCOVERY_PHASE = `## Phase 0: Discover Available Agents

Before dispatching ANY agents via Task, you MUST first discover the correct \`subagent_type\` prefix. Agent names vary by engine (e.g., \`fly/reviewer-architecture\` vs \`flywheel:reviewer-architecture\`).

Run a single no-op Task call to trigger the error message that lists available agents:

\`\`\`
Task(subagent_type="__discover__", prompt="list agents")
\`\`\`

The error response will contain: \`Available agents: ...\`. Parse the agent names from that list and use the EXACT names shown (including prefix) as your \`subagent_type\` values.

**Do NOT guess the prefix. Do NOT hardcode \`fly/\` or \`flywheel:\`. Use whatever prefix the discovery response shows.**`;

export const LOCATOR_DISPATCH_INSTRUCTIONS = `## Locator Dispatch

Dispatch ALL 4 locator agents **in parallel** using the Task tool (single message, multiple Task calls). Each locator returns paths and references only — no file contents. Max 500 tokens output each.

### Locator Agents (use the prefix discovered in Phase 0, match by base name)

1. **locator-codebase** — Find WHERE files and components live. Returns file paths only. Categorized by: implementation, tests, config, types, docs.
2. **locator-patterns** — Find WHERE specific patterns exist. Returns file:line references only, grouped by pattern type.
3. **locator-docs** — Find WHERE documentation lives. Searches README, AGENTS.md, docs/, inline comments. Returns paths only.
4. **locator-web** — Find relevant external URLs and documentation. Returns URLs with descriptions only — does not fetch content.

### How to Dispatch

Replace \`<PREFIX>\` with the agent prefix discovered in Phase 0:

\`\`\`
Task(subagent_type="<PREFIX>/locator-codebase", prompt="Find WHERE files and components live related to: [research topic]. Return file paths only, categorized by: implementation, tests, config, types, docs. Max 30 paths.")
Task(subagent_type="<PREFIX>/locator-patterns", prompt="Find WHERE specific patterns exist related to: [research topic]. Return file:line references only, grouped by pattern type. Max 30 locations.")
Task(subagent_type="<PREFIX>/locator-docs", prompt="Find WHERE documentation lives related to: [research topic]. Search README, AGENTS.md, docs/, inline comments. Return paths only. Max 20 paths.")
Task(subagent_type="<PREFIX>/locator-web", prompt="Find documentation and articles about: [research topic]. Return URLs with descriptions only — do not fetch. Categorize: official docs, tutorials, community. Max 15 URLs per category.")
\`\`\`

Launch ALL 4 in a SINGLE response message so they run in parallel.`;

export const ANALYZER_DISPATCH_INSTRUCTIONS = `## Analyzer Dispatch

Dispatch analyzer agents on TOP FINDINGS ONLY using the Task tool. Each analyzer reads actual files and extracts structured findings in documentarian mode. Max 750 tokens output each.

### Analyzer Agents (use the prefix discovered in Phase 0, match by base name)

1. **analyzer-codebase** — Understand HOW code works. Reads files, documents function signatures, data flow, error handling, side effects, dependencies.
2. **analyzer-patterns** — Extract code examples with context. For each pattern: exact code reference, caller usage, constraints, variations.
3. **analyzer-docs** — Extract insights from documentation. Reads docs, synthesizes decisions, constraints, setup instructions, warnings.
4. **analyzer-web** — Fetch and analyze web content deeply. Retrieves URLs, extracts code examples, configuration, version constraints.

### How to Dispatch

Replace \`<PREFIX>\` with the agent prefix discovered in Phase 0:

\`\`\`
Task(subagent_type="<PREFIX>/analyzer-codebase", prompt="Analyze these implementation files related to [research topic]:\\n[list of file paths from locator output]\\nDocument: function signatures, data flow, error handling, side effects, dependencies. File:line references required. Documentarian mode only — do NOT suggest improvements.")
Task(subagent_type="<PREFIX>/analyzer-patterns", prompt="Analyze these pattern locations related to [research topic]:\\n[list of file:line refs from locator output]\\nFor each: exact code reference, caller usage, constraints, variations. File:line references required. Documentarian mode only — do NOT suggest alternatives.")
Task(subagent_type="<PREFIX>/analyzer-docs", prompt="Analyze this documentation related to [research topic]:\\n[list of doc paths from locator output]\\nExtract: decisions, constraints, setup instructions, warnings. Filter aggressively — skip tangential mentions. Documentarian mode only.")
Task(subagent_type="<PREFIX>/analyzer-web", prompt="Fetch and analyze these URLs related to [research topic]:\\n[list of URLs from locator-web output]\\nExtract: code examples, configuration, version constraints, warnings. Documentarian mode only.")
\`\`\`

Launch ALL applicable analyzer Task calls in a SINGLE response message so they run in parallel. Skip analyzer-web if no URLs were found by locator-web. Skip analyzer-docs if no documentation paths were found.`;
