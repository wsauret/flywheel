# Todo File Format — Full Reference

This reference contains the naming convention, YAML frontmatter structure, and required sections for review finding todo files.

## File Naming Convention

**Pattern:** `{issue_id}-pending-{priority}-{description}.md`

**Examples:**
```
001-pending-p1-path-traversal-vulnerability.md
002-pending-p2-concurrency-limit.md
003-pending-p3-unused-parameter.md
```

## Required Structure

Each todo file must include:

### YAML Frontmatter

```yaml
---
status: pending
priority: p1|p2|p3
issue_id: "001"
tags:
  - code-review
  - security|performance|architecture|quality
dependencies: []
---
```

### Problem Statement

What is broken or missing, and why it matters. Include severity justification.

### Findings

Discoveries with evidence and location. Always include specific `file:line` references.

### Proposed Solutions

Provide 2-3 options with:
- Description of the approach
- Pros and cons
- Estimated effort (Small / Medium / Large)

### Acceptance Criteria

Testable checklist items that confirm the finding is resolved.

### Work Log

Initial entry with the review date.

## Tagging

**Always tag:** `code-review` plus one or more relevant tags: `security`, `performance`, `architecture`, `quality`
