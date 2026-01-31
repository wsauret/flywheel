---
name: work-implementation
description: Execute work plans using probe-dispatch-checkpoint pattern. Orchestrator stays lean, dispatches subagents per phase. Triggers on "work on", "implement", "execute plan", "carry on", "continue".
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
  - Task
  - TodoWrite
  - AskUserQuestion
---

# Executing-Work Skill

Execute plans using **probe-dispatch-checkpoint** pattern. Orchestrator stays lean, dispatches subagents per phase, persists state for recovery.

**Context Compaction:** This skill manages context via `.state.md` files (progress checkpoints) and `.context.md` files (research findings). If context is lost mid-work, these files enable seamless recovery. See README for philosophy.

**Subagent Dispatch:** Follow guidelines in `CLAUDE.md`.

## Input

Plan path via `$ARGUMENTS`. Can be a plan, specification, or todo file.

**If no arguments provided:** Check for active session (see Phase 0).

---

## Phase 0: Session Detection

**Run this phase FIRST, before anything else.**

### Check for Active Session

```bash
test -f .flywheel/session.md && echo "Active session found"
```

### If Session Exists AND No Arguments Provided

Read session file frontmatter:

```bash
head -20 .flywheel/session.md
```

**AskUserQuestion:**
```
Question: "Found active session for [plan_path]. Resume where you left off?"
Options:
1. Resume (Recommended) - Continue from Phase [N]
2. Start fresh - Abandon session, ask for new plan
3. View status - Show current progress first
```

- **Resume:** Set `PLAN_PATH` from session, continue to Phase 1
- **Start fresh:** Delete session file, ask for plan path
- **View status:** Display session details, ask again

### If Session Exists AND Arguments Provided

Compare session `plan_path` with provided argument:
- **Same plan:** Resume session
- **Different plan:** Ask whether to switch or continue existing

### If No Session

Proceed normally - require plan path from arguments or ask user.

---

## Phase 1: Load & Resume

### Check for Existing State

```bash
STATE_FILE="${PLAN_PATH%.md}.state.md"
test -f "$STATE_FILE" && echo "Found execution state - resuming"
```

**If state file exists:** Resume from first unchecked phase, load key decisions.

**If no state file:** Create initial state using `references/state-file-template.md`.

### Create/Update Session File

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

### Load Context

From `[plan_path].context.md`:
- File References
- Gotchas & Warnings
- Naming Conventions

### Worktree Assessment

**Recommend worktree when:**
- Plan modifies >10 files
- Plan has >3 phases
- Plan touches critical paths (auth, payments, migrations)

**AskUserQuestion:**
```
Question: "Ready to execute. [Worktree recommended due to: X] How to work?"
Options:
1. Current branch
2. Create worktree (Recommended)
```

**If worktree:** Use `worktree-manager.sh create <branch> main`, remind about deps and /init.

---

## Phase 2: Execute (Per-Phase Loop)

For each unchecked phase:

### 2.1 Probe Phase Files

Quick check of referenced files:
- Count files and estimate lines
- If >500 lines: warn, consider splitting
- Note missing files

### 2.2 Dispatch Subagent

```
Task general-purpose: "
## Task
Execute Phase N: <description>

## Plan Excerpt
<paste full phase content>

## Context
- Key decisions: <from state file>
- Files to reference: <from context file>
- Patterns to follow: <from context file>

## Constraints
- Follow existing patterns exactly
- Run tests after changes
- Report: files modified, decisions made, blockers
"
```

**Key rules:**
- Provide plan text directly (don't make subagent read file)
- One phase at a time (sequential)
- Include decisions from previous phases

### 2.2a TDD Cycle (Per Implementation Task)

For each implementation task:

1. **RED:** Write failing test first
   - One test, one behavior
   - Run tests - confirm FAILS for expected reason (not syntax error)
   - If passes immediately: test is wrong, rewrite

2. **GREEN:** Implement minimal code
   - Simplest code to pass the test
   - No extras, no optimization
   - Run tests - confirm PASSES

3. **REFACTOR:** Clean up (optional)
   - Remove duplication, improve names
   - Run tests after each change

**Skip TDD when:** Pure refactoring (tests already exist), config-only changes, documentation

### 2.3 Checkpoint

After subagent completes:

1. Mark phase complete in state file: `- [x] Phase N`
2. Append key decisions to state file
3. **Verify TDD evidence:** Tests created/modified, suite passing
4. Update code context (files modified/created)
5. Run tests - fail fast if broken
6. **Update session file:**
   - `last_checkpoint: [timestamp]`
   - `current_phase: [N+1]`
   - Update "Current Status" section
   - Append key decisions to session for quick reference

### 2.4 Loop

Continue to next unchecked phase. All complete → Quality Check.

---

## Phase 3: Quality Check

### Verification Gate

Before claiming completion, follow protocol in `references/verification-gates.md`:

1. IDENTIFY the proving command
2. RUN it fresh
3. READ full output, check exit code
4. VERIFY output confirms claim
5. ONLY THEN make claim with evidence

### Two-Stage Review

Per `references/verification-gates.md`:
1. **Stage 1: Spec Compliance** - Built what was requested?
2. **Stage 2: Code Quality** - Code clean and tested?

Never proceed to Stage 2 if Stage 1 fails.

---

## Phase 4: Ship It

### Commit & PR

```bash
git add .
git status && git diff --staged
git commit -m "feat(scope): description

Co-Authored-By: Claude <noreply@anthropic.com>"

git push -u origin feature-branch
gh pr create --title "feat: [Description]" --body "..."
```

### Update State

Mark state file: `status: completed`

### Clear Session

Work is complete - clear the active session:

```bash
rm .flywheel/session.md
```

### Worktree Cleanup

If in worktree, offer cleanup:

```
Question: "PR created. Clean up worktree?"
Options:
1. Clean up - Remove worktree, switch to main
2. Keep - Preserve for fixes
```

---

## Recovery

If user clears context mid-execution (or context is lost):

1. User says "carry on" or runs `/fly:work` with no arguments
2. Session file (`.flywheel/session.md`) identifies active plan
3. State file contains full progress
4. New instance finds first unchecked phase
5. Loads key decisions from state file
6. Resumes execution

**No work is lost.** The session file enables seamless "carry on" recovery.

---

## Error Handling

- **Subagent failures**: Log, ask user: retry/skip/abort
- **Test failures**: Fix before checkpointing
- **Missing files**: Warn during probe, clarify before dispatch

---

## Key Principles

- **Checkpoint after each phase** - enables recovery
- **State file is source of truth** - not conversation memory
- **Sequential execution** - one phase at a time
- **Provide context to subagents** - they start fresh
- **Ship complete features** - finish what you start

---

## Anti-Patterns

- **Skip checkpoints** - lose recovery capability
- **Parallel implementation** - causes file conflicts
- **Make subagent read plan** - provide text directly
- **Ignore test failures** - fix before checkpoint

---

## Detailed References

- `references/state-file-template.md` - State file structure, recovery process
- `references/session-file-template.md` - Session file for "carry on" resume
- `references/verification-gates.md` - Verification protocol, two-stage review
