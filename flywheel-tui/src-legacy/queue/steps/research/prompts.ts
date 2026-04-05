import { LOCATOR_DISPATCH_INSTRUCTIONS, ANALYZER_DISPATCH_INSTRUCTIONS } from "../../shared/prompts";

// ---------------------------------------------------------------------------
// Research persist — reusable constants for prompt scaffolding
// ---------------------------------------------------------------------------


export const researchPersistEvaluationCriteria =
  "Comprehensive research document persisted with findings and source references";

// ---------------------------------------------------------------------------
// Reusable prompt constants
// ---------------------------------------------------------------------------

export const RESEARCH_PREAMBLE = `## YOUR PRIMARY TASK: Research via Locator-Analyzer Pattern

You will execute a three-phase research process within a single worker context:

**Phase 1 — Locate:** Dispatch 4 locator agents in parallel to find relevant files, patterns, docs, and web resources.
**Phase 2 — Analyze:** Rank and deduplicate locator results, then dispatch analyzer agents on top findings.
**Phase 3 — Persist:** Compile findings into a comprehensive research document.

${LOCATOR_DISPATCH_INSTRUCTIONS}

After ranking locator results:

${ANALYZER_DISPATCH_INSTRUCTIONS}`;

/** Research document template with YAML frontmatter. */
export const RESEARCH_DOC_TEMPLATE = `## Document Template

The research document MUST include the following YAML frontmatter and sections:

\`\`\`markdown
---
type: research
date: <ISO date>
topic: "<Research Topic>"
status: complete
tags: [research, <relevant-tags>]
---

# Research: <Topic>

## Research Question

<Original research topic/question>

## Summary

<High-level findings synthesized from all analysis — 3-5 sentences>

## Detailed Findings

### <Component/Area 1>

<Findings with file:line references>

### <Component/Area 2>

<Additional findings with file:line references>

### <More areas as needed>

## Code References

| File | Lines | Description |
|------|-------|-------------|
| \`path/to/file.ts\` | 42-67 | <what this code does> |
| \`path/to/other.ts\` | 15-30 | <what this code does> |

## Patterns Identified

- **<Pattern Name>**: \`file.ts:42-67\` — <description of the pattern>
- **<Pattern Name>**: \`other.ts:89-120\` — <description of the pattern>

## Open Questions

- <Question needing further investigation>
- <Uncertainty about scope or behavior>
\`\`\`

## Code Block Rule

Keep ALL code blocks under 15 lines. If a listing (directory tree, code excerpt, etc.) exceeds 15 lines, split it into multiple smaller blocks or use inline \`file:line\` references instead.

## Quality Requirements

- The document is comprehensive — no artificial token limits on the output
- Use file:line references throughout, not full code reproductions
- Maintain documentarian mode: describe what IS, never what ought to change
- The Summary section must be 3-5 sentences synthesizing all findings
- The Code References table must include at least 5 unique file:line references
- Every Detailed Findings subsection must cite specific file:line references
- Avoid prescriptive language (do not use "should", "recommend", "suggest", "consider" outside of Open Questions)`;

/** Research persistence instructions (path + directory creation). */
export const RESEARCH_PERSISTENCE_INSTRUCTIONS = `## Persistence Instructions

Write the research document to:`;
