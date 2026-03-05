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
  - AskUserQuestion
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

**Plan reviewers:** reviewer-architecture, reviewer-code-quality, reviewer-patterns, reviewer-performance, reviewer-data-integrity

**Note:** These reviewers may catch external claim issues (version mismatches, anti-patterns, security concerns) as part of their normal review. There is no separate enrichment/validation step — plan-creation handles initial validation, and reviewers provide a second check from their respective perspectives.

---

## Phase 2: Run ALL Reviewers in Parallel

Launch Task for EVERY discovered agent in a SINGLE message:

```
Task reviewer-architecture: "Review this plan for architectural concerns.
PLAN: [full plan content]
Provide findings with priority (P1/P2/P3) and specific locations.
Flag OPEN QUESTIONS for trade-offs or decisions needing user input.
IMPORTANT: Return ALL findings in your response message only. Do NOT write to any files — no editing the plan, no creating review files, no overflow files. The orchestrator handles all file writes."

Task reviewer-performance: "Review this plan for performance concerns.
PLAN: [full plan content]
Provide findings with priority (P1/P2/P3) and specific locations.
Flag OPEN QUESTIONS for performance vs simplicity trade-offs.
IMPORTANT: Return ALL findings in your response message only. Do NOT write to any files — no editing the plan, no creating review files, no overflow files. The orchestrator handles all file writes."

# ... continue for ALL discovered agents
# EVERY agent prompt MUST include the "Do NOT write to any files" instruction above
```

**Rules:**
- Do NOT filter agents - run them ALL
- Launch ALL in SINGLE message with multiple Task calls
- Each agent may catch something others miss
- **Every agent prompt MUST include the no-file-write constraint** — agents have Write/Edit tools and will use them unless explicitly told not to

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

## Phase 6: Post-Review Options

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

- `references/review-summary-template.md` - Output format, deduplication patterns
- `references/conflict-handling.md` - Philosophy, detection patterns, Open Question conversion
