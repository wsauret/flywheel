// ---------------------------------------------------------------------------
// Prompt Scaffolding — deterministic HOW appended to dispatcher's WHAT
// ---------------------------------------------------------------------------
//
// After the dispatcher returns task_content (contextual "what to do"), the
// executor appends fixed scaffolding from existing prompt templates. The
// dispatcher fills in the WHAT; this module injects the HOW.
//
// Each step type gets appropriate output format instructions and handoff
// writing instructions. Gate steps get no scaffolding.
// ---------------------------------------------------------------------------

import type { Step } from "./types";
import {
  renderHandoffInstruction,
  PLAN_DRAFT_FIELDS,
  PLAN_REVIEW_FIELDS,
  PLAN_CONSOLIDATE_FIELDS,
  PLAN_RESEARCH_FIELDS,
  WORK_STEP_FIELDS,
  REVIEW_FIELDS,
  SPRINT_FIELDS,
  SHIP_FIELDS,
} from "../handoff/field-specs.js";
import { DEFAULT_PLANS_DIR } from "../config/paths.js";

// ---------------------------------------------------------------------------
// Plan sub-step role detection
// ---------------------------------------------------------------------------

type PlanRole = "research" | "draft" | "review" | "consolidate";

function detectPlanRole(step: Step): PlanRole {
  const hint = step.dispatcherHint?.toLowerCase();
  if (hint === "draft") return "draft";
  if (hint === "review") return "review";
  if (hint === "consolidate") return "consolidate";
  if (hint === "research") return "research";

  // Fallback to title matching
  const title = step.title.toLowerCase();
  if (title.includes("draft")) return "draft";
  if (title.includes("review plan") || title.includes("review")) return "review";
  if (title.includes("consolidate")) return "consolidate";
  return "research";
}

// ---------------------------------------------------------------------------
// JSON schema examples (extracted from prompt templates)
// ---------------------------------------------------------------------------

const DRAFT_JSON_EXAMPLE = `{
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

const ANNOTATED_JSON_EXAMPLE = `{
  "steps": [
    {
      "title": "Original title (DO NOT MODIFY)",
      "description": "Original description (DO NOT MODIFY)",
      "acceptanceCriteria": ["Original (DO NOT MODIFY)"],
      "fileReferences": ["Original (DO NOT MODIFY)"],
      "feature": "original",
      "fulfills": ["BC-AREA-001"],
      "review": {
        "findings": [
          {
            "severity": "P1",
            "description": "Must bind to 127.0.0.1, not 0.0.0.0",
            "reviewer": "security",
            "actionRequired": "Add explicit host binding"
          }
        ]
      }
    }
  ],
  "behavioralContract": [
    {
      "id": "BC-AREA-001",
      "title": "DO NOT MODIFY",
      "description": "DO NOT MODIFY",
      "evidence": "DO NOT MODIFY",
      "area": "DO NOT MODIFY"
    }
  ],
  "decisions": ["DO NOT MODIFY"],
  "risks": ["DO NOT MODIFY"],
  "openQuestions": [
    {
      "question": "Should server.enabled default to true or false?",
      "raisedBy": "scope",
      "options": ["true (simpler)", "false (safer)"]
    }
  ]
}`;

const CLEAN_JSON_EXAMPLE = `{
  "steps": [
    {
      "title": "Create server module with Bun.serve()",
      "description": "Implement GET /hello endpoint. Bind to 127.0.0.1:3000 (per security review).",
      "acceptanceCriteria": [
        "GET /hello returns 200 with JSON body",
        "Server binds to 127.0.0.1:3000 (not 0.0.0.0)"
      ],
      "fileReferences": ["src/server/index.ts", "tests/server.test.ts"],
      "feature": "server",
      "fulfills": ["BC-SERVER-001"],
      "milestone": "Foundation",
      "estimatedComplexity": "low"
    }
  ],
  "behavioralContract": [
    {
      "id": "BC-SERVER-001",
      "title": "Hello endpoint returns greeting",
      "description": "GET /hello returns 200 with greeting and timestamp",
      "evidence": "curl http://localhost:3000/hello returns 200",
      "area": "Server"
    }
  ],
  "decisions": [
    "Using Bun.serve() native API",
    "Bind to 127.0.0.1 per security review"
  ],
  "risks": [
    "Port 3000 may conflict with other services"
  ]
}`;

// ---------------------------------------------------------------------------
// Scaffolding builders per plan role
// ---------------------------------------------------------------------------

function buildPlanDraftScaffolding(handoffPath: string): string {
  return `---
## Output Requirements

You MUST produce a structured JSON plan. Write a single JSON file to:
\`${DEFAULT_PLANS_DIR}/{type}-{description}.plan.json\`

Where \`{type}\` is one of: feat, fix, refactor, chore, docs
And \`{description}\` is a short kebab-case name for the feature.

Create the \`${DEFAULT_PLANS_DIR}/\` directory if it does not exist.

### JSON Structure

The file must contain a valid JSON object with this exact schema:

\`\`\`json
${DRAFT_JSON_EXAMPLE}
\`\`\`

### Schema Rules

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
**risks[]** (required, may be empty): Identified risks.

### What NOT to produce

- Do NOT produce a markdown plan file
- Do NOT produce a separate validation-contract.md file
- Do NOT use step headings, checklist syntax, or milestone markers

${renderHandoffInstruction(PLAN_DRAFT_FIELDS, handoffPath)}`;
}

