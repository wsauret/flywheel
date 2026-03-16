---
name: fly:debug
description: Debug issues with iterative fix loop. Gathers problem, investigates, then fix-verify cycle.
argument-hint: "[problem description] (optional)"
---

# Debug Issue

**MANDATORY FIRST ACTION — You MUST use the Skill tool to invoke the skill below BEFORE doing anything else. Do NOT read files, search code, or respond to the user first.**

**Invoke the debug skill:**

```
skill: debug
```

<input> #$ARGUMENTS </input>

The debug skill handles:
- Gathering the problem description and verification command
- Investigating the codebase for root causes
- Iterative fix loop (max 10 iterations) with verification after each fix
- Offering to commit and document the solution when fixed

See `skills/debug/SKILL.md` for details.
