# Session File Template

The session file enables "carry on" resume after clearing context.

## File Location

```
.flywheel/session.md
```

Single file in project root. Only one active session at a time.

---

## Session File Structure

```markdown
---
active_skill: work-implementation
plan_path: plans/feat-user-auth.md
state_path: plans/feat-user-auth.state.md
context_path: plans/feat-user-auth.context.md
started: 2024-01-15T10:00:00
last_checkpoint: 2024-01-15T10:30:00
current_phase: 2
total_phases: 4
skip_manual_pauses: false
---

# Active Flywheel Session

## Quick Resume

After clearing context, say **"carry on"** or run:

```
/fly:work plans/feat-user-auth.md
```

## Current Status

- **Plan:** feat-user-auth.md
- **Phase:** 2 of 4 - Core implementation
- **Last completed:** Phase 1 - Foundation setup

## Key Decisions (carried forward)

- Using repository pattern for data access
- Tests in `__tests__/` directory

## Key Learnings (carried forward)

- Existing auth uses middleware pattern in `src/middleware/auth.ts`
- Tests expect mock database in `__mocks__/db.ts`

## Recent Files Modified

- `src/services/auth.ts` (created)
- `src/routes/index.ts` (modified)

## Handoff Summary

<!-- Everything a context-less agent needs to continue -->

### What We're Building

[1-2 sentence goal from plan's Desired End State]

### Where We Are

Phase 2 of 4: Core implementation
Last completed: Phase 1 - Foundation setup

### What We Learned

[Top 3 learnings from state.md, abbreviated]

### What's Next

[Immediate next action from current phase]
```

### Frontmatter Fields

| Field | Purpose |
|-------|---------|
| `skip_manual_pauses` | If true, skip manual verification prompts (user opted out) |

---

## Lifecycle

### On Work Start

When `work-implementation` skill starts:

```bash
mkdir -p .flywheel
```

Write session file with initial state.

### On Phase Checkpoint

After each phase completes, update:
- `last_checkpoint` timestamp
- `current_phase` number
- Key decisions (append)
- Recent files modified

### On Work Complete

When all phases done:

```bash
rm .flywheel/session.md
```

Or mark as completed:

```yaml
active_skill: none
status: completed
```

---

## Resume Detection

When `/fly:work` called with no arguments:

1. Check for `.flywheel/session.md`
2. If exists and `active_skill: work-implementation`:
   - Read plan_path, state_path, context_path
   - Offer to resume: "Found active session for [plan]. Resume?"
3. If not exists or completed:
   - Ask user which plan to work on

---

## "Carry On" Detection

When user says "carry on", "continue", "resume", etc.:

1. Check for `.flywheel/session.md`
2. If active session found:
   - Load plan, state, context files
   - Resume from current_phase
3. If no session:
   - Ask user what to continue

---

## Gitignore

Add to `.gitignore`:

```
.flywheel/
```

Session state is local, not committed.
