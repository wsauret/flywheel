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
//
// NOTE: Sprint work/revision steps bypass this entire pipeline. The sprint
// handler builds their prompts from scratch via buildSprintStepPrompt() and
// buildSprintRevisionPrompt() (in queue/prompts/sprint-step.ts and
// sprint-revision.ts), using WorkflowStepContext instead of StepContext.
// See queue/prompts/types.ts for why the two architectures coexist.
// ---------------------------------------------------------------------------

import type { Step, StepType } from "./types";
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
  REVIEW_DISPATCH_FIELDS,
  REVIEW_CONSOLIDATE_FIELDS,
  SHIP_COMMIT_FIELDS,
  SHIP_LEARNINGS_FIELDS,
  DEBUG_INVESTIGATE_FIELDS,
  DEBUG_FIX_FIELDS,
  DEBUG_VERIFY_FIELDS,
  RESEARCH_FIELDS,
} from "../handoff/field-specs.js";
import {
  REVIEWER_DISPATCH_INSTRUCTIONS,
  FINDING_SYNTHESIS_INSTRUCTIONS,
  REVIEW_OUTPUT_FORMAT,
} from "./prompts/review-dispatch.js";
import {
  CONSOLIDATION_INSTRUCTIONS,
  REVIEW_DOC_TEMPLATE,
} from "./prompts/review-consolidate.js";
import {
  NO_AI_ATTRIBUTION_RULE,
  STAGING_RULES,
  PR_FORMAT,
  BRANCH_NAMING,
} from "./prompts/ship.js";
import {
  COMPOUND_DOC_FORMAT,
  COMPOUND_DEDUP_RULES,
} from "./prompts/ship-compound.js";
import {
  INVESTIGATION_METHODOLOGY,
  FIX_LOOP_RULES,
  FIX_ITERATION_TEMPLATE,
  ESCALATION_FORMAT,
  RESOLUTION_FORMAT,
} from "./prompts/debug.js";
import { LOCATOR_DISPATCH_INSTRUCTIONS } from "./prompts/research-locate.js";
import { ANALYZER_DISPATCH_INSTRUCTIONS } from "./prompts/research-analyze.js";
import { AGENT_DISCOVERY_PHASE } from "./prompts/conventions.js";
import {
  RESEARCH_DOC_TEMPLATE,
  RESEARCH_PERSISTENCE_INSTRUCTIONS,
} from "./prompts/research-persist.js";


// ---------------------------------------------------------------------------
// Generic role detection
// ---------------------------------------------------------------------------

interface RoleMapping<R extends string> {
  /** Map from dispatcherHint value to role. */
  hintMap: Record<string, R>;
  /** Map from title keyword to role. Title is lowercased before lookup. */
  titleMap: [keyword: string, role: R][];
  /** Default role when no match found. */
  defaultRole: R;
}

function detectRole<R extends string>(step: Step, mapping: RoleMapping<R>): R {
  const hint = step.dispatcherHint?.toLowerCase();
  if (hint && hint in mapping.hintMap) {
    return mapping.hintMap[hint];
  }

  const title = step.title.toLowerCase();
  for (const [keyword, role] of mapping.titleMap) {
    if (title.includes(keyword)) return role;
  }

  return mapping.defaultRole;
}

// Per-type role mappings
type PlanRole = "research" | "draft" | "review" | "consolidate";

const PLAN_ROLE_MAPPING: RoleMapping<PlanRole> = {
  hintMap: { draft: "draft", review: "review", consolidate: "consolidate", research: "research" },
  titleMap: [["draft", "draft"], ["review plan", "review"], ["review", "review"], ["consolidate", "consolidate"]],
  defaultRole: "research",
};

type ReviewRole = "dispatch" | "consolidate";
const REVIEW_ROLE_MAPPING: RoleMapping<ReviewRole> = {
  hintMap: { "dispatch-reviewers": "dispatch", "consolidate-review": "consolidate" },
  titleMap: [["dispatch", "dispatch"], ["multi-agent", "dispatch"], ["consolidate", "consolidate"]],
  defaultRole: "dispatch",
};

type ShipRole = "ship" | "learnings";
const SHIP_ROLE_MAPPING: RoleMapping<ShipRole> = {
  hintMap: { ship: "ship", stage: "ship", commit: "ship", pr: "ship", learnings: "learnings" },
  titleMap: [["learning", "learnings"], ["compound", "learnings"], ["extract", "learnings"]],
  defaultRole: "ship",
};

type DebugRole = "investigate" | "fix" | "verify";
const DEBUG_ROLE_MAPPING: RoleMapping<DebugRole> = {
  hintMap: { investigate: "investigate", fix: "fix", "debug-verify": "verify" },
  titleMap: [["investigate", "investigate"], ["fix", "fix"], ["verify", "verify"]],
  defaultRole: "investigate",
};

