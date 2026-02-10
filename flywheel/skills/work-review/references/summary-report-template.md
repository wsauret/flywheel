# Summary Report Template — Full Reference

This reference contains the full template for the Phase 5 summary report.

## Template

```markdown
## Code Review Complete

**Review Target:** PR #XXX - [Title]
**Branch:** [branch-name]

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
2. Review todo files in `docs/todos/` directory
3. Update todo status as items are resolved
```
