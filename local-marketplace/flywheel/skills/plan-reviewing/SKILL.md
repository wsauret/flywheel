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

**Philosophy:** Each reviewer agent represents a different stakeholder perspective (security, performance, simplicity, architecture). These perspectives legitimately conflict - a security-focused approach may sacrifice performance, a simple approach may sacrifice flexibility. **This skill does NOT resolve conflicts.** It surfaces them as Open Questions for the user to decide during consolidation. The user knows their priorities; we just present the trade-offs clearly.

## Input

The plan to review is provided via `$ARGUMENTS`. Can be:
- Path to plan file: `plans/my-feature.md`
- Empty: Check for recent plans in `plans/` directory

**Subagent Dispatch:** Follow subagent dispatch guidelines in `CLAUDE.md` - never send file contents, always request compaction format output.

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
Provide findings with priority (P1/P2/P3) and specific locations.

IMPORTANT: Also flag any OPEN QUESTIONS from your perspective:
- Trade-offs where you see multiple valid architectural approaches
- Decisions that depend on priorities you don't know (e.g., optimize for X vs Y)
- Areas where you'd want clarification before implementation
Format: 'OPEN QUESTION: [question] (Options: A, B, C if applicable)'"

Task security-reviewer: "Review this plan for security concerns.
PLAN: [full plan content]
Provide findings with priority (P1/P2/P3) and specific locations.

IMPORTANT: Also flag any OPEN QUESTIONS from your perspective:
- Security vs usability trade-offs where user preference matters
- Multiple valid security approaches with different costs
- Areas where threat model assumptions affect the recommendation
Format: 'OPEN QUESTION: [question] (Options: A, B, C if applicable)'"

# ... continue for ALL discovered agents, each with the OPEN QUESTION instruction
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

## Phase 4: Detect Conflicts and Convert to Open Questions

**CRITICAL: Do NOT resolve conflicts. Different reviewers have different valid perspectives. Convert ALL conflicts to Open Questions for the user to decide during consolidation.**

Scan findings for contradictions:
- Agent A recommends X, Agent B recommends opposite Y
- Agent A marks P1, Agent B marks same issue P3
- Agent A: "pattern appropriate" vs Agent B: "anti-pattern"

### Why We Don't Resolve Conflicts

Each reviewer agent represents a different stakeholder perspective:
- **Security reviewer**: Prioritizes safety, may recommend more restrictive approaches
- **Performance analyst**: Prioritizes speed, may recommend caching/optimization
- **Code simplicity reviewer**: Prioritizes maintainability, may recommend simpler approaches
- **Architecture strategist**: Prioritizes long-term flexibility

These perspectives legitimately conflict. The USER must decide which priority matters more for their specific context.

### Convert Each Conflict to Open Question

```markdown
### Open Question: [Topic]

**Context:** [Brief description of what the plan proposes]

**Perspective A** (security-reviewer):
> [Their recommendation and reasoning]

**Perspective B** (performance-analyst):
> [Their opposing recommendation and reasoning]

**Trade-off:** [What you gain/lose with each option]

**Options:**
- A: [Follow security-reviewer's recommendation]
- B: [Follow performance-analyst's recommendation]
- C: [Hybrid approach if applicable]
```

### Conflict Metadata (for context file)

Track conflicts found but do NOT pick winners:
- **Topic**: [what the conflict is about]
- **Agents disagreeing**: [list]
- **Converted to Open Question**: Yes
- **Resolution**: Pending user decision in consolidation

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

## Open Questions (Requires User Decision)

**Questions flagged by reviewers and conflicts between reviewers. These MUST be resolved during consolidation before implementation.**

| # | Question | Options | Source(s) |
|---|----------|---------|-----------|
| 1 | [Question from reviewer] | A: [option], B: [option] | [agent name] |
| 2 | [Conflict between agents] | A: [agent A view], B: [agent B view] | [both agents] |
| 3 | [Trade-off identified] | A: [choice], B: [choice] | [agent name] |

**Total Open Questions:** [count from individual agents] + [count from conflicts] = [total]

## Conflicts Between Reviewers (Converted to Open Questions Above)

[List each conflict briefly - full details are in the Open Questions section]

- **[Topic]**: [Agent A] vs [Agent B] → Open Question #[n]
- **[Topic]**: [Agent A] vs [Agent B] → Open Question #[n]

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

### Open Questions Generated
- [Question 1]: [Options] (from [agent])
- [Question 2]: [Options] (from conflict between [agents])
- Total: [count] questions for consolidation to resolve

### Conflicts Detected (Converted to Open Questions)
- [Conflict 1]: [Agent A] vs [Agent B] → Open Question #[n]
- None

### P1 Details (if any)
- [P1 finding 1: brief description]
- None

### Review Status
- **Approval status:** [Blocked by P1s / Ready for consolidation]
- **Open questions:** [count] requiring user decision
- **Recommended next step:** [Address P1 findings / Proceed to consolidation to resolve open questions]
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

- **Don't filter agents** - Run them ALL
- **Don't skip deduplication** - Raw output overwhelms
- **Don't resolve conflicts** - Each reviewer has a valid perspective; convert to Open Questions
- **Don't pick winners** - User decides which priority matters in their context
- **Don't hide conflicts** - They represent real trade-offs that need human attention
- **Don't downgrade P1s** - Critical issues must block
- **Don't present one-by-one** - Synthesize first

---

## Auto-Triggers

- "review plan"
- "check plan"
- "validate plan"
- "get feedback on plan"
