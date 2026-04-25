---
name: fly:work
description: Execute work plans efficiently while maintaining quality and finishing features. Loads context files, follows patterns, tests continuously. Supports "carry on" resume after clearing context.
argument-hint: "[slug] (optional - resumes the active session if omitted)"
---

# Execute Work Plan

**MANDATORY FIRST ACTION — You MUST use the Skill tool to invoke the skill below BEFORE doing anything else. Do NOT read files, search code, or respond to the user first.**

**Invoke the work-implementation skill:**

```
skill: work-implementation
```

<input_document> #$ARGUMENTS </input_document>

## Input Shapes

The work-implementation skill accepts two input shapes (see `flywheel/skills/work-implementation/references/session-detection.md`):

- **empty** — resume the active session from `.flywheel/plugin/active.json`. Mode (plan vs fix-findings) is auto-detected from session contents.
- **slug** (`^[a-z0-9-]+$`) — prefix-scan `.flywheel/plugin/sessions/<slug>-*` and tiebreak by most-recent ISO date; updates `active.json` to the match.

## Session Recovery

Sessions are tracked by a session dir at `.flywheel/plugin/sessions/<session-id>/` plus a pointer at `.flywheel/plugin/active.json`. Work state persists in `progress.json`, so clearing context mid-work does not lose progress.

After clearing context mid-work, say **"carry on"** or run `/fly:work` with no arguments to resume from the first non-completed chunk.

## Features

The work-implementation skill handles:
- **Session tracking** — active-pointer model (`.flywheel/plugin/active.json`) enables "carry on" resume
- **Atomic JSON state** — `progress.json` captures completed chunk IDs and accumulated artifacts; writes are atomic
- **Mode auto-detection** — plan mode (executes `spec.json`) or fix-findings mode (executes `review.findings.json`) based on what's in the session dir
- Environment setup (branch vs worktree)
- Subagent dispatch per chunk (probe → dispatch → checkpoint)
- Continuous testing (TDD per task in plan mode)
- Quality checks and optional reviewer agents
- Handoff to `/fly:review` or `/fly:ship`

See `flywheel/skills/work-implementation/SKILL.md` for full procedural details.
