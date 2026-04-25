# Checkpoint Procedure

Dual-write checkpoint approach and manual verification pause for Phase 2 execution loop.

## Dual-Write Checkpoint (After Subagent Completes)

### Step 1: Update Native Tasks (Primary)

```
TaskUpdate:
  taskId: [task ID for this phase]
  status: completed
```

**Why Tasks are primary:**
- Survive terminal restarts
- Visual progress in Claude Code UI
- Stored in `~/.claude/tasks`

### Step 2: Update State File (Backup)

1. Mark phase complete: `- [x] Phase N`
2. Append key decisions to state file
3. Append learnings (patterns, gotchas discovered)
4. Update code context (files modified/created)

**Why state file is backup:**
- Ralph mode recovery relies on state file
- Cross-session recovery (Tasks don't persist across sessions by default)
- Full context for cold resume

### Step 3: Verify & Continue

5. **Verify TDD evidence:** Tests created/modified, suite passing
6. Run tests - fail fast if broken
7. **Update session file:**
   - `last_checkpoint: [timestamp]`
   - `current_phase: [N+1]`
   - Update "Current Status" section
   - Append key decisions to session for quick reference

---

## Manual Verification Pause

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
   - **Continue:** Update marker to `[x]`, proceed to Ralph mode check
   - **Continue all:** Set `skip_manual_pauses: true` in session file, proceed
   - **Stop here:** Keep `[~]` marker, wait for user feedback

### Skip Manual Verification When

- Plan has no Manual Verification section
- Session has `skip_manual_pauses: true`
- Phase is documentation-only or config-only
