import { DRAFT_JSON_EXAMPLE } from "../../shared/plan-schemas";

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

export { DRAFT_JSON_EXAMPLE };
