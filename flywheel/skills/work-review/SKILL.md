---
name: work-review
description: Perform exhaustive code reviews using multi-agent analysis. Reviews PRs, branches, or current changes. Saves review to docs/reviews/ and creates todo files for findings. Triggers on "review", "code review", "check PR".
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

Perform exhaustive code reviews using multi-agent analysis. Saves the full review to `docs/reviews/` and creates actionable todo files in `docs/todos/`.

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

## Phase 2: Run Reviewer Agents via Subtask Dispatch

Reviewers are read-only, but subtask gives them isolation and persistence through context compaction.

### Naming Convention

Subtask names follow: `review/<target-slug>/<reviewer-type>`

Example: if reviewing PR #123 titled "Add user auth", the slug is `pr-123-add-user-auth`, and subtask names are `review/pr-123-add-user-auth/code-quality`, `review/pr-123-add-user-auth/security`, etc.

### Step 1: Write Subtask Manifest

Before dispatching, write `.flywheel/review-subtasks.md` listing all reviewer subtask names. This enables result collection after context compaction.

```markdown
# Review Subtasks — <target-slug>
- review/<target-slug>/code-quality
- review/<target-slug>/git-history
- review/<target-slug>/pattern
- review/<target-slug>/architecture
- review/<target-slug>/security
- review/<target-slug>/performance
- review/<target-slug>/code-simplicity
# conditional:
# - review/<target-slug>/data-integrity  (if migrations present)
```

### Step 2: Draft ALL Reviewer Subtasks

Draft one subtask per reviewer. Use the current branch as base (reviewers are read-only, no merge needed).

```bash
subtask draft review/<target-slug>/code-quality \
  --base-branch "$(git branch --show-current)" \
  --title "Review: code-quality" <<'EOF'
Review this PR/branch for code quality concerns (Python/TypeScript).

TARGET: <branch or PR identifier>
FILES CHANGED:
<file list from gh pr view or git diff --stat>

DIFF:
<diff content or instructions to read files>

Provide findings with priority (P1/P2/P3) and specific file:line locations.
EOF
```

Repeat for ALL reviewers: `code-quality`, `git-history`, `pattern`, `architecture`, `security`, `performance`, `code-simplicity`.

### Conditional Agents

**If PR contains database migrations** (files matching `**/migrations/**`, `alembic/`, `prisma/migrations/`):
- Also draft `review/<target-slug>/data-integrity` with migration-focused review prompt
- Add to the manifest

### Step 3: Send ALL with Background Execution

Send each subtask using `run_in_background: true` in the Bash tool. Launch ALL in a SINGLE message with multiple Bash calls:

```bash
# Bash tool: run_in_background: true
subtask send review/<target-slug>/code-quality "Go ahead."
```

```bash
# Bash tool: run_in_background: true
subtask send review/<target-slug>/security "Go ahead."
```

Continue for ALL reviewer subtasks (including conditional ones). Each runs in parallel in its own worktree.

### Step 4: Poll Until All Complete

Wait for all reviewers to finish. Poll with reasonable delay:

```bash
subtask list --status doing
```

Repeat until the count of `doing` tasks reaches 0. All reviewers have finished when none remain in `doing` status.

### Step 5: Collect Results

Read each reviewer's output:

```bash
subtask show review/<target-slug>/code-quality
subtask show review/<target-slug>/security
# ... for each reviewer
```

Use the manifest from `.flywheel/review-subtasks.md` to enumerate all subtask names (essential after context compaction).

### Step 6: Cleanup Reviewer Subtasks

After collecting all results, close every reviewer subtask to free worktrees:

```bash
subtask close review/<target-slug>/code-quality
subtask close review/<target-slug>/security
# ... for each reviewer
```

This prevents orphaned worktrees. Do this BEFORE the synthesis phase.

**Rules:**
- Launch ALL sends in a SINGLE message with multiple Bash calls (`run_in_background: true`)
- Don't skip agents to save time -- parallel execution is fast
- Reviewers are read-only -- close (don't merge) when done

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

## Phase 5: Persist Review

Write the full review to `docs/reviews/YYYY-MM-DD-<target-slug>.md`. This is the durable artifact that survives context clearing — always write it.

Read `references/review-document-template.md` before proceeding — it contains the output path conventions, document template with YAML frontmatter, all required sections (findings by severity, agent coverage, todo file references), and integration patterns for other skills.

**Target slug derivation:**
- PR: `pr-{number}-{title-slug}` (e.g., `pr-123-add-user-auth`)
- Branch: branch name slugified (e.g., `feature-add-user-auth`)
- Current changes: `review-current-changes`

```bash
mkdir -p docs/reviews
```

---

## Phase 6: Summary Report

Present a **brief** summary to the user (not the full document). Include the path to the saved review file so the user knows where to find it.

Read `references/summary-report-template.md` before proceeding -- it contains the full report template with all required sections.

---

## Key Principles

- **P1 findings block merge.** Present critical findings prominently.
- **Run agents in parallel.** Launch all applicable agents simultaneously.
- **Create todos immediately.** Don't present findings one-by-one for approval. Create all todo files, then summarize.
- **Always persist the review.** Write to `docs/reviews/` before presenting the summary. The saved file is the durable artifact that survives context clearing.

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
- Don't skip persisting the review document — the whole point is surviving context clears

---

## Checklists

See `checklists/` directory for domain-specific review checklists.
