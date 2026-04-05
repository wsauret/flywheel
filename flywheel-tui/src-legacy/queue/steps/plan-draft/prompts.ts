export const DRAFT_JSON_EXAMPLE = `{
  "steps": [
    {
      "title": "Create server module with Bun.serve()",
      "description": "Implement GET /hello endpoint returning JSON {greeting, timestamp}. Bind to 127.0.0.1:3000. Use Bun.serve() API with fetch handler.",
      "acceptanceCriteria": [
        "GET /hello returns 200 with JSON body containing greeting and timestamp",
        "Server binds to 127.0.0.1:3000",
        "Response Content-Type is application/json"
      ],
      "fileReferences": ["src/server/index.ts", "tests/server.test.ts"],
      "feature": "server",
      "fulfills": ["BC-SERVER-001", "BC-SERVER-002"],
      "milestone": "Foundation",
      "estimatedComplexity": "low"
    }
  ],
  "behavioralContract": [
    {
      "id": "BC-SERVER-001",
      "title": "Hello endpoint returns greeting",
      "description": "GET /hello returns 200 with JSON body containing a greeting string and ISO timestamp",
      "evidence": "curl http://localhost:3000/hello returns 200, body has greeting and timestamp fields",
      "area": "Server"
    }
  ],
  "decisions": [
    "Using Bun.serve() native API instead of Express for zero-dependency server"
  ],
  "risks": [
    "Port 3000 may conflict with other services"
  ]
}`;

export const PLAN_DRAFT_SCHEMA_RULES = `### Schema Rules

**steps[]** (required, min 1):
- \`title\` (required): Short, specific action.
- \`description\` (required): Detailed description with file:line references.
- \`acceptanceCriteria\` (required, min 1): Testable pass/fail criteria.
- \`fileReferences\` (required): Files to create or modify, including test files.
- \`feature\` (optional): Groups related steps.
- \`fulfills\` (optional): Behavioral contract assertion IDs.
- \`milestone\` (optional): Groups steps into deliverable milestones.
- \`estimatedComplexity\` (optional): "trivial" | "low" | "medium" | "high" | "critical"

**behavioralContract[]** (required, min 1):
- \`id\` (required): Format \`BC-{AREA}-{NNN}\`.
- \`title\` (required): Short description.
- \`description\` (required): Behavioral pass/fail description.
- \`evidence\` (required): How to verify.
- \`area\` (required): Functional area name.

**decisions[]** (required, may be empty): Architectural decisions.
**risks[]** (required, may be empty): Identified risks.`;

export const PLAN_DRAFT_EXCLUSIONS = `### What NOT to produce

- Do NOT produce a markdown plan file
- Do NOT produce a separate validation-contract.md file
- Do NOT use step headings, checklist syntax, or milestone markers`;

