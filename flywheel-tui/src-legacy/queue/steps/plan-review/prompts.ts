import { AGENT_DISCOVERY_PHASE } from "../../shared/prompts";

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

export const PLAN_REVIEW_DISPATCH_PREAMBLE = `## YOUR PRIMARY TASK: Dispatch Reviewer Agents

${AGENT_DISCOVERY_PHASE}

After discovering agents, dispatch ALL of the following reviewer agents **in parallel** using the Task tool.
Launch ALL of them in a SINGLE message with multiple Task calls. Do NOT skip any.
Do NOT do the review yourself — delegate to these specialized agents.

### Agents (use the prefix discovered in Phase 0, match by base name)

1. **reviewer-architecture** — Layering violations, coupling, SOLID compliance, pattern inconsistencies.
2. **reviewer-code-quality** — Type safety, testability, naming, duplication, logic errors.
3. **reviewer-patterns** — Design patterns, anti-patterns, naming conventions, code duplication.
4. **reviewer-performance** — Algorithmic complexity, queries, memory, caching, scalability.
5. **reviewer-data-integrity** — Migration safety, constraints, transactions. Skip if not applicable.
6. **reviewer-plan-philosophy** — TDD ordering, SOLID compliance in planned design, DRY compliance.

### How to Dispatch

For EACH reviewer, call the Task tool with the discovered subagent_type (including prefix) and the full plan JSON in the prompt:

\`\`\`
Task(subagent_type="<PREFIX>/reviewer-architecture", prompt="Review this plan for architectural concerns.\\nPLAN:\\n[paste the full plan JSON here]\\nProvide findings with priority (P1/P2/P3) and specific step references.\\nIMPORTANT: Return ALL findings in your response only. Do NOT write to any files.")
\`\`\`

Launch ALL 6 Task calls in a SINGLE response message so they run in parallel.
After all reviewers respond, merge their findings into the annotated JSON output described below.

If a finding from one reviewer contradicts another, add it as an open question with both positions.`;

export const PLAN_REVIEW_ANNOTATION_RULES = `### Annotated JSON Structure

\`\`\`json
${ANNOTATED_JSON_EXAMPLE}
\`\`\`

### Critical Rules

1. **NEVER modify draft-authored fields.** The \`title\`, \`description\`, \`acceptanceCriteria\`, \`fileReferences\`, \`feature\`, \`fulfills\`, \`milestone\`, \`estimatedComplexity\`, \`behavioralContract\`, \`decisions\`, and \`risks\` fields must be EXACTLY as they were in the original plan.
2. **Only add \`review\` and \`openQuestions\`.** These are the only fields the review step may add.
3. **Omit \`review\` on steps with no findings.**
4. **openQuestions is always present.** Even if empty, include \`"openQuestions": []\`.
5. **Findings use severity P1/P2/P3.** P1 = critical, P2 = important, P3 = minor.`;
