---
name: plan-reviewing
description: Run ALL available reviewer agents in parallel against a plan. Deduplicates findings and detects conflicts. Triggers on "review plan", "check plan", "validate plan".
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

Run ALL available reviewer agents in parallel against a plan file. Maximizes coverage by discovering and running every available reviewer, then synthesizes findings with deduplication and conflict detection.

## Input

The plan to review is provided via `$ARGUMENTS`. Can be:
- Path to plan file: `plans/my-feature.md`
- Empty: Check for recent plans in `plans/` directory

---

## Phase 1: Discover ALL Reviewer Agents

**CRITICAL: Run them ALL. Do NOT filter by relevance. 20, 30, 40 parallel agents is fine.**

```bash
# Project-local agents
find .claude/agents -name "*.md" 2>/dev/null

# User's global agents
find ~/.claude/agents -name "*.md" 2>/dev/null

# Plugin agents (flat agents/ directory)
find ~/.claude/plugins/cache -path "*/agents/*.md" 2>/dev/null

# Check installed_plugins.json for all plugin locations
cat ~/.claude/plugins/installed_plugins.json 2>/dev/null
```

### Baseline Reviewers (if available)

- `architecture-strategist` - Architecture and system design
- `code-simplicity-reviewer` - Complexity and maintainability
- `pattern-recognition-specialist` - Patterns and anti-patterns
- `security-reviewer` - Security vulnerabilities
- `performance-analyst` - Performance considerations
- `data-integrity-guardian` - Data model and database concerns

---

## Phase 2: Run ALL Reviewers in Parallel

Launch a Task for EVERY discovered agent:

```
Task architecture-strategist: "Review this plan for architectural concerns.
PLAN: [full plan content]
Provide findings with priority (P1/P2/P3) and specific locations."

Task security-reviewer: "Review this plan for security concerns.
PLAN: [full plan content]
Provide findings with priority (P1/P2/P3) and specific locations."

# ... continue for ALL discovered agents
```

**Rules:**
- Do NOT filter agents by "relevance" - run them ALL
- Launch ALL agents in a SINGLE message with multiple Task calls
- Each agent may catch something others miss
- Goal is MAXIMUM coverage, not efficiency

---

## Phase 3: Collect & Deduplicate Findings

### Deduplication Algorithm

**Identical findings** (same section + same issue + same action):
- Merge into single finding
- Note source count: "Identified by 3 agents: [agent-a, agent-b, agent-c]"
- Use highest priority among duplicates

**Similar findings** (related topic, different specifics):
- Group under common theme header
- Preserve individual details
- Example: "### Theme: Database Performance" with sub-findings

**Unique findings**: Preserve standalone

### Output Format

```markdown
## Deduplicated Findings

### Finding 1: [Title]
**Priority:** P1 (Critical)
**Sources:** architecture-strategist, security-reviewer (2 agents)
**Location:** Section 3 - Database Schema
[Merged description]

### Theme: Performance Concerns
1. **Query optimization** (performance-analyst): [Concern]
2. **Caching strategy** (architecture-strategist): [Related concern]

### Finding 3: [Unique Finding]
**Priority:** P3
**Source:** code-simplicity-reviewer
[Description]
```

---

## Phase 4: Detect Conflicts

Scan findings for contradictions:
- Agent A recommends X, Agent B recommends opposite Y
- Agent A marks P1, Agent B marks same issue P3
- Agent A: "pattern appropriate" vs Agent B: "anti-pattern"

### Conflict Format

```markdown
## CONFLICT: [Topic]

**Side A** (architecture-strategist, performance-analyst):
> [Recommendation]

**Side B** (code-simplicity-reviewer):
> [Opposing recommendation]

**Suggested resolution:** [If obvious winner based on context]
**Requires human decision:** [If genuinely ambiguous]
```

### Resolution Hints

- 3 agents vs 1 agent: "Majority recommendation: [X]"
- P1 vs P3 assessment: "Conservative approach: treat as P1"
- Context-dependent: "Depends on [factor] - recommend discussing"

---

## Phase 5: Materialize Review Summary to the Plan File

**CRITICAL:** You MUST append the review summary to THE SAME ORIGINAL PLAN FILE before presenting options or completing this skill. Review findings are worthless if not persisted to the plan.

