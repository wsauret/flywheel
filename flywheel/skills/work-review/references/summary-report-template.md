# Summary Report Template — Full Reference

This reference contains the full template for the Phase 5 summary report displayed to the user.

## Template

```markdown
## Code Review Complete

**Review Target:** PR #XXX - [Title]
**Branch:** [branch-name]
**Saved to:** `docs/reviews/[filename].md`

### Findings Summary:
- **Total:** [X]
- **CRITICAL (P1):** [count] - BLOCKS MERGE
- **IMPORTANT (P2):** [count] - Should Fix
- **NICE-TO-HAVE (P3):** [count] - Enhancements

### Top Findings:
[List the 3-5 most important findings with file:line references]

### What's next?
1. Implement review findings — invoke `/fly:work docs/reviews/[filename].md`
2. Ship as-is — invoke `/fly:ship`
```
