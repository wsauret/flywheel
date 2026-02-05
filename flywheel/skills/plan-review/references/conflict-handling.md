# Conflict Handling Reference

How to detect, document, and convert conflicts to Open Questions.

## Philosophy

Each reviewer agent represents a different stakeholder perspective:
- **Security reviewer**: Prioritizes safety, may recommend more restrictive approaches
- **Performance analyst**: Prioritizes speed, may recommend caching/optimization
- **Code simplicity reviewer**: Prioritizes maintainability, may recommend simpler approaches
- **Architecture strategist**: Prioritizes long-term flexibility

**These perspectives legitimately conflict.** The USER must decide which priority matters more for their specific context.

---

## Detecting Conflicts

Scan findings for contradictions:

| Conflict Type | Example |
|---------------|---------|
| Opposite recommendations | Agent A: "use caching" vs Agent B: "avoid caching overhead" |
| Priority disagreement | Agent A marks P1, Agent B marks same issue P3 |
| Pattern assessment | Agent A: "pattern appropriate" vs Agent B: "anti-pattern" |
| Trade-off framing | Agent A: "security risk" vs Agent B: "acceptable for performance" |

---

## Why We Don't Resolve Conflicts

**DO NOT pick winners.** Converting conflicts to Open Questions:

1. Preserves the valid reasoning from each perspective
2. Surfaces trade-offs for human decision-making
3. Prevents bias toward any single reviewer's priorities
4. Documents the decision context for future reference

---

## Convert to Open Question Format

For each conflict:

```markdown
### Open Question: [Topic]

**Context:** [Brief description of what the plan proposes]

**Perspective A** (security-reviewer):
> [Their recommendation and reasoning]

**Perspective B** (performance-reviewer):
> [Their opposing recommendation and reasoning]

**Trade-off:** [What you gain/lose with each option]

**Options:**
- A: [Follow security-reviewer's recommendation]
- B: [Follow performance-reviewer's recommendation]
- C: [Hybrid approach if applicable]
```

---

## Conflict Metadata

Track in context file (do NOT pick winners):

```markdown
### Conflict: [Topic]
- **Agents disagreeing:** [agent-a], [agent-b]
- **Converted to Open Question:** Yes, #[n]
- **Resolution:** Pending user decision in consolidation
```

---

## Individual Agent Open Questions

Agents may also flag their own Open Questions:

```
OPEN QUESTION: [question] (Options: A, B, C if applicable)
```

These represent trade-offs from a single perspective where the agent needs user input:
- Security vs usability trade-offs
- Multiple valid approaches with different costs
- Context-dependent recommendations

Collect all agent Open Questions into the summary table alongside conflicts.

---

## Dispatch Template with Open Question Instruction

```
Task [agent-type]: "Review this plan for [perspective] concerns.
PLAN: [full plan content]
Provide findings with priority (P1/P2/P3) and specific locations.

IMPORTANT: Also flag any OPEN QUESTIONS from your perspective:
- Trade-offs where you see multiple valid approaches
- Decisions that depend on priorities you don't know
- Areas where you'd want clarification before implementation
Format: 'OPEN QUESTION: [question] (Options: A, B, C if applicable)'"
```
