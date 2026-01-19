---
name: executing-work
description: Execute work plans efficiently while shipping complete features. Loads context files, follows patterns, tests continuously. Triggers on "work on", "implement", "build", "execute plan".
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

## Input

Plan path via `$ARGUMENTS`. Can be a plan, specification, or todo file.

---

## Phase 1: Load & Resume

### Check for Existing State

```bash
STATE_FILE="${PLAN_PATH%.md}.state.md"
if [ -f "$STATE_FILE" ]; then
  echo "✅ Found execution state - resuming"
fi
```

**If state file exists:**
1. Read state file to find last checkpoint
2. Identify first unchecked phase
3. Load key decisions and code context
4. Resume from that phase

**If no state file:** Create initial state file from plan.

### Load Context

```bash
CONTEXT_FILE="${PLAN_PATH%.md}.context.md"
```

Load from context file:
- **File References** - key files to understand
- **Gotchas & Warnings** - prevent common mistakes
- **Naming Conventions** - follow exactly

### Create State File

**File:** `plans/<plan-name>.state.md`

```markdown
---
plan: <plan-name>.md
status: in_progress
schema_version: 1
---

# Execution State: <Plan Name>

## Progress
- [ ] Phase 1: <description>
- [ ] Phase 2: <description>
- [ ] Phase 3: <description>

## Key Decisions
<!-- Append decisions as they are made -->

## Code Context
<!-- Track files modified/created -->
```

### Get Approval

Ask: "Ready to execute plan. Work on current branch or create worktree?"

---

## Phase 2: Execute (Per-Phase Loop)

For each unchecked phase in Progress:

### 2.1 Probe Phase Files

Quick check of files referenced in phase:
- Count files and estimate total lines
- If > 500 lines total: warn user, consider splitting
- Note any missing files

### 2.2 Dispatch Subagent

```
Task general-purpose: "
## Task
Execute Phase N: <phase description>

## Plan Excerpt
<paste full phase content from plan>

## Context
- Key decisions so far: <from state file>
- Files to reference: <from context file>
- Patterns to follow: <from context file>

## Constraints
- Follow existing patterns exactly
- Run tests after changes
- Report: files modified, decisions made, any blockers
"
```

**Key rules:**
- Provide plan text directly (don't make subagent read file)
- One phase at a time (sequential, not parallel)
- Include decisions from previous phases

### 2.3 Checkpoint

After subagent completes:

1. **Mark phase complete** in state file:
   ```markdown
   - [x] Phase 1: <description>
   ```

2. **Append key decisions:**
   ```markdown
   ## Key Decisions
   - Phase 1: Using repository pattern for data access
   - Phase 1: Tests in `__tests__/` directory
   ```

3. **Update code context:**
   ```markdown
   ## Code Context
   - Created: `src/services/auth.ts`
   - Modified: `src/routes/index.ts`
   ```

4. **Run tests** - fail fast if broken

### 2.4 Loop

Continue to next unchecked phase. If all phases complete, proceed to Quality Check.

---

## Phase 3: Quality Check

### Run Tests

```bash
# Auto-detect project type
npm test || pytest || cargo test || go test ./...
```

### Optional Reviewers

For complex changes (10+ files or security-sensitive):

```
Task code-simplicity-reviewer: "Review changes"
Task security-sentinel: "Check for vulnerabilities"
```

Run reviewers in parallel. Present findings.

---

## Phase 4: Ship It

### Create Commit

```bash
git add .
git status
git diff --staged

git commit -m "$(cat <<'EOF'
feat(scope): description

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### Create PR

```bash
git push -u origin feature-branch
gh pr create --title "feat: [Description]" --body "..."
```

### Update State

Mark state file as completed:

```markdown
---
status: completed
---
```

---

## Recovery

If orchestrator compacts mid-execution:

1. State file contains full progress
2. New instance reads state file
3. Finds first unchecked phase
4. Loads key decisions for context
5. Resumes execution

**No work is lost.**

---

## Error Handling

### Subagent Failures
- Log failure with phase and error
- Ask user: retry, skip, or abort?
- Don't checkpoint failed phases

### Test Failures
- Fix immediately before checkpointing
- If blocked, note in state file and ask user

### Missing Files
- Warn during probe phase
- Ask user to clarify before dispatching

---

## Key Principles

- **Checkpoint after each phase** - enables recovery
- **State file is source of truth** - not conversation memory
- **Sequential execution** - one phase at a time
- **Provide context to subagents** - they start fresh
- **Ship complete features** - finish what you start

---

## Anti-Patterns

- **Skipping checkpoints** - lose recovery capability
- **Parallel implementation** - causes file conflicts
- **Making subagent read plan** - provide text directly
- **Ignoring test failures** - fix before checkpoint
- **Complex state files** - keep them simple (checkboxes)
