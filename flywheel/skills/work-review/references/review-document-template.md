# Review Document Template — Full Reference

The output format for Phase 4: Persist Review. Write this document to `docs/reviews/YYYY-MM-DD-<target-slug>.md`.

This document serves two purposes: (1) a record of the review, and (2) an actionable plan consumable by `/fly:work`. Structure findings as implementation phases with concrete, checkable steps — the same format `plan-consolidation` produces.

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
ready_for: /fly:work
---

# Code Review: [Target Description]

## Status
- **Reviewed:** [YYYY-MM-DD]
- **Target:** [PR #123 - Title | branch-name | current changes]
- **Branch:** [branch-name]
- **Verdict:** [BLOCKS MERGE | APPROVED WITH CONCERNS | CLEAN]
- **Ready for:** /fly:work

## Plan Compliance

[If plan compliance check was run (Phase 1.0), include the compliance summary here. Otherwise omit this section.]

## Findings Summary

| Severity | Count | Status |
|----------|-------|--------|
| P1 (Critical) | [N] | BLOCKS MERGE |
| P2 (Important) | [N] | Should Fix |
| P3 (Nice-to-have) | [N] | Enhancements |
| **Total** | **[N]** | |

## Critical Items Before Implementation

[Only include this section if P1 findings exist]

- **[Finding title]** (Source: [agent])
  - Issue: [Description]
  - Resolution: [How it's addressed in the checklist below, OR "BLOCKS IMPLEMENTATION"]

## Implementation Checklist

Group findings into phases by file/module/concern. Each phase should be a coherent unit of work. Order by severity (P1 first), then by logical dependency.

### Phase 1: [Name — grouped by file, module, or concern]

- [ ] **Step 1.1: [Concrete action — what to change, where]**
  - File: `path/to/file.ts:42`
  - Severity: P1
  - Category: [security | performance | architecture | quality]
  - Problem: [What is broken or at risk]
  - Fix: [Specific change to make]
  - Agent: [Which reviewer found this]

- [ ] **Step 1.2: [Concrete action]**
  - File: `path/to/file.ts:85`
  - Severity: P2
  - Category: [category]
  - Problem: [Description]
  - Fix: [Specific change to make]
  - Agent: [source agent]

- [ ] **Step 1.3: Verify — Tests pass for this phase**

### Phase 2: [Name]

- [ ] **Step 2.1: [Concrete action]**
  - File: `path/to/file.ts:120`
  - Severity: [P1 | P2 | P3]
  - Category: [category]
  - Problem: [Description]
  - Fix: [Specific change to make]
  - Agent: [source agent]

- [ ] **Step 2.2: Verify — Tests pass for this phase**

## Agent Coverage

| Agent | Status | Findings |
|-------|--------|----------|
| reviewer-code-quality | [completed | failed | skipped] | [N] |
| reviewer-patterns | [completed | failed | skipped] | [N] |
| reviewer-architecture | [completed | failed | skipped] | [N] |
| reviewer-performance | [completed | failed | skipped] | [N] |
| reviewer-data-integrity | [completed | failed | skipped | N/A] | [N] |

## Next Steps

1. Run `/fly:work docs/reviews/[this-file].md` to implement fixes
2. Re-review after fixes if P1 findings were present
3. Ship when findings are addressed via `/fly:ship`
```

---

## Phase Grouping Guidelines

When converting flat findings into implementation phases:

1. **Group by file or module** — findings in the same file or closely related files become one phase.
2. **Respect dependency order** — if fixing finding A is required before finding B makes sense, A's phase comes first.
3. **P1 findings go in the earliest phases** — critical issues are addressed before nice-to-haves.
4. **Each phase ends with a verify step** — maintain TDD discipline even in fix work.
5. **Only include user-approved P3 findings** — P3 items are triaged by the user before the plan is written. Dropped P3s are omitted entirely.
6. **Keep phases small** — prefer 2-4 steps per phase. A phase with 8+ steps should be split.

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
