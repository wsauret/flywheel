import type { WorkflowStepContext } from "../index.js";
import { SCOPE_DISCIPLINE, FILE_LINE_DISCIPLINE } from "../conventions.js";
import { renderHandoffInstruction, PLAN_DRAFT_FIELDS } from "../../handoff/field-specs.js";

export const planDraftEvaluationCriteria =
  "Produces a JSON plan file (.plan.json) with steps[], behavioralContract[], decisions[], and risks[]";

/**
 * Builds a prompt for drafting an implementation plan from research results.
 *
 * The worker produces a single JSON plan file at the session's plan.json path.
 * containing {steps[], behavioralContract[], decisions[], risks[]}.
 */
export function buildPlanDraftPrompt(ctx: WorkflowStepContext): string {
  const research = ctx.previousResult
    ? `## Research Results\n\n${ctx.previousResult}`
    : "_No research results available._";

  const decisions =
    ctx.keyDecisions.length > 0
      ? ctx.keyDecisions.map((d) => `- ${d}`).join("\n")
      : "_No prior decisions._";

  return `# Plan Draft

## Feature Description

${ctx.planContent}

${research}

## Key Decisions

${decisions}

---

${SCOPE_DISCIPLINE}

${FILE_LINE_DISCIPLINE}

## Output Format

You MUST produce a structured JSON plan. Write a single JSON file to:
\`${ctx.extra?.planPath ?? "plan.json"}\`

Create the parent directory if it does not exist.

### JSON Structure

The file must contain a valid JSON object with this exact schema:

\`\`\`json
${JSON_EXAMPLE}
\`\`\`

### Schema Rules

${SCHEMA_RULES}

### Step Decomposition Rules

${STEP_DECOMPOSITION_RULES}

### Behavioral Contract Rules

${BEHAVIORAL_CONTRACT_RULES}

### What NOT to produce

- Do NOT produce a markdown plan file
- Do NOT produce a separate validation-contract.md file (it's embedded in the JSON as behavioralContract)
- Do NOT produce a separate .context.md file (context info goes in decisions and risks)
- Do NOT use step headings, checklist syntax, or milestone markers
- Do NOT use HTML comments for fulfills annotations
${ctx.extra?.handoffPath ? `\n${renderHandoffInstruction(PLAN_DRAFT_FIELDS, ctx.extra.handoffPath as string)}` : ""}
`;
}

// ---------------------------------------------------------------------------
// JSON example and schema documentation (kept as constants for clarity)
// ---------------------------------------------------------------------------

const JSON_EXAMPLE = `{
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

const SCHEMA_RULES = `**steps[]** (required, min 1):
- \`title\` (required): Short, specific action. "Implement auth middleware" not "Do auth".
- \`description\` (required): Detailed description. Include file:line references. Be specific enough that a developer reading only this field knows exactly what to build.
- \`acceptanceCriteria\` (required, min 1): Testable pass/fail criteria. Each criterion must be independently verifiable.
- \`fileReferences\` (required): All files to create or modify. Include test files.
- \`feature\` (optional): Groups related steps. Steps with the same feature trigger a quality check when all complete.
- \`fulfills\` (optional): Behavioral contract assertion IDs this step satisfies. Every assertion must be claimed by exactly one step.
- \`milestone\` (optional): Groups steps into deliverable milestones.
- \`estimatedComplexity\` (optional): "trivial" | "low" | "medium" | "high" | "critical"

**behavioralContract[]** (required, min 1):
- \`id\` (required): Format \`BC-{AREA}-{NNN}\` (e.g., BC-AUTH-001). Area is uppercase, number is zero-padded.
- \`title\` (required): Short description of the behavior.
- \`description\` (required): Behavioral pass/fail description. Describe what the system DOES, not how it's built.
- \`evidence\` (required): How to verify — "unit test output", "curl command", "API response".
- \`area\` (required): Functional area name (e.g., "Auth", "API", "Server").

**decisions[]** (required, may be empty): Architectural decisions made during planning.

**risks[]** (required, may be empty): Identified risks and concerns.`;

const STEP_DECOMPOSITION_RULES = `1. **Test-first pairing**: Each implementation step should include its tests in the same step's acceptanceCriteria and fileReferences. Do NOT make separate "write test" and "implement" steps — a single step does both.
2. **Single responsibility**: One step, one clear goal. If description needs "and" for unrelated things, split.
3. **Dependencies flow forward**: Step N never depends on Step N+1.
4. **Feature grouping**: Related steps share a \`feature\` value. Quality checks fire at feature boundaries.
5. **Milestone grouping**: Steps in the same milestone form a deliverable unit.
6. **Each step = one subprocess (context-clearing boundary).** Every step spawns an independent AI worker with a blank context window. The rule for splitting: will clearing context help or hurt? If the next chunk of work benefits from a fresh perspective (e.g., a large unrelated feature after a complex refactor), make it a new step. If the next activity needs awareness of what was just done (e.g., running tests after code changes, auditing related code, smoke-testing the thing you just built), keep it in the SAME step — losing that context would force the worker to rediscover everything. A 4-step plan where step 1 fixes a bug and steps 2-4 are "audit", "run tests", and "smoke test" is WRONG — that's one step whose acceptanceCriteria includes those verification checks, because the worker that wrote the fix is best positioned to run tests and fix failures.`;

const BEHAVIORAL_CONTRACT_RULES = `1. **Complete coverage**: Every step should fulfill at least one assertion. Every assertion should be fulfilled by exactly one step.
2. **Behavioral, not structural**: Describe what the user or system sees, not implementation details.
3. **Independently testable**: Each assertion can be verified in isolation.
4. **Area grouping**: Use consistent area names across assertions.`;
