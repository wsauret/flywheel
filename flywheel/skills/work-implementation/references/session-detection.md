# Session Detection (Phase 0)

Detailed validation logic, presentation templates, and edge cases for detecting and resuming active sessions.

## Check for Active Session

```bash
test -f .flywheel/session.md && echo "Active session found"
```

## If Session Exists AND No Arguments Provided

Read session file frontmatter:

```bash
head -20 .flywheel/session.md
```

### Resume Validation

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

### Present Validation Summary

```
Resuming: [plan name]
Phase: [N] of [M]
Last checkpoint: [timestamp] ([X hours/days] ago)

Validation:
- Files: [N] exist, [M] missing
- Changes since checkpoint: [none / list of files]
- Context staleness: [fresh / warning X days old / warning Y commits since research]

Continue? [Yes / Show details / Start fresh]
```

### Handling Validation Issues

- Missing files: Ask user to confirm (files may have been intentionally deleted)
- Unexpected changes: Show which files, ask if intentional
- Stale context: Warn but allow proceeding

### AskUserQuestion Template

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

## If Session Exists AND Arguments Provided

Compare session `plan_path` with provided argument:
- **Same plan:** Resume session
- **Different plan:** Ask whether to switch or continue existing

## If No Session

Proceed normally - require plan path from arguments or ask user.
