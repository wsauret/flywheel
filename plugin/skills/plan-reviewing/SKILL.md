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

## Phase 5: Write Review Summary

```markdown
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

### Priority Classification

- **P1 (Critical)**: BLOCKS approval - security vulnerabilities, data corruption risks, fundamental design flaws
- **P2 (Important)**: Should address - performance issues, architectural concerns, maintainability problems
- **P3 (Nice-to-have)**: Optional - style suggestions, minor optimizations, documentation gaps

---

## Phase 6: Update Context File (Optional)

If context file exists for the plan:

```bash
ls plans/.context/[plan-name].md 2>/dev/null
```

Append review details:
```markdown
## Review [date]
**Agents:** [count] run, [count] responded
**Findings:** P1: [n], P2: [n], P3: [n]
**Conflicts:** [count]
**Status:** [Pending P1 resolution / Ready for implementation]
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
