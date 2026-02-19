# Review Document Template — Full Reference

The output format for Phase 5: Persist Review. Write this document to `docs/reviews/YYYY-MM-DD-<target-slug>.md`.

---

## Output Path

- If `docs/reviews/` exists, use it
- Otherwise, create `docs/reviews/` directory
- **Filename pattern:** `YYYY-MM-DD-<target-slug>.md`
  - PR: `2026-02-18-pr-123-add-user-auth.md` (PR number + title slug)
  - Branch: `2026-02-18-feature-add-user-auth.md` (branch name slugified)
  - Current changes: `2026-02-18-review-current-changes.md`

---

## Document Template

```markdown
---
date: [ISO timestamp]
target: "[PR #123 - Title | branch-name | current changes]"
branch: "[branch-name]"
status: complete
verdict: "[BLOCKS MERGE | APPROVED WITH CONCERNS | CLEAN]"
findings:
  total: [N]
  p1: [N]
  p2: [N]
  p3: [N]
tags: [review, code-review, <relevant-tags>]
---

# Code Review: [Target Description]

## Review Target

- **Target:** [PR #123 - Title | branch-name | current changes]
- **Branch:** [branch-name]
- **Date:** [YYYY-MM-DD]
- **Verdict:** [BLOCKS MERGE | APPROVED WITH CONCERNS | CLEAN]

## Plan Compliance

[If plan compliance check was run (Phase 1.0), include the compliance summary here. Otherwise omit this section.]

## Findings Summary

| Severity | Count | Status |
|----------|-------|--------|
| P1 (Critical) | [N] | BLOCKS MERGE |
| P2 (Important) | [N] | Should Fix |
| P3 (Nice-to-have) | [N] | Enhancements |
| **Total** | **[N]** | |

## Critical Findings (P1)

[If no P1 findings: "None — no merge-blocking issues found."]

### [Finding Title]

- **File:** `path/to/file.ts:42`
- **Category:** [security | performance | architecture | quality]
- **Effort:** [Small | Medium | Large]
- **Todo:** `docs/todos/001-pending-p1-finding-slug.md`

[Brief description of the issue and why it blocks merge.]

## Important Findings (P2)

[If no P2 findings: "None."]

### [Finding Title]

- **File:** `path/to/file.ts:85`
- **Category:** [security | performance | architecture | quality]
- **Effort:** [Small | Medium | Large]
- **Todo:** `docs/todos/002-pending-p2-finding-slug.md`

[Brief description of the issue.]

## Nice-to-Have Findings (P3)

[If no P3 findings: "None."]

### [Finding Title]

- **File:** `path/to/file.ts:120`
- **Category:** [security | performance | architecture | quality]
- **Effort:** [Small | Medium | Large]
- **Todo:** `docs/todos/003-pending-p3-finding-slug.md`

[Brief description.]

## Agent Coverage

| Agent | Status | Findings |
|-------|--------|----------|
| code-quality-reviewer | [completed | failed | skipped] | [N] |
| git-history-reviewer | [completed | failed | skipped] | [N] |
| pattern-reviewer | [completed | failed | skipped] | [N] |
| architecture-reviewer | [completed | failed | skipped] | [N] |
| security-reviewer | [completed | failed | skipped] | [N] |
| performance-reviewer | [completed | failed | skipped] | [N] |
| code-simplicity-reviewer | [completed | failed | skipped] | [N] |
| data-integrity-reviewer | [completed | failed | skipped | N/A] | [N] |

## Todo Files Created

| File | Priority | Description |
|------|----------|-------------|
| `docs/todos/001-pending-p1-xxx.md` | P1 | [description] |
| `docs/todos/002-pending-p2-xxx.md` | P2 | [description] |

## Next Steps

1. [Address P1 findings before merge (if any)]
2. Review todo files in `docs/todos/` directory
3. Update todo status as items are resolved
4. Use `/fly:work` to implement fixes from this review
```

---

## Integration: Consumed by Other Skills

Other skills can check for recent reviews before starting work:

```bash
# Check for recent reviews on this branch
BRANCH=$(git branch --show-current)
REVIEW=$(find docs/reviews -name "*${BRANCH}*" -mtime -14 2>/dev/null | head -1)

if [ -n "$REVIEW" ]; then
  # Recent review exists — read to understand outstanding findings
fi
```

**Freshness heuristic:** `docs/` is gitignored, so use file mtime only:
- `-mtime -7` (1 week): Fresh — findings likely still relevant
- `-mtime -14` (2 weeks): Check if findings were addressed
- Older: Treat as historical reference only
