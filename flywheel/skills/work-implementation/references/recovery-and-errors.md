# Recovery & Error Handling

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

## Error Handling

Follow the **3-Strike Error Protocol** from `flywheel-conventions`:

1. **Attempt 1**: Diagnose & fix
2. **Attempt 2**: Alternative approach (never repeat same failing action)
3. **Attempt 3**: Broader rethink, question assumptions
4. **After 3 failures**: Log to state file Error Log, escalate to user

### Specific Cases

- **Subagent failures**: Apply 3-Strike, then ask user: retry/skip/abort
- **Test failures**: Fix before checkpointing (3-Strike applies)
- **Missing files**: Warn during probe, clarify before dispatch
- **Subtask failures**: Use `subtask show <task>` for status, `subtask log <task>` for conversation history. Apply 3-Strike, then ask user: retry/skip/abort
- **Subtask merge conflicts**: Worker's changes conflict with main branch. Options: resolve in worktree, close subtask and redo phase, or manual merge. Use `subtask diff <task>` to inspect conflicting changes before deciding
