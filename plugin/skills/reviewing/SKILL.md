---
name: reviewing
description: Perform exhaustive code reviews using multi-agent analysis. Reviews PRs, branches, or current changes. Creates todo files for findings. Triggers on "review", "code review", "check PR".
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Bash
  - Task
  - Skill
---

# Reviewing Skill

Perform exhaustive code reviews using multi-agent analysis. Creates actionable todo files for all findings.

## Input

The review target is provided via `$ARGUMENTS`. Can be:
- PR number (numeric): `123`
- GitHub URL: `https://github.com/org/repo/pull/123`
- Branch name: `feature/my-branch`
- Empty: Review current branch changes

---

## Phase 1: Setup

### Determine Review Target

```bash
# Check current branch
git branch --show-current

# If PR number, fetch metadata
gh pr view <PR_NUM> --json title,body,files
```

### Setup Environment

**If already on target branch:** Proceed with analysis

**If different branch:** Offer worktree option
```
skill: git-worktree
```

Ensure code is ready for analysis before proceeding.

---

## Phase 2: Run Reviewer Agents

### Parallel Review Agents

Run ALL applicable agents simultaneously:

```
Task typescript-reviewer(PR content)   # TypeScript/JavaScript
Task python-reviewer(PR content)       # Python
Task git-history-analyzer(PR content)  # History context
Task pattern-recognition-specialist(PR content)
Task architecture-strategist(PR content)
Task security-sentinel(PR content)
Task performance-oracle(PR content)
Task code-simplicity-reviewer(PR content)
Task agent-native-reviewer(PR content) # Agent accessibility
```

### Conditional Agents

**If PR contains database migrations:**
- Task data-integrity-guardian(PR content)

Check files matching: `**/migrations/**`, `alembic/`, `prisma/migrations/`

---

## Phase 3: Synthesize Findings

### Collect & Categorize

- Collect findings from all agents
- Remove duplicates/overlapping findings
- Categorize by type: security, performance, architecture, quality

### Assign Severity

- **P1 (Critical)**: Security vulnerabilities, data corruption risks, breaking changes - BLOCKS MERGE
- **P2 (Important)**: Performance issues, architectural concerns, reliability issues
- **P3 (Nice-to-have)**: Minor improvements, cleanup, documentation

### Estimate Effort

Tag each finding: Small / Medium / Large

---

## Phase 4: Create Todo Files

Use file-todos skill for structured todo management:

```
skill: file-todos
```

### File Creation

For each finding, create todo file:

**Naming:** `{issue_id}-pending-{priority}-{description}.md`

**Examples:**
```
001-pending-p1-path-traversal-vulnerability.md
002-pending-p2-concurrency-limit.md
003-pending-p3-unused-parameter.md
```

### Todo Structure

Each todo must include:
- **YAML frontmatter**: status, priority, issue_id, tags, dependencies
- **Problem Statement**: What's broken/missing, why it matters
- **Findings**: Discoveries with evidence/location
- **Proposed Solutions**: 2-3 options with pros/cons/effort
- **Acceptance Criteria**: Testable checklist items
- **Work Log**: Initial entry with review date

**Always tag:** `code-review` plus relevant: `security`, `performance`, `architecture`, `quality`

---

## Phase 5: Summary Report

```markdown
## ✅ Code Review Complete

**Review Target:** PR #XXX - [Title]
**Branch:** [branch-name]

### Findings Summary:
- **Total:** [X]
- **🔴 CRITICAL (P1):** [count] - BLOCKS MERGE
- **🟡 IMPORTANT (P2):** [count] - Should Fix
- **🔵 NICE-TO-HAVE (P3):** [count] - Enhancements

### Created Todo Files:

**P1 - Critical:**
- `001-pending-p1-{finding}.md`

**P2 - Important:**
- `002-pending-p2-{finding}.md`

**P3 - Nice-to-Have:**
- `003-pending-p3-{finding}.md`

### Next Steps:
1. Address P1 findings before merge
2. Run `/triage` for interactive approval
3. Run `/resolve-file-todos` to fix approved items
```

---

## Key Principles

### P1 Findings Block Merge

Any **🔴 P1 (CRITICAL)** findings must be addressed before merging. Present these prominently.

### Run Agents in Parallel

Speed matters. Launch all applicable agents simultaneously.

### Create Todos Immediately

Don't present findings one-by-one for approval. Create all todo files, then summarize.

### Use file-todos Skill

Structured todo management ensures findings are tracked and actionable.

---

## Error Handling

### Agent Failures
- Log failure with agent name and error
- Continue with remaining agents
- Report failures in summary
- Minimum 50% agent success to produce useful output

### Git/GitHub Failures
- If PR not found, ask user to verify PR number
- If branch not accessible, suggest worktree or manual checkout
- If gh CLI not authenticated, provide setup instructions

### Todo File Creation Failures
- If todos directory doesn't exist, create it
- If file write fails, report error and continue with others
- Save partial results rather than losing all findings

---

## Anti-Patterns

- Don't present findings one-by-one asking for approval
- Don't skip agents to save time - parallel execution is fast
- Don't create vague findings without specific file:line references
- Don't mark P1 findings as P2/P3 to avoid blocking merge
- Don't forget to run conditional agents when criteria match

---

## Checklists

See `checklists/` directory for domain-specific review checklists.
