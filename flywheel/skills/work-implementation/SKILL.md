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
  - TaskCreate
  - TaskUpdate
  - TaskList
  - AskUserQuestion
---

# Executing-Work Skill

Execute plans using **probe-dispatch-checkpoint** pattern. Orchestrator stays lean, dispatches subagents per phase, persists state for recovery.

**Context Compaction:** This skill manages context via `.state.md` files (progress checkpoints) and `.context.md` files (research findings). If context is lost mid-work, these files enable seamless recovery. See README for philosophy.

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

#### Resume Validation

Before offering to resume, **validate the session state**:

1. **Read state file fully** (not via subagent - critical context)
2. **Verify files in "Code Context" still exist:**
   ```bash
   # For each file in state's Code Context
   test -f "$FILE" && echo "exists" || echo "missing"
   ```
3. **Check for unexpected changes since last_checkpoint:**
   ```bash
   # Get modified files since checkpoint
   git diff --name-only --since="$LAST_CHECKPOINT"
   ```
4. **Check context file staleness:**
   - If context file >7 days old: Note warning
   - If codebase >50 commits since research: Note warning

Present validation summary:

```
Resuming: [plan name]
Phase: [N] of [M]
Last checkpoint: [timestamp] ([X hours/days] ago)

Validation:
- Files: [N] exist, [M] missing
- Changes since checkpoint: [none / list of files]
- Context staleness: [fresh / ⚠️ X days old / ⚠️ Y commits since research]

Continue? [Yes / Show details / Start fresh]
```

**If validation shows issues:**
- Missing files → Ask user to confirm (files may have been intentionally deleted)
- Unexpected changes → Show which files, ask if intentional
- Stale context → Warn but allow proceeding

**AskUserQuestion:**
```
Question: "Found active session for [plan_path]. [Validation summary]"
Options:
1. Resume (Recommended) - Continue from Phase [N]
2. Show details - View full validation report
3. Start fresh - Abandon session, ask for new plan
```

- **Resume:** Set `PLAN_PATH` from session, continue to Phase 1
- **Show details:** Display full state file and validation, ask again
- **Start fresh:** Delete session file, ask for plan path

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

### Create Baseline Plan Snapshot

**For plan compliance checking:** Copy the plan to a baseline file that won't change during execution:

```bash
BASELINE_FILE="${PLAN_PATH%.md}.baseline.md"
if [ ! -f "$BASELINE_FILE" ]; then
  cp "$PLAN_PATH" "$BASELINE_FILE"
fi
```

This baseline is what we committed to. The compliance check in `work-review` compares against this, not the potentially-evolved current plan.

**Cleanup:** Delete baseline when work completes successfully.

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

