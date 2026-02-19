# Summary Report Template — Full Reference

This reference contains the full template for the Phase 6 summary report displayed to the user.

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

### Created Todo Files:

**P1 - Critical:**
- `001-pending-p1-{finding}.md`

**P2 - Important:**
- `002-pending-p2-{finding}.md`

**P3 - Nice-to-Have:**
- `003-pending-p3-{finding}.md`

### Next Steps:
1. Address P1 findings before merge
2. Full review details: `docs/reviews/[filename].md`
3. Individual todo files: `docs/todos/` directory
4. Use `/fly:work` to implement fixes from this review
```
