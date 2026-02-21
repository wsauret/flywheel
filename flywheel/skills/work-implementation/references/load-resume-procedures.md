# Load & Resume Procedures (Phase 1)

Detailed procedures for loading plans, creating state, validating formats, creating tasks, and worktree assessment.

## Check for Existing State

```bash
STATE_FILE="${PLAN_PATH%.md}.state.md"
test -f "$STATE_FILE" && echo "Found execution state - resuming"
```

**If state file exists:** Resume from first unchecked phase, load key decisions.

**If no state file:** Create initial state using `references/state-file-template.md`.

## Create Baseline Plan Snapshot

**For plan compliance checking:** Copy the plan to a baseline file that won't change during execution:

```bash
BASELINE_FILE="${PLAN_PATH%.md}.baseline.md"
if [ ! -f "$BASELINE_FILE" ]; then
  cp "$PLAN_PATH" "$BASELINE_FILE"
fi
```

This baseline is what we committed to. The compliance check in `work-review` compares against this, not the potentially-evolved current plan.

**Cleanup:** Delete baseline when work completes successfully.

## Create/Update Session File

```bash
mkdir -p .flywheel
```

Write session file per `references/session-file-template.md`:

```markdown
---
active_skill: work-implementation
plan_path: [PLAN_PATH]
state_path: [STATE_FILE]
context_path: [CONTEXT_FILE]
started: [timestamp]
last_checkpoint: [timestamp]
current_phase: 1
total_phases: [N]
---

# Active Flywheel Session

## Quick Resume

After clearing context, say **"carry on"** or run:
/fly:work [PLAN_PATH]

## Current Status

- **Plan:** [plan name]
- **Phase:** 1 of [N] - [description]
```

## Load Context

From `[plan_path].context.md`:
- File References
- Gotchas & Warnings
- Naming Conventions

## Format Validation

When loading plan, state, and context files, validate expected structure:

**Plan file must have:**
- [ ] Frontmatter (if consolidated plan)
- [ ] At least one phase/checklist
- [ ] Success criteria section (warn if missing)

**State file must have (if exists):**
- [ ] Frontmatter with `schema_version`
- [ ] Progress section with checkboxes
- [ ] Key Decisions section

**Context file should have (warn if missing):**
- [ ] File References
- [ ] Gotchas & Warnings
- [ ] research_date and codebase_version (staleness check)

**If validation fails:**
```
Warning: Validation warnings:
- Plan missing Success Criteria section
- Context file missing research_date (can't check staleness)

Proceeding with best effort. Consider updating files for better tracking.
```

Log warnings in state file under "Validation Warnings" section (append if exists).

## Create Tasks for Each Phase

**After loading plan, create native Tasks for progress tracking.**

For each phase in the plan's implementation checklist:

```
TaskCreate:
  subject: "Phase N: [description from plan]"
  description: "[full phase content including checklist items]"
  activeForm: "Implementing Phase N"
```

**Example:**
```
TaskCreate:
  subject: "Phase 1: Rename plan-verification to plan-enrich"
  description: "Rename skill directory, update triggers, search-replace all references..."
  activeForm: "Renaming plan-verification to plan-enrich"
```

**Benefits:**
- Tasks survive terminal restarts (stored in `~/.claude/tasks`)
- Visual progress tracking in Claude Code UI
- Recovery via `TaskList` to find uncompleted phases
- Shared task lists via `CLAUDE_CODE_TASK_LIST_ID`

**Note:** We use dual-write (Tasks + state file) for redundancy. State file remains source of truth for Ralph mode recovery.

## Worktree Assessment

**Note:** With subtask integration, per-phase isolation is handled automatically -- each `subtask send` creates its own git worktree. The assessment below applies to the overall work session, not individual phases.

**Recommend worktree for the session when:**
- Working on critical paths (auth, payments, migrations) where you want to preserve main branch state
- Multiple concurrent `/fly:work` sessions on different plans

**AskUserQuestion:**
```
Question: "Ready to execute. [Worktree recommended due to: X] How to work?"
Options:
1. Current branch (Recommended) - subtask handles per-phase isolation
2. Create worktree - Additional session-level isolation
```

**If worktree:** Use `worktree-manager.sh create <branch> main`, remind about deps and /init.
