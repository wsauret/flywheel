---
name: fly:brainstorm
description: Conversational exploration of ideas before detailed planning. One question at a time, explores 2-3 approaches, validates design incrementally.
argument-hint: "[feature idea or problem to explore]"
---

# Brainstorm Ideas Into Designs

**Note: The current year is 2026.**

<feature_idea> #$ARGUMENTS </feature_idea>

**Invoke the brainstorm skill:**

```
skill: brainstorm
```

The brainstorm skill handles:
- Silent research (agents run but don't dump output)
- Conversational questioning (one question at a time)
- Approach exploration (always 2-3 options)
- Incremental design validation (200-300 word chunks)
- Design document creation (`plans/<topic>-design.md`)
- Handoff to `/fly:plan`

See `plugin/skills/brainstorm/SKILL.md` for full procedural details.
