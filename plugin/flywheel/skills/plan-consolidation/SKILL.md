---
name: plan-consolidation
description: Restructure reviewed plans into actionable checklists for /work. Triggers on "consolidate plan", "finalize plan".
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

Transform plans with a Review Summary into a single, coherent, work-ready document with integrated checklists.

**Philosophy:** Reviewing adds valuable content but scatters it. Consolidation restructures everything into actionable format.

## Input

Plan path via `$ARGUMENTS`. Should already have Plan Review Summary (from plan-review).

---

## Phase 1: Analyze Plan Structure

Check for original content and Plan Review Summary. See `references/extraction-patterns.md` for detection details.

- **No Review Summary:** Warn and ask to continue
- **No original content:** Error - plan hasn't been created

---

## Phase 2: Extract Content

Using patterns from `references/extraction-patterns.md`:

1. **Extract review findings** into P1/P2/P3 categories
2. **Extract implementation steps** into phases
3. **Map findings to steps** for integrated checklists

---

## Phase 3: Resolve Open Questions

**The user must weigh in before we can create a work-ready plan.**

Scan for all unresolved items:
- `### Open Questions` sections/tables, `OPEN QUESTION:` markers
- TODO, TBD, "to be decided", "Decision needed"
- "Option A vs Option B", "Either... or...", "Alternatively,"
- Reviewer conflicts from "Conflicts Between Reviewers" section

Present each question **one at a time**:

```
Question: "[Topic]: [The question]"
Context: [Brief explanation of why this matters]
My recommendation: [Preferred option and why]
Options:
1. [Option A] (Recommended) - [Brief description]
2. [Option B] - [Brief description]
3. "You pick what's best" - Let me decide
```

Handle responses: user picks option → record decision; user picks "You decide" → apply recommendation, note delegated; custom answer → record exactly. Never proceed with unresolved questions.

---

## Phase 4: Synthesize

### Principles

1. **Deduplicate** - Same insight from multiple sources → one entry
2. **Prioritize** - P1 before P2, high-impact first
3. **Preserve test-first ordering** — Maintain test-before-implementation order within phases
4. **Integrate** - Insights IN checklist items, not floating
5. **Make executable** - Every item is a concrete action

P1 findings are CRITICAL: resolve with a specific checklist action, or flag as BLOCKING.

---

## Phase 5: Generate Consolidated Plan

Write using template from `references/consolidated-plan-template.md`.

Structure: Status → Executive Summary → Decisions Made → Critical Items → Implementation Checklist → Technical Reference → Review Findings Summary → Appendix (raw review data).

---

## Phase 6: Write Files

```bash
cp [plan_path] [plan_path].pre-consolidation.backup
```

Overwrite plan file with consolidated version. Original content preserved in Appendix.

---

## Phase 7: Present Results

Display summary and offer next steps:

```
Plan Consolidated — [plan_path]

Summary: [N] phases, [N] checklist items, [N] findings addressed
Status: [Ready for /fly:work OR "Blocked - see Critical Items"]
```

**AskUserQuestion:** "Plan consolidated and ready. What next?"
- Start /fly:work (Recommended)
- Done for now

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
- **Floating insights** - Integrate into checklist items
- **Ignore P1s** - Must resolve or block
- **Vague checklists** - "Implement auth" → "Step 2.1: Create JWT in `src/auth/tokens.ts`"

---

## Quality Checks

- [ ] All open questions resolved with user input
- [ ] All P1 findings addressed or flagged as blocking
- [ ] Every implementation step has concrete action
- [ ] Each phase has test verification
- [ ] Plan genuinely ready for `/fly:work`

---

## Detailed References

- `references/consolidated-plan-template.md` - Output structure
- `references/extraction-patterns.md` - How to extract and categorize content
