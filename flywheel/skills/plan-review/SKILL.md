---
name: plan-review
description: Run ALL reviewer agents in parallel against a plan. Deduplicates findings and converts conflicts to Open Questions. Triggers on "review plan", "check plan".
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Bash
  - Task
  - Skill
---

# Plan Reviewing Skill

Run ALL available reviewer agents in parallel, then synthesize findings with deduplication and conflict-to-question conversion.

**Philosophy:** Each reviewer represents a different stakeholder perspective. These perspectives legitimately conflict. We do NOT resolve conflicts—we surface them as Open Questions for the user to decide.

## Input

Plan path via `$ARGUMENTS`. If empty, check for recent plans in `docs/plans/`.

---

## Phase 1: Discover ALL Reviewers

**Run them ALL. Do NOT filter by relevance.**

```bash
# Project-local agents
find .claude/agents -name "*.md" 2>/dev/null

# User's global agents
find ~/.claude/agents -name "*.md" 2>/dev/null

# Plugin agents
find ~/.claude/plugins/cache -path "*/agents/*.md" 2>/dev/null
```

**Baseline reviewers:** architecture-reviewer, code-simplicity-reviewer, pattern-reviewer, security-reviewer, performance-reviewer, data-integrity-reviewer, agent-native-reviewer

---

## Phase 2: Run ALL Reviewers via Subtask Dispatch

Reviewers are read-only, but subtask gives them isolation and persistence through context compaction.

### Naming Convention

Subtask names follow: `review/<plan-slug>/<reviewer-type>`

Example: if the plan is `docs/plans/add-auth.md`, the slug is `add-auth`, and subtask names are `review/add-auth/architecture`, `review/add-auth/security`, etc.

### Step 1: Write Subtask Manifest

Before dispatching, write `.flywheel/review-subtasks.md` listing all reviewer subtask names. This enables result collection after context compaction.

```markdown
# Review Subtasks — <plan-slug>
- review/<plan-slug>/architecture
- review/<plan-slug>/security
- review/<plan-slug>/code-simplicity
# ... one line per reviewer
```

### Step 2: Draft ALL Reviewer Subtasks

Draft one subtask per discovered reviewer. Use the current branch as base (reviewers are read-only, no merge needed).

```bash
subtask draft review/<plan-slug>/architecture \
  --base-branch "$(git branch --show-current)" \
  --title "Review: architecture" <<'EOF'
Review this plan for architectural concerns.

PLAN:
<full plan content>

Provide findings with priority (P1/P2/P3) and specific file:line locations.
Flag OPEN QUESTIONS for trade-offs or decisions needing user input.
EOF
```

Repeat for EVERY discovered reviewer agent. Do NOT filter -- run them ALL.

### Step 3: Send ALL with Background Execution

Send each subtask using `run_in_background: true` in the Bash tool. Launch ALL in a SINGLE message with multiple Bash calls:

```bash
# Bash tool: run_in_background: true
subtask send review/<plan-slug>/architecture "Go ahead."
```

```bash
# Bash tool: run_in_background: true
subtask send review/<plan-slug>/security "Go ahead."
```

```bash
# Bash tool: run_in_background: true
subtask send review/<plan-slug>/code-simplicity "Go ahead."
```

Continue for ALL reviewer subtasks. Each runs in parallel in its own worktree.

### Step 4: Poll Until All Complete

Wait for all reviewers to finish. Poll with reasonable delay:

```bash
subtask list --status doing
```

Repeat until the count of `doing` tasks reaches 0. All reviewers have finished when none remain in `doing` status.

### Step 5: Collect Results

Read each reviewer's output:

```bash
subtask show review/<plan-slug>/architecture
subtask show review/<plan-slug>/security
# ... for each reviewer
```

Use the manifest from `.flywheel/review-subtasks.md` to enumerate all subtask names (essential after context compaction).

### Step 6: Cleanup Reviewer Subtasks

After collecting all results, close every reviewer subtask to free worktrees:

```bash
subtask close review/<plan-slug>/architecture
subtask close review/<plan-slug>/security
# ... for each reviewer
```

This prevents orphaned worktrees. Do this BEFORE the synthesis phase.

**Rules:**
- Do NOT filter agents -- run them ALL
- Launch ALL sends in a SINGLE message with multiple Bash calls (`run_in_background: true`)
- Each agent may catch something others miss
- Reviewers are read-only -- close (don't merge) when done

---

## Phase 3: Deduplicate Findings

**Identical findings** (same section + same issue):
- Merge into single finding
- Note source count: "Identified by 3 agents"
- Use highest priority among duplicates

**Similar findings** (related topic, different specifics):
- Group under common theme header
- Preserve individual details

**Unique findings**: Preserve standalone

See `references/review-summary-template.md` for output format.

---

## Phase 4: Detect Conflicts → Open Questions

**Do NOT resolve conflicts.** Convert ALL to Open Questions.

Scan for contradictions:
- Agent A recommends X, Agent B recommends opposite Y
- Agent A marks P1, Agent B marks same issue P3
- Agent A: "pattern appropriate" vs Agent B: "anti-pattern"

Convert each conflict using format in `references/conflict-handling.md`.

Collect individual agent Open Questions alongside conflict-generated questions.

---

## Phase 5: Append Review Summary to Plan

**CRITICAL:** Append to THE SAME plan file. Review findings are worthless if not persisted.

1. Read current plan content
2. Construct Review Summary using `references/review-summary-template.md`
3. Write back: original content + separator + Review Summary
4. Verify: `grep -c "Plan Review Summary" [plan_path]` should return 1

**This step is NON-OPTIONAL.**

---

## Phase 6: Update Context File

Append review metadata to `[plan_path].context.md`:

Use template from `references/review-summary-template.md` (Context File Update section).

---

## Phase 7: Post-Review Options

1. **Run consolidation (Recommended)** - Proceed to consolidation phase
2. **Run specific agent deeper** - Get more detail on specific concerns
3. **Done for now** - Exit and review findings manually

---

## Error Handling

- **Agent failures**: Log, continue with others. Need 50% success minimum.
- **Plan not found**: Ask user to verify path
- **Agent timeout**: Log as "timed out", continue

---

## Anti-Patterns

- **Filter agents** - Run them ALL
- **Skip deduplication** - Raw output overwhelms
- **Resolve conflicts** - Convert to Open Questions
- **Pick winners** - User decides priorities
- **Hide conflicts** - They represent real trade-offs
- **Downgrade P1s** - Critical issues must block

---

## Detailed References

- `references/review-summary-template.md` - Output format, context file template, deduplication patterns
- `references/conflict-handling.md` - Philosophy, detection patterns, Open Question conversion
