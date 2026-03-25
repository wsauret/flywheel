import type { WorkflowStepContext } from "../index.js";
import { renderHandoffInstruction, SHIP_FIELDS } from "../../handoff/field-specs.js";
import { DEFAULT_SOLUTIONS_DIR } from "../../config/paths.js";

export const shipCompoundValidationCriteria =
  "Learnings document created with categorized insights, or explicit statement that no significant learnings apply";

/**
 * Builds a prompt for the compound learning extraction step of the ship workflow.
 *
 * Instructs the worker to:
 *   1. Reflect on implementation learnings
 *   2. Identify reusable solutions
 *   3. Output compound docs in the standard frontmatter format
 *
 * The output is parsed by the ship onStepComplete hook to extract and persist learnings.
 */
export function buildShipCompoundPrompt(ctx: WorkflowStepContext): string {
  return `# Ship — Extract Learnings

## Changes Shipped

${ctx.planContent}

${ctx.projectCwd ? `## Working Directory\n\n\`${ctx.projectCwd}\`` : ""}

---

## Objective

Reflect on the implementation you just shipped. Identify any **reusable solutions, patterns, or gotchas** that would help future work in this codebase.

For each learning, output a compound doc block in the exact format below.

## Target Directory

Write compound docs to \`${DEFAULT_SOLUTIONS_DIR}/\`.

**Before writing, check for existing solutions** in that directory. If a solution already covers the same problem, do NOT write a duplicate.

## Compound Doc Format

Each compound doc MUST use this exact YAML frontmatter format:

\`\`\`
---
type: compound
title: "<descriptive title>"
tags: [<relevant, searchable, tags>]
date: "<YYYY-MM-DD>"
extraction_hash: "<SHA-256 of canonical JSON: {problem, solution, tags, title}>"
---

## Problem
<what problem was encountered>

## Solution
<how it was solved>

## Context
<when this solution applies>
\`\`\`

### Field Rules

- **title**: Short, descriptive. Should be searchable (e.g. "Fix Docker volume permissions on macOS").
- **tags**: Array of lowercase, hyphenated keywords. At least 1 tag. Include the technology, pattern, and domain (e.g. \`[docker, macos, volume-permissions]\`).
- **date**: Today's date in \`YYYY-MM-DD\` format.
- **extraction_hash**: SHA-256 hex digest of the canonical JSON string \`JSON.stringify({ problem, solution, tags, title })\` where keys are sorted alphabetically, values are trimmed, and tags are sorted.
- **Problem**: 1-3 sentences describing the specific problem encountered.
- **Solution**: The concrete fix or pattern. Include code snippets if helpful.
- **Context**: When this solution applies — environment, versions, constraints.

## Dedup

The \`extraction_hash\` field ensures identical learnings are never written twice. If you identify a learning that already exists in \`${DEFAULT_SOLUTIONS_DIR}/\` (same problem + solution), skip it.

## Output Rules

- Output each compound doc as a complete markdown block with frontmatter delimiters (\`---\`).
- If there are no learnings worth extracting, output: "No new learnings to extract."
- Do NOT output partial docs or docs missing required fields.
- Focus on learnings that are **reusable across sessions** — not one-off debugging steps.
${ctx.extra?.handoffPath ? `\n${renderHandoffInstruction(SHIP_FIELDS, ctx.extra.handoffPath as string)}` : ""}
`;
}
