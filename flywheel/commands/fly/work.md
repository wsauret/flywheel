---
name: fly:work
description: Execute work plans efficiently while maintaining quality and finishing features. Loads context files, follows patterns, tests continuously. Supports "carry on" resume after clearing context.
argument-hint: "[plan file path] (optional - will resume active session if omitted)"
---

# Execute Work Plan

<input_document> #$ARGUMENTS </input_document>

**Invoke the work-implementation skill:**

```
skill: work-implementation
```

## Session Recovery

If no arguments provided, the skill checks for an active session at `.flywheel/session.md`.

After clearing context mid-work, say **"carry on"** or run `/fly:work` with no arguments to resume.

## Features

The work-implementation skill handles:
- **Session tracking** - `.flywheel/session.md` enables "carry on" resume
- Loading plan and companion `.context.md` file
- Environment setup (branch vs worktree)
- Task breakdown with TodoWrite
- Execution following existing patterns
- Continuous testing
- Quality checks and optional reviewer agents
- Commit and PR creation
- Handoff to `/fly:review`

See `plugin/skills/work-implementation/SKILL.md` for full procedural details.