**Target file:** The SAME `[plan_path]` that was provided as input to this skill (e.g., `plans/feat-user-auth.md`).

### Step 1: Read Current Plan Content

```bash
cat [plan_path]
```

### Step 2: Construct Review Summary Section

Create the review summary section to append:

```markdown

---

# Plan Review Summary

**Plan:** [plan_path]
**Reviewed:** [date]
**Agents run:** [count] | **Responded:** [count]

## Findings Overview

| Priority | Count | Status |
|----------|-------|--------|
| P1 (Critical) | [n] | BLOCKS APPROVAL |
| P2 (Important) | [n] | Should address |
| P3 (Nice-to-have) | [n] | Optional |

## Conflicts Detected: [count]

## P1 Findings (BLOCKS APPROVAL)
[List each with full details]

## P2 Findings (Important)
[List each]

## P3 Findings (Nice-to-have)
[List each]

## Agent Coverage
**Provided findings:** [agent]: [count], ...
**No findings:** [agent]: "Looks good from [perspective]"
**Failed:** [agent]: [error]
```

### Step 3: Write Back to the ORIGINAL Plan File

Use the **Write tool** to write the plan file with the review summary APPENDED at the end:

```
Write: [plan_path]   <-- SAME FILE that was input
Content: [Original plan content + "---" separator + Review Summary section]
```

**DO NOT create a separate review file.** Append to the SAME plan file that was provided as input.

**This step is NON-OPTIONAL.** If you skip this, all review findings are lost.

### Step 4: Verify Write Success

```bash
# Verify file was updated with review section
grep -c "Plan Review Summary" [plan_path]
# Should return 1
```

### Priority Classification

- **P1 (Critical)**: BLOCKS approval - security vulnerabilities, data corruption risks, fundamental design flaws
- **P2 (Important)**: Should address - performance issues, architectural concerns, maintainability problems
- **P3 (Nice-to-have)**: Optional - style suggestions, minor optimizations, documentation gaps

---

## Phase 6: Update Context File

Update the context file with review metadata. This serves as an audit trail of what review was performed.

### Step 1: Determine Context File Path

The context file path is derived from the plan path:
- Plan: `plans/feat-user-auth.md`
- Context: `plans/feat-user-auth.context.md`

```bash
# Check if context file exists
CONTEXT_PATH="${plan_path%.md}.context.md"
test -f "$CONTEXT_PATH" && echo "Context file exists"
```

### Step 2: Append Review Metadata

Read the existing context file and append the review record:

```markdown
## Review [YYYY-MM-DD HH:MM]

### Agent Coverage
- **Agents discovered:** [count]
- **Agents run:** [count]
- **Agents responded:** [count]
- **Agents failed:** [count]

### Findings Summary
| Priority | Count | Status |
|----------|-------|--------|
| P1 (Critical) | [n] | [BLOCKS APPROVAL / None] |
| P2 (Important) | [n] | [Should address / None] |
| P3 (Nice-to-have) | [n] | [Optional / None] |

### Conflicts Detected
- [Conflict 1: brief description]
- None

### P1 Details (if any)
- [P1 finding 1: brief description]
- None

### Review Status
- **Approval status:** [Blocked by P1s / Ready for implementation]
- **Recommended next step:** [Address P1 findings / Proceed to consolidation]
```

### Step 3: Write Updated Context File

```
Write: [CONTEXT_PATH]
Content: [Original context content + Review metadata section]
```

---

## Phase 7: Post-Review Options

1. **Address P1 findings** - Must resolve before proceeding
2. **Update plan** - Incorporate feedback
3. **Run specific agent deeper** - Get more detail
4. **Proceed anyway** - Accept risks (explicit ack for P1s)
5. **Start implementation** - If no P1 findings

---

## Error Handling

- **Agent failures**: Log, continue with others, report in summary. Need 50% success minimum.
- **Plan not found**: Ask user to verify path
- **Agent timeout**: Log as "timed out", continue with others

---

## Anti-Patterns

- Don't filter agents - Run them ALL
- Don't skip deduplication - Raw output overwhelms
- Don't hide conflicts - Contradictions need human attention
- Don't downgrade P1s - Critical issues must block
- Don't present one-by-one - Synthesize first

---

## Auto-Triggers

- "review plan"
- "check plan"
- "validate plan"
- "get feedback on plan"
