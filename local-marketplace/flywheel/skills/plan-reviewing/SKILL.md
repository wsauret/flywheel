---
name: plan-reviewing
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

**Subagent Dispatch:** Follow guidelines in `CLAUDE.md`.

## Input

Plan path via `$ARGUMENTS`. If empty, check for recent plans in `plans/`.

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

**Baseline reviewers:** architecture-strategist, code-simplicity-reviewer, pattern-recognition-specialist, security-reviewer, performance-analyst, data-integrity-guardian

---

## Phase 2: Run ALL Reviewers in Parallel

Launch Task for EVERY discovered agent in a SINGLE message:

```
Task architecture-strategist: "Review this plan for architectural concerns.
PLAN: [full plan content]
Provide findings with priority (P1/P2/P3) and specific locations.
Flag OPEN QUESTIONS for trade-offs or decisions needing user input."

Task security-reviewer: "Review this plan for security concerns.
PLAN: [full plan content]
Provide findings with priority (P1/P2/P3) and specific locations.
Flag OPEN QUESTIONS for security vs usability trade-offs."

# ... continue for ALL discovered agents
```

**Rules:**
- Do NOT filter agents - run them ALL
- Launch ALL in SINGLE message with multiple Task calls
- Each agent may catch something others miss

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

1. **Address P1 findings** - Must resolve before proceeding
2. **Update plan** - Incorporate feedback
3. **Run specific agent deeper** - Get more detail
4. **Proceed anyway** - Accept risks (explicit ack for P1s)
5. **Start implementation** - If no P1 findings

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