#### Format Validation

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
⚠️ Validation warnings:
- Plan missing Success Criteria section
- Context file missing research_date (can't check staleness)

Proceeding with best effort. Consider updating files for better tracking.
```

Log warnings in state file under "Validation Warnings" section (append if exists).

### Create Tasks for Each Phase

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

After subagent completes, use **dual-write approach** for redundancy:

#### 2.3.1 Update Native Tasks (Primary)

```
TaskUpdate:
  taskId: [task ID for this phase]
  status: completed
```

**Why Tasks are primary:**
- Survive terminal restarts
- Visual progress in Claude Code UI
- Stored in `~/.claude/tasks`

#### 2.3.2 Update State File (Backup)

1. Mark phase complete: `- [x] Phase N`
2. Append key decisions to state file
3. Append learnings (patterns, gotchas discovered)
4. Update code context (files modified/created)

**Why state file is backup:**
- Ralph mode recovery relies on state file
- Cross-session recovery (Tasks don't persist across sessions by default)
- Full context for cold resume

#### 2.3.3 Verify & Continue

5. **Verify TDD evidence:** Tests created/modified, suite passing
6. Run tests - fail fast if broken
7. **Update session file:**
   - `last_checkpoint: [timestamp]`
   - `current_phase: [N+1]`
   - Update "Current Status" section
   - Append key decisions to session for quick reference

### 2.3a Manual Verification Pause

**After automated verification passes, check if plan has Manual Verification criteria.**

If plan includes a "Manual Verification" section in Success Criteria:

1. Mark phase as awaiting manual: `- [~] Phase N (awaiting manual verification)`
2. **AskUserQuestion:**
   ```
   Question: "Phase [N] Complete - Ready for Manual Verification"
   Header: "Manual Check"
   Options:
   1. Continue to next phase (Recommended) - I've verified manually
   2. Continue all remaining - Skip future manual pauses
   3. Stop here - I have feedback
   ```

   Present context:
   ```
   Automated verification passed:
   - [list from state file - tests, lint, etc.]

   Please verify manually:
   - [list from plan's Manual Verification section]
   ```

3. **Handle response:**
   - **Continue:** Update marker to `[x]`, proceed to 2.4
   - **Continue all:** Set `skip_manual_pauses: true` in session file, proceed
   - **Stop here:** Keep `[~]` marker, wait for user feedback

**Skip this step if:**
- Plan has no Manual Verification section
- Session has `skip_manual_pauses: true`
- Phase is documentation-only or config-only

### 2.4 Ralph Mode Check

**After manual verification (if applicable), check Ralph trigger conditions.**

Check if Ralph mode should activate:
- Plan has >5 phases? → Ralph mode
- User invoked with `--ralph`? → Ralph mode
- Context >50% and >2 phases remain? → Ralph mode

**If Ralph mode active:**
1. Ensure state file has complete "Current Working State" section
2. Present Ralph checkpoint message (see Ralph Mode section)
3. If user clears context, they say "carry on" to resume

### 2.5 Loop

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

### Clear Session and Baseline

Work is complete - clear the active session and baseline plan:

```bash
rm .flywheel/session.md
rm "${PLAN_PATH%.md}.baseline.md" 2>/dev/null || true
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
3. **Check both sources:**
   - `TaskList` - Shows native task progress (survives terminal restarts)
   - State file - Contains full progress and key decisions
4. New instance finds first uncompleted phase (sync Tasks with state file if mismatch)
5. Loads key decisions from state file
6. Resumes execution

**No work is lost.** Dual-write (Tasks + state file) provides redundancy:
- **Tasks:** Survive terminal restarts, visual UI progress
- **State file:** Full context for Ralph mode, cross-session recovery

**Task persistence note:** Tasks are stored in `~/.claude/tasks` and survive terminal restarts. For shared task lists across team members, use `CLAUDE_CODE_TASK_LIST_ID` environment variable.

---

## Error Handling

Follow the **3-Strike Error Protocol** from `flywheel-conventions`:

1. **Attempt 1**: Diagnose & fix
2. **Attempt 2**: Alternative approach (never repeat same failing action)
3. **Attempt 3**: Broader rethink, question assumptions
4. **After 3 failures**: Log to state file Error Log, escalate to user

**Specific cases:**
- **Subagent failures**: Apply 3-Strike, then ask user: retry/skip/abort
- **Test failures**: Fix before checkpointing (3-Strike applies)
- **Missing files**: Warn during probe, clarify before dispatch

---

## Ralph Mode: Stateless Agent Loops

**Philosophy:** Agent as stateless function. Fresh context each phase. State files are THE source of truth.

Named after [Ralph Wiggum](https://ghuntley.com/ralph/) - a "hilariously dumb" but effective solution to context window limits.

### When Ralph Mode Activates

Ralph mode is triggered when ANY of these conditions are true:

1. **Plan has >5 phases** - Long tasks benefit from periodic context refresh
2. **User invokes with `--ralph` flag** - Explicit request for stateless execution
3. **Context exceeds 50% and >2 phases remain** - Proactive compaction

### Ralph Checkpoint

After each phase checkpoint in Ralph mode:

1. **Write detailed state** - Ensure state file has everything for cold resume:
   - Current phase number
   - All completed phases with summaries
   - Key decisions (exhaustive)
   - Learnings (patterns, gotchas)
   - Code context (all files modified/created)
   - Any blockers or decisions deferred

2. **Suggest context clear:**
   ```
   Phase [N] complete. Context is [X]% full with [M] phases remaining.

   Recommend clearing context and saying "carry on" for optimal performance.

   Your progress is saved in:
   - State: [state_path]
   - Session: .flywheel/session.md

   Options:
   1. Clear context now (Recommended) - Say "carry on" to resume
   2. Continue without clearing - May degrade quality on later phases
   ```

3. **If user clears:** New instance loads fresh, reads state, continues seamlessly

### State File Completeness for Ralph

In Ralph mode, state file MUST contain:

```markdown
## Progress
- [x] Phase 1: [description] - [key outcome]
- [x] Phase 2: [description] - [key outcome]
- [ ] Phase 3: [description]

## Key Decisions
- Phase 1: [decision 1 with rationale]
- Phase 1: [decision 2]
- Phase 2: [decision 3]

## Learnings
- Phase 1: [pattern discovered - file:line]
- Phase 2: [gotcha found - explanation]

## Code Context
- Created: [file1], [file2]
- Modified: [file3], [file4]

## Current Working State
<!-- For Ralph resume - what was the agent working on? -->
- Last action: [what was just completed]
- Next action: [what should happen next]
- Open questions: [any pending decisions]
```

---

## Key Principles

- **Checkpoint after each phase** - enables recovery
- **State file is source of truth** - not conversation memory
- **Sequential execution** - one phase at a time
- **Provide context to subagents** - they start fresh
- **Ship complete features** - finish what you start
- **Ralph mode for long tasks** - context clear is a feature, not a bug

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
