---
name: work-review
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

## Phase 1.0: Plan Compliance Check

**Run this phase FIRST when reviewing work from a `/fly:work` execution.**

Check for `docs/plans/*.state.md`. If a state file exists, this was planned work -- run a compliance check comparing implementation against the baseline plan. If no state file exists, skip to Phase 1.5.

Read `references/plan-compliance.md` before proceeding -- it contains the full compliance report template, baseline plan logic, and the four compliance checks to run.

Include the compliance report as the **first section** of review output. Flag significant deviations (P1) prominently.

---

## Phase 1.5: Setup

### Determine Review Target

```bash
git branch --show-current
# If PR number, fetch metadata
gh pr view <PR_NUM> --json title,body,files
```

### Setup Environment

**If already on target branch:** Proceed with analysis.

**If different branch:** Offer worktree option via `skill: git-worktree`.

Ensure code is ready for analysis before proceeding.

---

## Phase 2: Run Reviewer Agents

### Parallel Review Agents

Run ALL applicable agents simultaneously:

```
Task code-quality-reviewer(PR content)    # Code quality (Python/TypeScript)
Task git-history-reviewer(PR content)     # History context
Task pattern-reviewer(PR content)
Task architecture-reviewer(PR content)
Task security-reviewer(PR content)
Task performance-reviewer(PR content)
Task code-simplicity-reviewer(PR content)
```

### Conditional Agents

**If PR contains database migrations** (files matching `**/migrations/**`, `alembic/`, `prisma/migrations/`):
- Task data-integrity-reviewer(PR content)

---

## Phase 3: Synthesize Findings

### Collect & Categorize

- Collect findings from all agents
- Remove duplicates/overlapping findings
- Categorize by type: security, performance, architecture, quality

### Assign Severity

- **P1 (Critical)**: Security vulnerabilities, data corruption risks, breaking changes -- BLOCKS MERGE
- **P2 (Important)**: Performance issues, architectural concerns, reliability issues
- **P3 (Nice-to-have)**: Minor improvements, cleanup, documentation

### Estimate Effort

Tag each finding: Small / Medium / Large

---

## Phase 4: Track Findings

Create a todo file for each finding using the built-in task system.

Read `references/todo-format.md` before proceeding -- it contains the file naming convention, required YAML frontmatter structure, and all required sections (problem statement, findings, proposed solutions, acceptance criteria, work log).

Always tag findings with `code-review` plus relevant tags: `security`, `performance`, `architecture`, `quality`.

---

## Phase 5: Summary Report

Present a summary report showing finding counts by severity, created todo files grouped by priority, and next steps.

Read `references/summary-report-template.md` before proceeding -- it contains the full report template with all required sections.

---

## Key Principles

- **P1 findings block merge.** Present critical findings prominently.
- **Run agents in parallel.** Launch all applicable agents simultaneously.
- **Create todos immediately.** Don't present findings one-by-one for approval. Create all todo files, then summarize.
- **Use built-in tasks.** Ensures findings are tracked and actionable.

---

## Error Handling

- **Agent failures:** Log failure, continue with remaining agents, report in summary. Minimum 50% agent success required.
- **Git/GitHub failures:** If PR not found, verify number. If branch inaccessible, suggest worktree. If gh CLI not authenticated, provide setup instructions.
- **Todo file failures:** Create `docs/todos/` directory if missing. If write fails, report and continue. Save partial results rather than losing all findings.

---

## Anti-Patterns

- Don't present findings one-by-one asking for approval
- Don't skip agents to save time -- parallel execution is fast
- Don't create vague findings without specific file:line references
- Don't mark P1 findings as P2/P3 to avoid blocking merge
- Don't forget to run conditional agents when criteria match

---

## Checklists

See `checklists/` directory for domain-specific review checklists.
