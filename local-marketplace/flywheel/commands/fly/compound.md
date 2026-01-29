---
name: fly:compound
description: Document a recently solved problem to compound your team's knowledge. Uses parallel subagents for efficient capture.
argument-hint: "[optional: brief context about the fix]"
---

# Compound Knowledge

<context_hint> #$ARGUMENTS </context_hint>

**Invoke the compounding skill:**

```
skill: compounding
```

The compounding skill handles:
- Parallel subagent coordination (context, solution, prevention, etc.)
- Delegation to compound-docs skill for file creation
- Optional specialized review (performance, security, etc.)
- Cross-referencing with existing documentation

See `plugin/skills/compounding/SKILL.md` for full procedural details.
See `plugin/skills/compound-docs/SKILL.md` for documentation capture details.
