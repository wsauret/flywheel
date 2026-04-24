---
name: fly:work
description: Execute work plans efficiently while maintaining quality and finishing features. Loads context files, follows patterns, tests continuously. Supports "carry on" resume after clearing context.
argument-hint: "[slug OR path to findings.json] (optional - resumes the active session if omitted)"
---

# Execute Work Plan

**MANDATORY FIRST ACTION — You MUST use the Skill tool to invoke the skill below BEFORE doing anything else. Do NOT read files, search code, or respond to the user first.**

**Invoke the work-implementation skill:**

```
skill: work-implementation
```

<input_document> #$ARGUMENTS </input_document>

## Input Shapes

The work-implementation skill accepts three input shapes (see `flywheel/skills/work-implementation/references/session-detection.md`):

- **empty** — resume the active session from `.flywheel/plugin/active.json`
- **slug** (`^[a-z0-9-]+$`) — prefix-scan `.flywheel/plugin/sessions/<slug>-*` and tiebreak by most-recent ISO date; updates `active.json` to the match
- **findings.json path** — fix-findings mode; synthesize a TaskList from the findings file

## Session Recovery

Sessions are tracked by a session dir at `.flywheel/plugin/sessions/<session-id>/` plus a pointer at `.flywheel/plugin/active.json`. Session state persists in `state.json`, so clearing context mid-work does not lose progress.

After clearing context mid-work, say **"carry on"** or run `/fly:work` with no arguments to resume from the first non-completed phase.

## Features

The work-implementation skill handles:
- **Session tracking** — active-pointer model (`.flywheel/plugin/active.json`) enables "carry on" resume
- **Atomic JSON state** — `state.json` captures phase status, strikes, and BC satisfaction; writes are atomic
- **Baseline freezing** — spec.json copied to `baseline.json` + SHA-256 hash on work-start (D2)
- Environment setup (branch vs worktree)
- Task breakdown with TaskCreate/TaskUpdate/TaskList
- Execution following existing patterns (probe → dispatch → checkpoint)
- Continuous testing (TDD per task)
- Quality checks and optional reviewer agents
- Handoff to `/fly:review` or `/fly:ship`

See `flywheel/skills/work-implementation/SKILL.md` for full procedural details.