/**
 * Detect the sub-role of a plan step.
 * Thin wrapper around the generic detectRole for backward compatibility.
 */
function detectPlanRole(step: Step): PlanRole {
  return detectRole(step, PLAN_ROLE_MAPPING);
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

function buildPlanDraftScaffolding(handoffPath: string, planOutputPath?: string): string {
  const planPath = planOutputPath ?? "plan.json";
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

function buildPlanReviewScaffolding(handoffPath: string): ScaffoldingResult {
  const preamble = `## YOUR PRIMARY TASK: Dispatch Reviewer Agents

${AGENT_DISCOVERY_PHASE}

After discovering agents, dispatch ALL of the following reviewer agents **in parallel** using the Task tool.
Launch ALL of them in a SINGLE message with multiple Task calls. Do NOT skip any.
Do NOT do the review yourself — delegate to these specialized agents.

### Agents (pre-installed, use \`subagent_type\` to reference each)

1. **fly/reviewer-architecture** — Layering violations, coupling, SOLID compliance, pattern inconsistencies.
2. **fly/reviewer-code-quality** — Type safety, testability, naming, duplication, logic errors.
3. **fly/reviewer-patterns** — Design patterns, anti-patterns, naming conventions, code duplication.
4. **fly/reviewer-performance** — Algorithmic complexity, queries, memory, caching, scalability.
5. **fly/reviewer-data-integrity** — Migration safety, constraints, transactions. Skip if not applicable.
6. **fly/reviewer-plan-philosophy** — TDD ordering, SOLID compliance in planned design, DRY compliance.

### How to Dispatch

For EACH reviewer, call the Task tool with the reviewer's name as subagent_type and the full plan JSON in the prompt:

\`\`\`
Task(subagent_type="fly/reviewer-architecture", prompt="Review this plan for architectural concerns.\\nPLAN:\\n[paste the full plan JSON here]\\nProvide findings with priority (P1/P2/P3) and specific step references.\\nIMPORTANT: Return ALL findings in your response only. Do NOT write to any files.")
\`\`\`

Launch ALL 6 Task calls in a SINGLE response message so they run in parallel.
After all reviewers respond, merge their findings into the annotated JSON output described below.

If a finding from one reviewer contradicts another, add it as an open question with both positions.

---`;

  const postamble = `---
## Output Requirements

After all reviewer agents respond, merge their findings and produce annotated JSON.
Read the original JSON plan and produce a new JSON document that:
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

  return { preamble, postamble };
}

function buildPlanConsolidateScaffolding(handoffPath: string, planOutputPath?: string): string {
  const planPath = planOutputPath ?? "plan.json";
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

### Synthesis Principles

1. **Merge findings INTO steps.** Review findings belong in the step's description and acceptanceCriteria.
2. **P1 findings are mandatory.** Every P1 must be incorporated.
3. **P2 findings are strongly recommended.** Incorporate unless deferred with rationale.
4. **P3 findings are optional.** Incorporate useful ones, defer others.
5. **Resolve ALL open questions.** Document rationale in decisions.
6. **Preserve test-first intent.** acceptanceCriteria should be testable.
7. **No orphaned assertions.** Every behavioralContract assertion must be claimed by exactly one step.
8. **Each step = one subprocess (context-clearing boundary).** Every step spawns an independent AI worker with a blank context window. Split only when clearing context helps (e.g., fresh perspective for unrelated work). Keep activities in the same step when they need awareness of what was just done (running tests, auditing related code, smoke-testing) — losing context forces the worker to rediscover everything.

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

function buildPlanResearchScaffolding(handoffPath: string): ScaffoldingResult {
  const preamble = `## YOUR PRIMARY TASK: Dispatch Locator and Analyzer Agents

${AGENT_DISCOVERY_PHASE}

After discovering agents, follow this two-phase dispatch pattern:

**Phase 1 — Locators (parallel):** Dispatch ALL 3 locator agents in a SINGLE message with multiple Task calls. They find WHERE things are.
**Phase 1b — Rank:** Deduplicate and rank locator results. Select top findings for analyzers.
**Phase 2 — Analyzers (parallel):** Dispatch analyzer agents on TOP FINDINGS ONLY in a SINGLE message.

Do NOT do the research yourself — delegate to these specialized agents.

### Locator Agents (pre-installed, use \`subagent_type\` to reference each)

1. **fly/locator-codebase** — Finds implementation files, tests, configs, types, docs.
2. **fly/locator-patterns** — Finds file:line references for specific patterns, imports, APIs.
3. **fly/locator-docs** — Finds README, AGENTS.md, docs/, inline documentation.

### Analyzer Agents (pre-installed, use \`subagent_type\` to reference each)

1. **fly/analyzer-codebase** — Reads files, documents function signatures, data flow, error handling.
2. **fly/analyzer-patterns** — Extracts code examples with context, caller usage, constraints.

### How to Dispatch Locators

Launch ALL 3 in a SINGLE response message:

\`\`\`
Task(subagent_type="fly/locator-codebase", prompt="Find WHERE files and components live related to: [topic]. Return file paths only, max 30 paths.")
Task(subagent_type="fly/locator-patterns", prompt="Find WHERE specific patterns exist related to: [topic]. Return file:line references only, max 30 locations.")
Task(subagent_type="fly/locator-docs", prompt="Find WHERE documentation lives related to: [topic]. Return paths only. Max 20 paths.")
\`\`\`

### How to Dispatch Analyzers (after ranking locator results)

Launch both in a SINGLE response message:

\`\`\`
Task(subagent_type="fly/analyzer-codebase", prompt="Analyze these files related to [topic]:\\n[top 15 file paths]\\nDocument function signatures, data flow, error handling. File:line references required. Documentarian mode — do NOT suggest improvements.")
Task(subagent_type="fly/analyzer-patterns", prompt="Analyze these patterns related to [topic]:\\n[top 10 file:line refs]\\nFor each: exact code, caller usage, constraints. File:line references required. Documentarian mode — do NOT suggest alternatives.")
\`\`\`

---`;

  const postamble = `---
## Output Requirements

${renderHandoffInstruction(PLAN_RESEARCH_FIELDS, handoffPath)}`;

  return { preamble, postamble };
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

function buildReviewDispatchScaffolding(handoffPath: string): ScaffoldingResult {
  const preamble = `## YOUR PRIMARY TASK: Dispatch Review Agents

${AGENT_DISCOVERY_PHASE}

${REVIEWER_DISPATCH_INSTRUCTIONS}

${FINDING_SYNTHESIS_INSTRUCTIONS}

${REVIEW_OUTPUT_FORMAT}

---`;

  const postamble = `---
## Output Requirements

${renderHandoffInstruction(REVIEW_DISPATCH_FIELDS, handoffPath)}`;

  return { preamble, postamble };
}

function buildReviewConsolidateScaffolding(handoffPath: string, reviewPath?: string): ScaffoldingResult {
  const path = reviewPath ?? "review.md";
  const postamble = `---
## Output Requirements

${CONSOLIDATION_INSTRUCTIONS}

${REVIEW_DOC_TEMPLATE}

## IMPORTANT: Write the review document

Write the final review document to:
\`${path}\`

Also persist a copy to \`docs/reviews/\` with a date-prefixed filename (e.g., \`docs/reviews/YYYY-MM-DD-<slug>.md\`).
Create the parent directory if it does not exist.

${renderHandoffInstruction(REVIEW_CONSOLIDATE_FIELDS, handoffPath)}`;

  return { preamble: "", postamble };
}

function buildShipCommitScaffolding(handoffPath: string): string {
  return `---
## Output Requirements

${NO_AI_ATTRIBUTION_RULE}

${BRANCH_NAMING}

${STAGING_RULES}

${PR_FORMAT}

${renderHandoffInstruction(SHIP_COMMIT_FIELDS, handoffPath)}`;
}

function buildShipLearningsScaffolding(handoffPath: string): string {
  return `---
## Output Requirements

${COMPOUND_DOC_FORMAT}

${COMPOUND_DEDUP_RULES}

${renderHandoffInstruction(SHIP_LEARNINGS_FIELDS, handoffPath)}`;
}

function buildDebugInvestigateScaffolding(handoffPath: string): ScaffoldingResult {
  const preamble = `## Investigation Phase

${INVESTIGATION_METHODOLOGY}

---`;

  const postamble = `---
## Output Requirements

${renderHandoffInstruction(DEBUG_INVESTIGATE_FIELDS, handoffPath)}`;

  return { preamble, postamble };
}

function buildDebugFixScaffolding(handoffPath: string): string {
  return `---
## Fix Phase

${FIX_LOOP_RULES}

${FIX_ITERATION_TEMPLATE}

${renderHandoffInstruction(DEBUG_FIX_FIELDS, handoffPath)}`;
}

function buildDebugVerifyScaffolding(handoffPath: string): string {
  return `---
## Verification Phase

${RESOLUTION_FORMAT}

${ESCALATION_FORMAT}

${renderHandoffInstruction(DEBUG_VERIFY_FIELDS, handoffPath)}`;
}

function buildResearchFullScaffolding(handoffPath: string, researchPath?: string): ScaffoldingResult {
  const path = researchPath ?? "research.md";
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
\`${path}\`

${RESEARCH_DOC_TEMPLATE}

${renderHandoffInstruction(RESEARCH_FIELDS, handoffPath)}`;

  return { preamble, postamble };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scaffolding result: preamble goes BEFORE dispatcher task_content,
 * postamble goes AFTER. This ensures workflow-critical instructions
 * (like "dispatch these agents") take priority over the dispatcher's
 * contextual framing.
 */
export interface ScaffoldingResult {
  /** Placed before dispatcher task_content. Workflow method instructions. */
  preamble: string;
  /** Placed after dispatcher task_content. Output format + handoff instructions. */
  postamble: string;
}

/**
 * Paths that scaffolding needs for session-scoped output instructions.
 * Computed once by the caller (flywheel-shell) and threaded through.
 */
export interface ScaffoldingPaths {
  /** Where the worker writes its handoff JSON */
  handoffPath: string;
  /** Where the plan JSON should be written (e.g., `.flywheel/sessions/<id>/plan.json`) */
  planPath?: string;
  /** Where the research doc should be written (e.g., `.flywheel/sessions/<id>/research.md`) */
  researchPath?: string;
  /** Where the review doc should be written (e.g., `.flywheel/sessions/<id>/review.md`) */
  reviewPath?: string;
}

// ---------------------------------------------------------------------------
// Strategy map — replaces if/else chain with lookup table
// ---------------------------------------------------------------------------

type ScaffoldingStrategy = (step: Step, paths: ScaffoldingPaths) => ScaffoldingResult;

const SCAFFOLDING_STRATEGIES: Map<StepType, ScaffoldingStrategy> = new Map([
  ["gate", () => ({ preamble: "", postamble: "" })],
  ["plan", (step: Step, paths: ScaffoldingPaths) => {
    const role = detectPlanRole(step);
    const wrap = (postamble: string): ScaffoldingResult => ({ preamble: "", postamble });
    switch (role) {
      case "draft": return wrap(buildPlanDraftScaffolding(paths.handoffPath, paths.planPath));
      case "review": return buildPlanReviewScaffolding(paths.handoffPath);
      case "consolidate": return wrap(buildPlanConsolidateScaffolding(paths.handoffPath, paths.planPath));
      case "research": return buildPlanResearchScaffolding(paths.handoffPath);
    }
  }],
  ["work", (_step: Step, paths: ScaffoldingPaths) => ({ preamble: "", postamble: buildWorkScaffolding(paths.handoffPath) })],
  ["review", (step: Step, paths: ScaffoldingPaths) => {
    const role = detectRole(step, REVIEW_ROLE_MAPPING);
    switch (role) {
      case "dispatch": return buildReviewDispatchScaffolding(paths.handoffPath);
      case "consolidate": return buildReviewConsolidateScaffolding(paths.handoffPath, paths.reviewPath);
    }
  }],
  ["verify", (_step: Step, paths: ScaffoldingPaths) => ({ preamble: "", postamble: buildSprintVerifyScaffolding(paths.handoffPath) })],
  ["ship", (step: Step, paths: ScaffoldingPaths) => {
    const role = detectRole(step, SHIP_ROLE_MAPPING);
    const wrap = (postamble: string): ScaffoldingResult => ({ preamble: "", postamble });
    switch (role) {
      case "ship": return wrap(buildShipCommitScaffolding(paths.handoffPath));
      case "learnings": return wrap(buildShipLearningsScaffolding(paths.handoffPath));
    }
  }],
  ["debug", (step: Step, paths: ScaffoldingPaths) => {
    const role = detectRole(step, DEBUG_ROLE_MAPPING);
    const wrap = (postamble: string): ScaffoldingResult => ({ preamble: "", postamble });
    switch (role) {
      case "investigate": return buildDebugInvestigateScaffolding(paths.handoffPath);
      case "fix": return wrap(buildDebugFixScaffolding(paths.handoffPath));
      case "verify": return wrap(buildDebugVerifyScaffolding(paths.handoffPath));
    }
  }],
  ["research", (_step: Step, paths: ScaffoldingPaths) => buildResearchFullScaffolding(paths.handoffPath, paths.researchPath)],
]);

/**
 * Build deterministic scaffolding around the dispatcher's task_content.
 *
 * Returns preamble (before) and postamble (after) strings. Gate steps
 * return empty for both.
 *
 * All paths are provided by the caller — this module never computes paths.
 */
export function buildScaffolding(
  step: Step,
  paths: ScaffoldingPaths,
): ScaffoldingResult {
  const strategy = SCAFFOLDING_STRATEGIES.get(step.type as StepType);
  if (!strategy) return { preamble: "", postamble: "" };
  return strategy(step, paths);
}
