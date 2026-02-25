# Conflict Handling Reference

## Detecting Conflicts

Scan findings for contradictions:

| Conflict Type | Example |
|---------------|---------|
| Opposite recommendations | Agent A: "use caching" vs Agent B: "avoid caching overhead" |
| Priority disagreement | Agent A marks P1, Agent B marks same issue P3 |
| Pattern assessment | Agent A: "pattern appropriate" vs Agent B: "anti-pattern" |
| Trade-off framing | Agent A: "security risk" vs Agent B: "acceptable for performance" |

---

## Convert to Open Question Format

**Do NOT pick winners.** For each conflict:

```markdown
### Open Question: [Topic]

**Context:** [Brief description of what the plan proposes]

**Perspective A** (reviewer-architecture):
> [Their recommendation and reasoning]

**Perspective B** (reviewer-performance):
> [Their opposing recommendation and reasoning]

**Trade-off:** [What you gain/lose with each option]

**Options:**
- A: [Follow reviewer-architecture's recommendation]
- B: [Follow reviewer-performance's recommendation]
- C: [Hybrid approach if applicable]
```

---

## Individual Agent Open Questions

Agents may also flag their own:

```
OPEN QUESTION: [question] (Options: A, B, C if applicable)
```

Collect all agent Open Questions into the summary table alongside conflicts.

---

## Dispatch Template

```
Task [agent-type]: "Review this plan for [perspective] concerns.
PLAN: [full plan content]
Provide findings with priority (P1/P2/P3) and specific locations.

IMPORTANT: Also flag any OPEN QUESTIONS from your perspective:
- Trade-offs where you see multiple valid approaches
- Decisions that depend on priorities you don't know
Format: 'OPEN QUESTION: [question] (Options: A, B, C if applicable)'"
```
