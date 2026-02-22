# Parallel Execution

How to dispatch and manage parallel phase groups during work execution.

## When This Applies

Only when the plan's Implementation Checklist contains `<!-- parallel-group: N -->` annotations on two or more phases with the same group number. If no annotations exist, ignore this reference entirely — all phases run sequentially as before.

## Critical Constraint: `subtask send` Blocks

`subtask send` blocks until the worker finishes. A single `subtask send` call will occupy the Bash tool until that worker completes. **The only way to run workers concurrently is to dispatch multiple `subtask send` calls as separate parallel Bash tool calls, each with `run_in_background: true`.**

If you call them sequentially, they execute one after the other — no parallelism.

## Full Procedure

### Step 1: Draft All Subtasks (Sequential)

Drafting is fast and doesn't block. Draft each subtask in the group one at a time:

```bash
subtask draft phase-2/api-endpoints \
  --base-branch "$(git branch --show-current)" \
  --title "Phase 2: API endpoints" <<'PLAN'
## Task
Execute Phase 2: API endpoints
...
PLAN
```

```bash
subtask draft phase-3/cli-commands \
  --base-branch "$(git branch --show-current)" \
  --title "Phase 3: CLI commands" <<'PLAN'
## Task
Execute Phase 3: CLI commands
...
PLAN
```

### Step 2: Send All Workers (Parallel)

**This is the critical step.** Dispatch all workers in the group using **separate parallel Bash tool calls**, each with `run_in_background: true`:

```
Bash tool call 1 (run_in_background: true):
  subtask send phase-2/api-endpoints "Go ahead."

Bash tool call 2 (run_in_background: true):
  subtask send phase-3/cli-commands "Go ahead."
```

Both workers start immediately and run concurrently in their own git worktrees. You will be notified as each one completes.

**Anti-pattern:** Do NOT chain these in a single Bash call with `&&` — that makes them sequential.

**Anti-pattern:** Do NOT forget `run_in_background: true` — without it the tool call blocks your entire session until the worker finishes, preventing the second dispatch.

### Step 3: Wait for All Workers

Stop and wait. You'll be notified when each background task completes. Do not proceed to review/merge until ALL workers in the group have finished.

If one worker finishes significantly before the others, you may review its changes early (`subtask diff --stat`), but do NOT merge until all are done.

### Step 4: Review Each Worker's Changes

After all workers complete, review each one:

```bash
subtask diff --stat phase-2/api-endpoints
subtask diff --stat phase-3/cli-commands
```

Check for unexpected overlap. If two workers modified the same file despite the plan marking them as parallel-safe, this is a planning error. You'll likely hit a merge conflict in Step 5 — see Conflict Handling below.

### Step 5: Merge Sequentially

Merge workers **one at a time, in phase order**. Even though the work was parallel, merges must be sequential to maintain a clean git history and catch conflicts early.

```bash
subtask merge phase-2/api-endpoints -m "Phase 2: API endpoints"
# verify: git log -1 --oneline
subtask merge phase-3/cli-commands -m "Phase 3: CLI commands"
# verify: git log -1 --oneline
```

**Why sequential merges?** Each merge creates a commit on the base branch. The second merge must rebase/merge against a branch that now includes the first worker's changes. If the phases are truly file-disjoint, this is clean. If not, you'll get a conflict on the second merge.

### Step 6: Run Tests Once

After all merges complete, run the test suite once for the whole group:

```bash
# whatever the project's test command is
make test
```

Do NOT run tests after each individual merge — that wastes time when the phases are independent.

### Step 7: Checkpoint the Group

See the "Parallel Group Checkpoint" section in `checkpoint-procedure.md`. Mark all phases in the group as complete in a single state file update.

## Conflict Handling

If a merge fails due to conflicts:

### Assess Severity

1. **Trivial conflict** (e.g., adjacent lines in a config file): Resolve manually in the worktree, complete the merge
2. **Significant conflict** (overlapping logic): The parallel annotation was wrong. Close the conflicting subtask, re-execute that phase sequentially after the first merge
3. **Widespread conflicts**: Close all unmerged subtasks. Fall back to sequential execution for the remaining phases in the group

### Recovery Steps

```bash
# Check what conflicted
subtask diff phase-3/cli-commands

# Option A: Resolve in worktree
# Navigate to worktree, fix conflicts, complete merge

# Option B: Abandon and redo sequentially
subtask close phase-3/cli-commands
# Re-draft and re-execute Phase 3 as a sequential phase
```

### Update State File

Record the conflict in the state file's Learnings section:

```markdown
## Learnings
- Parallel group 1 (Phases 2+3): Merge conflict on [file]. Phases share [reason]. Resolved by [method].
```

This learning helps future plans avoid the same mistake.

## State File Format for Parallel Groups

Parallel phases are tracked with a group annotation in the Progress section:

```markdown
## Progress
- [x] Phase 1: Foundation
- [x] Phase 2: API endpoints (parallel-group: 1)
- [x] Phase 3: CLI commands (parallel-group: 1)
- [ ] Phase 4: Integration tests
```

The group annotation is informational — it records that these phases ran in parallel, which is useful context for recovery and for learning from conflicts.

## Resuming After Context Loss

If context is lost mid-parallel-group:

- **All phases in group complete:** Normal resume — continue to next phase
- **Some phases in group complete, some not:** Check which subtasks are still open (`subtask list`). For completed-but-unmerged subtasks, merge them. For incomplete subtasks, check if workers are still running (`subtask show`). Resume or re-dispatch as needed.
- **No phases in group started:** Re-dispatch the whole group

The state file tracks per-phase completion, so recovery knows exactly which phases in the group still need work.
