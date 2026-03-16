---
name: fly:compound
description: Document a recently solved problem to compound your team's knowledge.
argument-hint: "[optional: brief context about the fix]"
---

# Compound Knowledge

**MANDATORY FIRST ACTION — You MUST use the Skill tool to invoke the skill below BEFORE doing anything else. Do NOT read files, search code, or respond to the user first.**

**Invoke the compound skill:**

```
skill: compound
```

<context_hint> #$ARGUMENTS </context_hint>

The compound skill handles:
- Gathering context from conversation
- YAML validation and file creation
- Cross-referencing with existing docs
- Optional specialized review for complex issues

See `skills/compound/SKILL.md` for details.
