# Extraction Patterns

How to extract and categorize content from deepened and reviewed plans.

## Required Sections Detection

Verify the plan contains:

| Section | Source | Required |
|---------|--------|----------|
| Original content | plan-creation | Yes |
| Enhancement Summary | plan-enrich | Yes (warn if missing) |
| Research Insights | plan-enrich | Yes (warn if missing) |
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

## Research Insights Extraction

From each "Research Insights" subsection, extract into categories:

```
BEST_PRACTICES:
- [Practice] (Section: [X], Source: [Y])

ANTI_PATTERNS:
- [Anti-pattern] (Section: [X])

CODE_EXAMPLES:
- [Description] (Section: [X], Language: [Y])
  ```code```

SECURITY_ITEMS:
- [Item] (Section: [X])

PERFORMANCE_ITEMS:
- [Item] (Section: [X])

EDGE_CASES:
- [Edge case]: [Handling strategy] (Section: [X])
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

**Structured (from verification/review):**
- `### Open Questions` sections
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

## Insight-to-Step Mapping

For each implementation step, identify relevant:
- Research insights that apply
- Review findings that affect it
- Code examples to use
- Anti-patterns to avoid

This mapping enables integrated checklists rather than floating insights.

---

## Synthesis Principles

1. **Deduplicate ruthlessly** - Same insight from multiple places → one entry
2. **Prioritize by impact** - P1 before P2, high-impact insights first
3. **Integrate, don't append** - Insights IN the checklist, not after
4. **Preserve attribution** - Know where recommendations came from
5. **Make it executable** - Every item should be a concrete action

---

## Handling Missing Sections

**Enhancement Summary missing:**
- Warn: "Plan has not been deepened. Research insights may be limited."
- Ask: "Continue with consolidation anyway?"

**Plan Review Summary missing:**
- Warn: "Plan has not been reviewed. No findings to incorporate."
- Ask: "Continue with consolidation anyway?"

**Both missing:**
- Error: "This plan has not been processed. Run `/fly:plan` first or deepen/review manually."
