// ---------------------------------------------------------------------------
// Research analyze — reusable constants for prompt scaffolding
// ---------------------------------------------------------------------------

export const researchAnalyzeEvaluationCriteria =
  "Findings extracted from sources with supporting references relevant to the research topic";

// ---------------------------------------------------------------------------
// Reusable prompt constants
// ---------------------------------------------------------------------------

/** Analyzer dispatch instructions for research. */
export const ANALYZER_DISPATCH_INSTRUCTIONS = `## Analyzer Dispatch

Dispatch analyzer agents on TOP FINDINGS ONLY using the Task tool. Each analyzer reads actual files and extracts structured findings in documentarian mode. Max 750 tokens output each.

### Analyzer Agents (installed as \`fly/*\` agents)

These agents are pre-installed and available via the Task tool. Use \`subagent_type\` to reference each one:

1. **fly/analyzer-codebase** — Understand HOW code works. Reads files, documents function signatures, data flow, error handling, side effects, dependencies.
2. **fly/analyzer-patterns** — Extract code examples with context. For each pattern: exact code reference, caller usage, constraints, variations.
3. **fly/analyzer-docs** — Extract insights from documentation. Reads docs, synthesizes decisions, constraints, setup instructions, warnings.
4. **fly/analyzer-web** — Fetch and analyze web content deeply. Retrieves URLs, extracts code examples, configuration, version constraints.

### How to Dispatch

\`\`\`
Task(subagent_type="fly/analyzer-codebase", prompt="Analyze these implementation files related to [research topic]:\\n[list of file paths from locator output]\\nDocument: function signatures, data flow, error handling, side effects, dependencies. File:line references required. Documentarian mode only — do NOT suggest improvements.")
Task(subagent_type="fly/analyzer-patterns", prompt="Analyze these pattern locations related to [research topic]:\\n[list of file:line refs from locator output]\\nFor each: exact code reference, caller usage, constraints, variations. File:line references required. Documentarian mode only — do NOT suggest alternatives.")
Task(subagent_type="fly/analyzer-docs", prompt="Analyze this documentation related to [research topic]:\\n[list of doc paths from locator output]\\nExtract: decisions, constraints, setup instructions, warnings. Filter aggressively — skip tangential mentions. Documentarian mode only.")
Task(subagent_type="fly/analyzer-web", prompt="Fetch and analyze these URLs related to [research topic]:\\n[list of URLs from locator-web output]\\nExtract: code examples, configuration, version constraints, warnings. Documentarian mode only.")
\`\`\`

Launch ALL applicable analyzer Task calls in a SINGLE response message so they run in parallel. Skip fly/analyzer-web if no URLs were found by locator-web. Skip fly/analyzer-docs if no documentation paths were found.`;
