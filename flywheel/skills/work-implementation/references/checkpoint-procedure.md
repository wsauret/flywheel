# Checkpoint Procedure

Checkpoint approach after subtask merge, with dual-write state tracking and manual verification pause for Phase 2 execution loop.

## Checkpoint (After Subtask Merge)

### Step 0: Verify Subtask Merge Succeeded

```bash
# Record pre-merge HEAD for rollback capability
PRE_MERGE_SHA=$(git rev-parse HEAD)

# After subtask merge, verify the merge commit exists
git log -1 --oneline
```

**If merge fails:** Do NOT update state file or Tasks. Log the failure. Retry or escalate per 3-Strike protocol.

**If merge succeeds:** Record the merge commit SHA and proceed to Step 1.

### Step 1: Update Native Tasks (Secondary Tracking)

```
TaskUpdate:
  taskId: [task ID for this phase]
  status: completed
```

**Note:** TaskUpdate happens AFTER merge verification. Tasks provide visual progress in Claude Code UI but are secondary to the state file.

### Step 2: Update State File (Source of Truth)

1. Mark phase complete: `- [x] Phase N`
2. Record subtask name and merge commit SHA
3. Record pre-merge HEAD SHA (for rollback capability)
4. Append key decisions to state file
5. Append learnings (patterns, gotchas discovered)
6. Update code context (files modified/created)

**Why state file is source of truth:**
- Ralph mode recovery relies on state file
- Cross-session recovery (Tasks don't persist across sessions by default)
- Full context for cold resume
- Merge commit SHA enables precise rollback

### Step 3: Verify & Continue

7. **Verify TDD evidence:** Tests created/modified, suite passing
8. Run tests - fail fast if broken
9. **Update session file:**
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
