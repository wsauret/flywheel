---
name: fly:work
description: Execute work plans efficiently while maintaining quality and finishing features. Loads context files, follows patterns, tests continuously.
argument-hint: "[plan file, specification, or todo file path]"
---

# Execute Work Plan

<input_document> #$ARGUMENTS </input_document>

**Invoke the executing-work skill:**

```
skill: executing-work
```

The executing-work skill handles:
- Loading plan and companion `.context.md` file
- Environment setup (branch vs worktree)
- Task breakdown with TodoWrite
- Execution following existing patterns
- Continuous testing
- Quality checks and optional reviewer agents
- Commit and PR creation
- Handoff to `/fly:review`

See `plugin/skills/executing-work/SKILL.md` for full procedural details.
