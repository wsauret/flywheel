// ---------------------------------------------------------------------------
// Ship compound — reusable constants for prompt scaffolding
// ---------------------------------------------------------------------------

import { DEFAULT_SOLUTIONS_DIR } from "../../../config/paths.js";

export const shipCompoundEvaluationCriteria =
  "Learnings document created with categorized insights, or explicit statement that no significant learnings apply";

// ---------------------------------------------------------------------------
// Reusable prompt constants
// ---------------------------------------------------------------------------

/** Compound doc format with YAML frontmatter template. */
export const COMPOUND_DOC_FORMAT = `## Compound Doc Format

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
- **Context**: When this solution applies — environment, versions, constraints.`;

/** Dedup rules for compound docs. */
export const COMPOUND_DEDUP_RULES = `## Dedup

The \`extraction_hash\` field ensures identical learnings are never written twice. If you identify a learning that already exists in \`${DEFAULT_SOLUTIONS_DIR}/\` (same problem + solution), skip it.`;
