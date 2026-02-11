---
name: fly:ship
description: Create a branch if needed, commit changes, and open a PR with a concise description.
argument-hint: "[optional: commit message hint or branch name]"
---

# Ship Changes

**MANDATORY FIRST ACTION — You MUST use the Skill tool to invoke the skill below BEFORE doing anything else. Do NOT read files, search code, or respond to the user first.**

**Invoke the ship skill:**

```
skill: ship
```

<ship_context> #$ARGUMENTS </ship_context>

The ship skill handles:
- Detecting current branch and creating a new one if on main/master
- Staging and committing changes with clean messages
- Pushing and opening a PR with a concise description
- No Claude attribution in commits or PR descriptions

See `skills/ship/SKILL.md` for details.
