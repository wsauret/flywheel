---
name: plan-consolidation
description: Restructure deepened and reviewed plans into actionable checklists for /work. Triggers on "consolidate plan", "finalize plan".
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
  - AskUserQuestion
---

# Plan Consolidation Skill

Transform plans with Research Insights and Review Summary into a single, coherent, work-ready document with integrated checklists.

**Philosophy:** Verification and reviewing add valuable content but scatter it. Consolidation restructures everything into actionable format.

## Input

Plan path via `$ARGUMENTS`. Should already have Enhancement Summary (from plan-enrich) and Review Summary (from plan-review).

---

## Phase 1: Analyze Plan Structure

### Verify Required Sections

Check for:
- Original content (Technical Approach, Implementation, etc.)
- Enhancement Summary (added by plan-enrich)
- Research Insights (subsections under original sections)
- Plan Review Summary (appended by plan-review)

See `references/extraction-patterns.md` for detection details.

### Handle Missing Sections

- **No Enhancement Summary:** Warn and ask to continue
- **No Review Summary:** Warn and ask to continue
- **Both missing:** Error - plan hasn't been processed

---

## Phase 2: Extract Content

Using patterns from `references/extraction-patterns.md`:

1. **Extract review findings** into P1/P2/P3 categories
2. **Extract research insights** into best practices, anti-patterns, code examples, security, performance, edge cases
3. **Extract implementation steps** into phases
4. **Map insights to steps** for integrated checklists

---

## Phase 3: Resolve Open Questions

**The user must weigh in before we can create a work-ready plan.**

Read `references/question-resolution.md` before proceeding -- it contains the scan patterns, question presentation format, and response handling procedure.

Scan for all open questions, TODOs, TBDs, option-vs-option language, and reviewer conflicts. Present each question **one at a time** with context, a recommendation, and options (including "You pick what's best"). Record all decisions for inclusion in the consolidated plan.

---

## Phase 4: Synthesize

### Principles

1. **Deduplicate** - Same insight from multiple sources -> one entry
2. **Prioritize** - P1 before P2, high-impact first
3. **Integrate** - Insights IN checklist items, not floating
4. **Preserve attribution** - Track where recommendations came from
5. **Make executable** - Every item is a concrete action

P1 findings are CRITICAL: resolve with a specific checklist action, or flag as BLOCKING. For conflicts, apply the review resolution if provided; otherwise present with recommendation or flag for user decision.

---

## Phase 5: Generate Consolidated Plan

Write using template from `references/consolidated-plan-template.md`.

Structure:
1. Status section with dates
2. Executive Summary
3. Decisions Made (if questions were resolved)
4. Critical Items (if P1s or conflicts exist)
5. Implementation Checklist (integrated insights per step)
6. Technical Reference (best practices, anti-patterns, code examples)
7. Review Findings Summary
8. Appendix (raw data in collapsible sections)

---

## Phase 6: Write Files

### Backup Original

```bash
cp [plan_path] [plan_path].pre-consolidation.backup
```

### Write Consolidated Plan

Overwrite plan file with consolidated version. Original content preserved in Appendix.

### Update Context File

Append consolidation metadata using template from `references/consolidated-plan-template.md`.

---

## Phase 7: Present Results and Next Steps

Read `references/results-presentation.md` before proceeding -- it contains the summary output template and post-consolidation option menu.

Present a summary of phases, checklist items, insights integrated, findings addressed, and P1 status. Then ask the user whether to start `/fly:work` or stop here.

---

## Error Handling

- **Missing content:** Warn and continue, or error if critical
- **Write failure:** Display content, suggest alternative path
- **Malformed input:** Best-effort consolidation, note unparsed sections

---

## Anti-Patterns

- **Skip question resolution** - Don't consolidate with TBD items
- **Multiple questions at once** - One at a time
- **Just append** - Restructure, don't slap summary on top
- **Lose raw data** - Preserve in Appendix
- **Floating insights** - Integrate into checklist items
- **Ignore P1s** - Must resolve or block
- **Vague checklists** - "Implement auth" -> "Step 2.1: Create JWT in `src/auth/tokens.ts`"

---

## Quality Checks

Before finalizing:
- [ ] All open questions resolved with user input
- [ ] Decisions recorded in "Decisions Made" section
- [ ] All P1 findings addressed or flagged as blocking
- [ ] Every implementation step has concrete action
- [ ] Research insights integrated into relevant steps
- [ ] Appendix contains raw verification/review data
- [ ] Plan genuinely ready for `/fly:work`

---

## Detailed References

- `references/consolidated-plan-template.md` - Output structure, context file update template
- `references/extraction-patterns.md` - How to extract and categorize content
- `references/question-resolution.md` - Question scan patterns, presentation format, response handling
- `references/results-presentation.md` - Summary output template, post-consolidation options