function buildPlanReviewScaffolding(handoffPath: string): string {
  return `---
## Output Requirements

You MUST produce annotated JSON. Read the original JSON plan and produce a new JSON document that:
1. Preserves ALL original fields exactly as-is (do NOT modify title, description, acceptanceCriteria, fileReferences, feature, fulfills, milestone, or estimatedComplexity)
2. Adds a \`review\` object to each step that has findings
3. Adds an \`openQuestions\` array at the top level

Write the annotated JSON to the SAME file path as the original plan (overwrite it).

### Annotated JSON Structure

\`\`\`json
${ANNOTATED_JSON_EXAMPLE}
\`\`\`

### Critical Rules

1. **NEVER modify draft-authored fields.** The \`title\`, \`description\`, \`acceptanceCriteria\`, \`fileReferences\`, \`feature\`, \`fulfills\`, \`milestone\`, \`estimatedComplexity\`, \`behavioralContract\`, \`decisions\`, and \`risks\` fields must be EXACTLY as they were in the original plan.
2. **Only add \`review\` and \`openQuestions\`.** These are the only fields the review step may add.
3. **Omit \`review\` on steps with no findings.**
4. **openQuestions is always present.** Even if empty, include \`"openQuestions": []\`.
5. **Findings use severity P1/P2/P3.** P1 = critical, P2 = important, P3 = minor.

${renderHandoffInstruction(PLAN_REVIEW_FIELDS, handoffPath)}`;
}

function buildPlanConsolidateScaffolding(handoffPath: string): string {
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
\`${DEFAULT_PLANS_DIR}/<type>-<description>.plan.json\`

This should overwrite the annotated version at the same path.

### Output Schema

\`\`\`json
${CLEAN_JSON_EXAMPLE}
\`\`\`

### Synthesis Principles

1. **Merge findings INTO steps.** Review findings belong in the step's description and acceptanceCriteria.
2. **P1 findings are mandatory.** Every P1 must be incorporated.
3. **P2 findings are strongly recommended.** Incorporate unless deferred with rationale.
4. **P3 findings are optional.** Incorporate useful ones, defer others.
5. **Resolve ALL open questions.** Document rationale in decisions.
6. **Preserve test-first intent.** acceptanceCriteria should be testable.
7. **No orphaned assertions.** Every behavioralContract assertion must be claimed by exactly one step.

### Quality Checks

- [ ] Every P1 finding is incorporated into a step
- [ ] Every P2 finding is incorporated or deferred with rationale
- [ ] All open questions are resolved
- [ ] No \`review\` fields remain on any step
- [ ] No \`openQuestions\` field at the top level
- [ ] Every behavioralContract assertion is claimed by exactly one step
- [ ] Steps are ordered so dependencies flow forward
- [ ] Valid JSON — no trailing commas, no comments

${renderHandoffInstruction(PLAN_CONSOLIDATE_FIELDS, handoffPath)}`;
}

function buildPlanResearchScaffolding(handoffPath: string): string {
  return `---
## Output Requirements

${renderHandoffInstruction(PLAN_RESEARCH_FIELDS, handoffPath)}`;
}

// ---------------------------------------------------------------------------
// Non-plan step scaffolding builders
// ---------------------------------------------------------------------------

function buildWorkScaffolding(handoffPath: string): string {
  return `---
## Output Requirements

${renderHandoffInstruction(WORK_STEP_FIELDS, handoffPath)}`;
}

function buildReviewScaffolding(handoffPath: string): string {
  return `---
## Output Requirements

${renderHandoffInstruction(REVIEW_FIELDS, handoffPath)}`;
}

function buildSprintVerifyScaffolding(handoffPath: string): string {
  return `---
## Output Requirements

${renderHandoffInstruction(SPRINT_FIELDS, handoffPath)}`;
}

function buildShipScaffolding(handoffPath: string): string {
  return `---
## Output Requirements

${renderHandoffInstruction(SHIP_FIELDS, handoffPath)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build deterministic scaffolding to append after the dispatcher's task_content.
 *
 * Returns the appropriate output format instructions and handoff writing
 * instructions based on the step's type and role. Gate steps return empty string.
 *
 * @param step       The queue step being executed
 * @param handoffPath Path where the worker should write its handoff JSON
 * @param _projectCwd Project working directory (reserved for future use)
 * @returns Scaffolding string to append, or empty string for gate steps
 */
export function buildScaffolding(
  step: Step,
  handoffPath: string,
  _projectCwd: string,
): string {
  // Gate steps need no scaffolding
  if (step.type === "gate") return "";

  // Plan steps have sub-roles
  if (step.type === "plan") {
    const role = detectPlanRole(step);
    switch (role) {
      case "draft":
        return buildPlanDraftScaffolding(handoffPath);
      case "review":
        return buildPlanReviewScaffolding(handoffPath);
      case "consolidate":
        return buildPlanConsolidateScaffolding(handoffPath);
      case "research":
        return buildPlanResearchScaffolding(handoffPath);
    }
  }

  // Work steps
  if (step.type === "work") {
    return buildWorkScaffolding(handoffPath);
  }

  // Review steps
  if (step.type === "review") {
    return buildReviewScaffolding(handoffPath);
  }

  // Verify steps (sprint mode)
  if (step.type === "verify") {
    return buildSprintVerifyScaffolding(handoffPath);
  }

  // Ship steps
  if (step.type === "ship") {
    return buildShipScaffolding(handoffPath);
  }

  // Debug / research steps — use work step fields as reasonable default
  if (step.type === "debug" || step.type === "research") {
    return buildWorkScaffolding(handoffPath);
  }

  return "";
}
