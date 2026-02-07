# Research Document Template

The output format for Phase 3: Synthesize & Persist. Write this document to `docs/research/YYYY-MM-DD-<topic-slug>.md`.

---

## Output Path

- If `docs/research/` exists, use it
- Otherwise, create `docs/research/` directory

---

## Document Template

```markdown
---
date: [ISO timestamp]
topic: "[Research Question]"
status: complete
tags: [research, <relevant-tags>]
---

# Research: [Topic]

## Research Question

[Original user query]

## Summary

[High-level findings - 3-5 sentences synthesizing all agent outputs]

## Detailed Findings

### [Component/Area 1]

[Findings with file:line references from codebase-analyzer]

### [Component/Area 2]

[Findings from pattern-analyzer]

### [Additional Areas...]

## Code References

| File | Lines | Description |
|------|-------|-------------|
| `path/to/file.ts` | 42-67 | [what it does] |
| `path/to/other.ts` | 15-30 | [what it does] |

## Patterns Identified

- **[Pattern Name]**: `file.ts:42-67` - [description]
- **[Pattern Name]**: `other.ts:89-120` - [description]

## External References (if applicable)

- [Source Title](URL) - [key takeaway]

## Open Questions

- [Question needing further investigation]
- [Uncertainty about scope or behavior]
```

---

## Integration: Called by Other Skills

Other skills check for existing research before starting work:

```bash
# Check for recent research on topic (within 14 days)
RESEARCH=$(find docs/research -name "*<topic-slug>*" -mtime -14 2>/dev/null | head -1)

if [ -n "$RESEARCH" ]; then
  # Recent research exists — read YAML frontmatter to check topic match
  # Offer to user: "Recent research found on [topic]. Reuse or refresh?"
else
  # No recent research — proceed with new research or ask user
fi
```

**Freshness heuristic:** `docs/` is gitignored, so use file mtime only:
- `-mtime -14` (2 weeks): Fresh — offer to reuse
- `-mtime -30` (1 month): Stale — offer to refresh or reuse
- Older: Treat as reference only, recommend new research

---

## Present & Offer Next Steps

Display summary to user (not the full document).

**AskUserQuestion:**

```
Question: "Research complete and saved to docs/research/[filename]. What next?"
Options:
1. Create plan from research (Recommended) - Invoke plan-creation with research path
2. Continue researching - Ask follow-up question, append to document
3. Done for now - Exit
```

| Option | Action |
|--------|--------|
| Create plan | `Skill: plan-creation` with research document path |
| Continue | Ask follow-up, re-run locate-then-analyze, append to document |
| Done | Exit skill |
