# Extraction Patterns

How to extract and categorize content from reviewed plans.

## Required Sections Detection

Verify the plan contains:

| Section | Source | Required |
|---------|--------|----------|
| Original content | plan-creation | Yes |
| Plan Review Summary | plan-review | Yes (warn if missing) |

---

## Review Findings Extraction

From "Plan Review Summary", extract findings into:

```
P1_FINDINGS:
- [Finding]: [Description] (Source: [agent])

P2_FINDINGS:
- [Finding]: [Description] (Source: [agent])

P3_FINDINGS:
- [Finding]: [Description] (Source: [agent])

CONFLICTS:
- [Topic]: Side A vs Side B (Resolution: [if provided])
```

---

## Implementation Steps Extraction

Parse original plan to identify phases/steps:

```
IMPLEMENTATION_PHASES:
- Phase 1: [Name]
  - Step 1.1: [Action]
  - Step 1.2: [Action]
- Phase 2: [Name]
  - Step 2.1: [Action]
```

---

## Open Questions Detection

Search plan content for:

**Structured (from creation/review):**
- `### Open Questions` sections
- `## Open Questions` tables
- Tables with `| # | Question | Options | Source(s) |`
- `OPEN QUESTION:` markers

**Explicit markers:**
- "TODO", "TBD", "to be decided"
- "?" in headings or bullet points
- "Decision needed" or "requires decision"

**Implicit alternatives:**
- "Option A vs Option B" language
- "Consider X or Y" phrasing
- "Either... or..." constructions
- "Alternatively," followed by different approach

**Conflicts (converted to questions):**
- `### Open Question: [Topic]` with Perspective A/B
- "Conflicts Between Reviewers" section

---

## Finding-to-Step Mapping

For each implementation step, identify relevant:
- Review findings that affect it
- Code examples referenced
- Anti-patterns to avoid

This mapping enables integrated checklists rather than floating insights.

---

## Synthesis Principles

1. **Deduplicate ruthlessly** - Same finding from multiple agents → one entry
2. **Prioritize by impact** - P1 before P2, high-impact first
3. **Integrate, don't append** - Findings IN the checklist, not after
4. **Preserve attribution** - Know where recommendations came from
5. **Make it executable** - Every item should be a concrete action

---

## Handling Missing Sections

**Plan Review Summary missing:**
- Warn: "Plan has not been reviewed. No findings to incorporate."
- Ask: "Continue with consolidation anyway?"

**No original content:**
- Error: "This plan has not been created. Run `/fly:plan` first."
