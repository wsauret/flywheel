---
name: work-review
description: Perform exhaustive code reviews using multi-agent analysis. Reviews PRs, branches, or current changes. Saves review to docs/reviews/. Triggers on "review", "code review", "check PR".
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

Perform exhaustive code reviews using multi-agent analysis. Saves the full review to `docs/reviews/`.

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
Task reviewer-architecture(PR content)
Task reviewer-code-quality(PR content)    # Code quality (Python/TypeScript)
Task reviewer-patterns(PR content)
Task reviewer-performance(PR content)
Task reviewer-data-integrity(PR content)
```

### Conditional Agents

**If PR contains database migrations** (files matching `**/migrations/**`, `alembic/`, `prisma/migrations/`):
- Task reviewer-data-integrity(PR content)

---

## Phase 3: Synthesize Findings into Actionable Plan

The review document must be consumable by `/fly:work` as an implementation plan. Structure findings as phases with concrete, checkable steps — not just a list of observations.

### Collect & Deduplicate

- Collect findings from all agents
- Remove duplicates/overlapping findings
- Categorize by type: security, performance, architecture, quality

### Assign Severity

- **P1 (Critical)**: Security vulnerabilities, data corruption risks, breaking changes -- BLOCKS MERGE
- **P2 (Important)**: Performance issues, architectural concerns, reliability issues
- **P3 (Nice-to-have)**: Minor improvements, cleanup, documentation

### Triage P3 Findings

Before structuring the plan, present the P3 findings to the user and ask which to include:

```
P3 (Nice-to-have) findings:
1. [Finding title] — [one-line summary] (file:line)
2. [Finding title] — [one-line summary] (file:line)
3. [Finding title] — [one-line summary] (file:line)

Which P3 items should be included in the review plan?
1. All of them
2. None — drop P3 items entirely
3. Pick specific ones (list numbers)
```

Only P3 findings the user selects are included in the implementation checklist. Dropped P3 findings are omitted from the review document entirely — they are not deferred or preserved.

If there are no P3 findings, skip this step.

### Group into Implementation Phases

Convert the findings (P1, P2, and selected P3) into ordered phases:

1. **Group by file or module** — findings in the same file or closely related files become one phase
2. **Order by severity** — P1 phases first, then P2, then selected P3
3. **Respect dependencies** — if fixing A is required before B, A's phase comes first
4. **Each phase ends with a verify step** — tests must pass after each phase
5. **Keep phases small** — 2-4 steps per phase; split if larger

Each step must include: the specific file and line, what the problem is, and the concrete fix to apply.

---

## Phase 4: Persist Review

Write the full review to `docs/reviews/YYYY-MM-DD-<target-slug>.md`. This is the durable artifact that survives context clearing — always write it.

Read `references/review-document-template.md` before proceeding — it contains the output path conventions, document template with YAML frontmatter, implementation checklist format, phase grouping guidelines, and integration patterns for other skills.

**Target slug derivation:**
- PR: `pr-{number}-{title-slug}` (e.g., `pr-123-add-user-auth`)
- Branch: branch name slugified (e.g., `feature-add-user-auth`)
- Current changes: `review-current-changes`

```bash
mkdir -p docs/reviews
```

---

## Phase 5: Summary & Next Steps

Present a **brief** summary to the user (not the full document). Include the path to the saved review file so the user knows where to find it.

Read `references/summary-report-template.md` before proceeding -- it contains the full report template with all required sections.

After presenting the summary, prompt the user to address the findings:

```
What's next?
1. Implement review findings (invoke /fly:work on the review file)
2. Ship as-is (skip to /fly:ship)
```

- **Option 1**: Invoke the `work-implementation` skill with the review file path as input. The review document is structured as an actionable plan — each finding has file references, severity, and proposed solutions.
- **Option 2**: Proceed directly to shipping without addressing findings.

---

## Key Principles

- **P1 findings block merge.** Present critical findings prominently.
- **Run agents in parallel.** Launch all applicable agents simultaneously.
- **Always persist the review.** Write to `docs/reviews/` before presenting the summary. The review file is the single durable artifact that survives context clearing.
- **Prompt for implementation.** After presenting findings, offer to invoke `work-implementation` on the review file to address them.

---

## Error Handling

- **Agent failures:** Log failure, continue with remaining agents, report in summary. Minimum 50% agent success required.
- **Git/GitHub failures:** If PR not found, verify number. If branch inaccessible, suggest worktree. If gh CLI not authenticated, provide setup instructions.
- **Review file write failure:** Retry once. If still failing, output findings directly to the user rather than losing them.

---

## Anti-Patterns

- Don't present findings one-by-one asking for approval
- Don't skip agents to save time -- parallel execution is fast
- Don't create vague findings without specific file:line references
- Don't mark P1 findings as P2/P3 to avoid blocking merge
- Don't forget to run conditional agents when criteria match
- Don't skip persisting the review document — the whole point is surviving context clears
- Don't end without prompting the user to implement findings

---

## Checklists

See `checklists/` directory for domain-specific review checklists.
