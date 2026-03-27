import type { WorkflowStepContext } from "../index.js";
import { SEVERITY_DEFINITIONS, SCOPE_DISCIPLINE } from "../conventions.js";
import type {
  OpenQuestion,
  ResolvedQuestion,
} from "../../controller/question-service.js";
import { renderHandoffInstruction, PLAN_CONSOLIDATE_FIELDS } from "../../handoff/field-specs.js";
import { DEFAULT_PLANS_DIR } from "../../config/paths.js";

/**
 * Format a single resolved question as a readable line.
 */
function formatResolvedQuestion(q: ResolvedQuestion, index: number): string {
  const answers = q.answers.length > 0 ? q.answers.join(", ") : "_no answer_";
  return `${index + 1}. ${q.question} → ${answers} (source: ${q.source})`;
}

/**
 * Format a single unresolved question with its options.
 */
function formatUnresolvedQuestion(q: OpenQuestion, index: number): string {
  const optionsList =
    q.options.length > 0
      ? q.options.map((o) => `   - ${o.label}${o.description ? `: ${o.description}` : ""}`).join("\n")
      : "   _(no predefined options)_";
  return `${index + 1}. ${q.question}\n${optionsList}`;
}

/**
 * Build the questions section of the consolidation prompt.
 *
 * Two mutually exclusive payloads:
 *   - `resolvedQuestions` → user answered interactively ("## Decisions Made")
 *   - `unresolvedQuestions` + `questionDirective` → forwarded for AI resolution
 *     ("## Open Questions to Resolve")
 */
function buildQuestionsSection(extra: Record<string, unknown> | undefined): string {
  // Path 1: User-resolved questions
  const resolved = extra?.resolvedQuestions;
  if (resolved && Array.isArray(resolved) && resolved.length > 0) {
    const lines = (resolved as ResolvedQuestion[])
      .map((q, i) => formatResolvedQuestion(q, i))
      .join("\n");
    return `## Decisions Made\n\n${lines}`;
  }

  // Path 2: Unresolved questions forwarded with directive
  const unresolved = extra?.unresolvedQuestions;
  if (unresolved && Array.isArray(unresolved) && unresolved.length > 0) {
    const lines = (unresolved as OpenQuestion[])
      .map((q, i) => formatUnresolvedQuestion(q, i))
      .join("\n\n");
    return `## Open Questions to Resolve

Resolve each question using your best judgment from the review findings. Document your rationale.

${lines}`;
  }

  // No questions at all
  return `## Resolved Open Questions\n\n_No open questions._`;
}

export const planConsolidateEvaluationCriteria =
  `Clean JSON plan written to ${DEFAULT_PLANS_DIR}/ with review findings merged, all P1 addressed, no review annotations remaining`;

/**
 * Builds a prompt for consolidating a reviewed JSON plan into a final clean JSON plan.
 *
 * The worker reads annotated JSON (with review.findings[] on steps and openQuestions[]),
 * merges P1/P2 findings into step content, resolves open questions, strips all review
 * annotations, and writes clean JSON to .flywheel/plans/<name>.plan.json.
 */
export function buildPlanConsolidatePrompt(ctx: WorkflowStepContext): string {
  const questionsSection = buildQuestionsSection(ctx.extra);

  return `# Plan Consolidation

## Annotated JSON Plan

The following JSON plan has been reviewed. Steps may contain \`review.findings[]\` annotations. There may be \`openQuestions[]\` at the top level.

\`\`\`json
${ctx.planContent}
\`\`\`

${questionsSection}

---

${SEVERITY_DEFINITIONS}

${SCOPE_DISCIPLINE}

## Consolidation Task

Produce a CLEAN JSON plan that:
1. Incorporates all P1 and P2 findings into the step content (update description, acceptanceCriteria, fileReferences as needed)
2. Resolves all open questions (document resolutions in \`decisions[]\`)
3. Strips all \`review\` annotations from steps
4. Strips the \`openQuestions\` array
5. Updates \`decisions[]\` to include any new decisions from review findings or question resolutions
6. Updates \`risks[]\` to include any new risks from review findings

Write the final clean JSON to:
\`${DEFAULT_PLANS_DIR}/<type>-<description>.plan.json\`

This should overwrite the annotated version at the same path.

Where \`<type>\` is one of: feat, fix, refactor, chore, docs
And \`<description>\` is a short kebab-case name for the feature.

Create the \`${DEFAULT_PLANS_DIR}/\` directory if it does not exist.

### Output Schema

The final JSON must match the draft schema exactly — no review annotations:

\`\`\`json
${CLEAN_JSON_EXAMPLE}
\`\`\`

### Synthesis Principles

1. **Merge findings INTO steps.** Review findings belong in the relevant step's description and acceptanceCriteria, not floating separately.
   - BAD: Step description unchanged + separate note about JWT expiry
   - GOOD: Step description updated to mention "15-min JWT expiry (per security review)" and acceptanceCriteria updated with "JWT tokens expire after 15 minutes"

2. **P1 findings are mandatory.** Every P1 finding must be incorporated. If a P1 cannot be incorporated into an existing step, add a new step.

3. **P2 findings are strongly recommended.** Incorporate unless there's a clear reason to defer (document rationale in decisions).

4. **P3 findings are optional.** Incorporate the useful ones, note deferred ones in decisions.

5. **Resolve ALL open questions.** Use user answers if provided (see Decisions Made section above). Otherwise, use your best judgment and document rationale in decisions.

6. **Preserve test-first intent.** acceptanceCriteria should be testable. fileReferences should include test files.

7. **No orphaned assertions.** Every behavioralContract assertion must be claimed by exactly one step's fulfills. If review findings suggest a new assertion, add it to behavioralContract AND add it to the relevant step's fulfills.

### Quality Checks

Before finalizing, verify:
- [ ] Every P1 finding is incorporated into a step
- [ ] Every P2 finding is incorporated or deferred with rationale
- [ ] All open questions are resolved
- [ ] No \`review\` fields remain on any step
- [ ] No \`openQuestions\` field at the top level
- [ ] Every behavioralContract assertion is claimed by exactly one step
- [ ] Steps are ordered so dependencies flow forward
- [ ] All decisions (original + new) are listed
- [ ] Valid JSON — no trailing commas, no comments
${ctx.extra?.handoffPath ? `\n${renderHandoffInstruction(PLAN_CONSOLIDATE_FIELDS, ctx.extra.handoffPath as string)}` : ""}
`;
}

// ---------------------------------------------------------------------------
// Clean JSON example (kept as constant for clarity and testability)
// ---------------------------------------------------------------------------

const CLEAN_JSON_EXAMPLE = `{
  "steps": [
    {
      "title": "Create server module with Bun.serve()",
      "description": "Implement GET /hello endpoint returning JSON {greeting, timestamp}. Bind to 127.0.0.1:3000 (per security review). Use Bun.serve() API with fetch handler.",
      "acceptanceCriteria": [
        "GET /hello returns 200 with JSON body containing greeting and timestamp",
        "Server binds to 127.0.0.1:3000 (not 0.0.0.0)",
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
      "evidence": "curl http://localhost:3000/hello returns 200 with greeting and timestamp fields",
      "area": "Server"
    }
  ],
  "decisions": [
    "Using Bun.serve() native API instead of Express for zero-dependency server",
    "Bind to 127.0.0.1 instead of 0.0.0.0 per security review"
  ],
  "risks": [
    "Port 3000 may conflict with other services"
  ]
}`;
