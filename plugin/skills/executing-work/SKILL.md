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

Execute plans systematically. Focus on **shipping complete features** by understanding requirements quickly, following existing patterns, and maintaining quality throughout.

## Input

The plan path is provided via `$ARGUMENTS`. Can be a plan, specification, or todo file.

---

## Phase 1: Quick Start

### Load Plan & Context

1. **Read the plan completely**

2. **Check for companion context file:**
   ```bash
   CONTEXT_FILE="${PLAN_PATH%.md}.context.md"
   if [ -f "$CONTEXT_FILE" ]; then
     echo "✅ Found research context: $CONTEXT_FILE"
   fi
   ```

3. **If context file exists, use it:**
   - Load "File References" section - these are key files to understand
   - Note "Gotchas & Warnings" - these prevent common mistakes
   - Reference "Naming Conventions" - follow exactly
   - Check "External Research" for documentation links

4. **Ask clarifying questions now** - better to ask than build wrong thing

5. **Get user approval to proceed**

### Setup Environment

Ask user: "Work in parallel with worktree or on current branch?"

**Worktree** (recommended for parallel development):
```
skill: git-worktree
```

**Live branch**:
```bash
git checkout main && git pull origin main
git checkout -b feature-branch-name
```

### Create Todo List

Use TodoWrite to break plan into actionable tasks:
- Include dependencies between tasks
- Prioritize by order needed
- Include testing and quality check tasks
- Keep tasks specific and completable

---

## Phase 2: Execute

### Task Execution Loop

```
while (tasks remain):
  - Mark task as in_progress in TodoWrite
  - Read any referenced files from plan
  - Look for similar patterns in codebase
  - Implement following existing conventions
  - Write tests for new functionality
  - Run tests after changes
  - Mark task as completed
```

### Follow Existing Patterns

**If context file exists:**
- Load files from "File References" first
- Follow "Naming Conventions" - don't guess
- Check "Gotchas & Warnings" before major changes
- Reference "Similar Implementations"

**Always:**
- Read plan-referenced code first
- Match naming conventions exactly
- Reuse existing components
- Follow project coding standards (CLAUDE.md)

### Test Continuously

- Run relevant tests after each significant change
- Don't wait until the end
- Fix failures immediately
- Add new tests for new functionality

### Track Progress

- Keep TodoWrite updated
- Note blockers or unexpected discoveries
- Create new tasks if scope expands
- Inform user of major milestones

---

## Phase 3: Quality Check

### Core Quality Checks

```bash
# Run test suite (auto-detect project type)
npm test        # Node.js/TypeScript
pytest          # Python
cargo test      # Rust
go test ./...   # Go

# Run linting (per CLAUDE.md)
```

### Reviewer Agents (Optional)

Use only for complex, risky, or large changes:

```
Task code-simplicity-reviewer: "Review changes for simplicity"
Task architecture-strategist: "Check architectural patterns"
Task performance-oracle: "Check for performance issues"
Task security-sentinel: "Scan for vulnerabilities"
```

Run reviewers in parallel. Present findings to user.

### Final Validation

- [ ] All TodoWrite tasks completed
- [ ] All tests pass
- [ ] Linting passes
- [ ] Code follows existing patterns
- [ ] No console errors or warnings

---

## Phase 4: Ship It

### Create Commit

```bash
git add .
git status  # Review what's being committed
git diff --staged  # Check changes

git commit -m "$(cat <<'EOF'
feat(scope): description of what and why

Brief explanation if needed.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### Screenshots (UI Changes)

For any design changes, capture before/after screenshots:
1. Start dev server
2. Capture at appropriate viewport sizes
3. Include URLs in PR description

### Create Pull Request

```bash
git push -u origin feature-branch-name

gh pr create --title "feat: [Description]" --body "$(cat <<'EOF'
## Summary
- What was built
- Why it was needed

## Testing
- Tests added/modified
- Manual testing performed

## Screenshots
| Before | After |
|--------|-------|
| ![before](URL) | ![after](URL) |

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### Notify User

- Summarize what was completed
- Link to PR
- Note any follow-up work
- Suggest next steps (e.g., `/fly:review`)

---

## Key Principles

### Start Fast, Execute Faster
- Get clarification once at start, then execute
- The goal is to **finish the feature**

### The Plan is Your Guide
- Check for `.context.md` file - pre-researched references
- Load those references and follow them
- Don't reinvent - match what exists

### Test As You Go
- Run tests after each change, not at the end
- Continuous testing prevents big surprises

### Ship Complete Features
- Mark all tasks completed before moving on
- Don't leave features 80% done
- A finished feature that ships beats a perfect feature that doesn't

---

## When to Use Reviewer Agents

**Don't use by default.** Use only when:
- Large refactor (10+ files)
- Security-sensitive changes
- Performance-critical code
- Complex algorithms
- User explicitly requests

For most features: tests + linting + following patterns is sufficient.

---

## Error Handling

### Test Failures
- Fix failures immediately before moving on
- If blocked, note in TodoWrite and ask user
- Don't accumulate failing tests

### Build Failures
- Check error messages carefully
- Reference context file for common gotchas
- Ask user if pattern is unclear

### Agent Failures
- Log failure with agent name and error
- Continue without reviewer feedback if agents fail
- Reviewer agents are optional enhancements

## Anti-Patterns

- **Analysis paralysis** - Read the plan and execute
- **Skipping clarifying questions** - Ask now, not after building wrong thing
- **Ignoring plan references** - The plan has links for a reason
- **Testing at the end** - Test continuously
- **Forgetting TodoWrite** - Track progress
- **80% done syndrome** - Finish the feature
