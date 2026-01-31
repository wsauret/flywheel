---
name: executing-work
description: Execute work plans using probe-dispatch-checkpoint pattern. Orchestrator stays lean, dispatches subagents per phase. Triggers on "work on", "implement", "execute plan".
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

**Subagent Dispatch:** Follow guidelines in `CLAUDE.md`.

## Input

Plan path via `$ARGUMENTS`. Can be a plan, specification, or todo file.

---

## Phase 1: Load & Resume

### Check for Existing State

```bash
STATE_FILE="${PLAN_PATH%.md}.state.md"
test -f "$STATE_FILE" && echo "Found execution state - resuming"
```

**If state file exists:** Resume from first unchecked phase, load key decisions.

**If no state file:** Create initial state using `references/state-file-template.md`.

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

1. Mark phase complete: `- [x] Phase N`
2. Append key decisions
3. **Verify TDD evidence:** Tests created/modified, suite passing
4. Update code context (files modified/created)
5. Run tests - fail fast if broken

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

If orchestrator compacts mid-execution:

1. State file contains full progress
2. New instance reads state file
3. Finds first unchecked phase
4. Loads key decisions
5. Resumes execution

**No work is lost.**

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
- `references/verification-gates.md` - Verification protocol, two-stage review
