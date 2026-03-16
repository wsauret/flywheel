# Extraction Patterns

How to extract and categorize content from reviewed plans.

## Required Sections

| Section | Source | Required |
|---------|--------|----------|
| Original content | plan-creation | Yes |
| Plan Review Summary | plan-review | Yes (warn if missing) |

---

## Review Findings Extraction

From "Plan Review Summary", extract into:

- **P1_FINDINGS:** [Finding]: [Description] (Source: [agent])
- **P2_FINDINGS:** [Finding]: [Description] (Source: [agent])
- **P3_FINDINGS:** [Finding]: [Description] (Source: [agent])
- **CONFLICTS:** [Topic]: Side A vs Side B

---

## Implementation Steps Extraction

Parse original plan to identify phases/steps. Preserve test-first ordering.

---

## Finding-to-Step Mapping

For each implementation step, identify relevant review findings, code examples, and anti-patterns. This enables integrated checklists rather than floating insights.

---

## Synthesis Principles

1. **Deduplicate** - Same finding from multiple agents → one entry
2. **Prioritize** - P1 before P2
3. **Integrate, don't append** - Findings IN the checklist
4. **Preserve attribution** - Track where recommendations came from
5. **Make executable** - Every item is a concrete action

---

## Missing Sections

- **No Review Summary:** Warn, ask to continue
- **No original content:** Error
