---
name: fly:plan
description: Full planning workflow - create, deepen, and review. Orchestrates three independent skills.
argument-hint: "[feature description OR path to *-design.md OR path to existing plan]"
---

# Full Planning Workflow

**Note: The current year is 2026.**

<input> #$ARGUMENTS </input>

This orchestrator coordinates the full planning workflow by calling three independent skills in sequence:
1. **plan-creation** - Research and create the initial plan
2. **plan-deepening** - Enhance with skills, learnings, and research agents
3. **plan-reviewing** - Run all reviewer agents and synthesize findings

Each skill can also be used independently.

---

## Input Detection

**Check the input type to determine which phases to run:**

### Detection Logic

```
If input ends with "-design.md" AND file exists:
  -> DESIGN MODE
  -> Read design doc for context
  -> Run: plan-creation (uses design as input) -> plan-deepening -> plan-reviewing

If input is ".md" file in plans/ AND file exists:
  -> REVIEW MODE
  -> Skip creation, use existing plan
  -> Run: plan-deepening -> plan-reviewing

Otherwise:
  -> FULL MODE
  -> Run: plan-creation -> plan-deepening -> plan-reviewing
```

### Determine Mode

1. **Check if input ends with `-design.md`:**
   ```bash
   test -f "[input]" && echo "Design doc exists"
   ```
   If exists: Set `MODE=design`, `DESIGN_PATH=[input]`

2. **Check if input is existing plan in `plans/`:**
   ```bash
   test -f "[input]" && [[ "[input]" == plans/*.md ]] && echo "Existing plan"
   ```
   If exists: Set `MODE=review`, `PLAN_PATH=[input]`

3. **Otherwise:** Set `MODE=full`, `FEATURE_DESCRIPTION=[input]`

---

## Phase 1: Create Plan (if MODE != review)

**Skip this phase if `MODE=review` (existing plan provided).**

Invoke the plan-creation skill:

```
skill: plan-creation
arguments: [input - either feature description or design doc path]
```

**Capture output:**
- `PLAN_PATH` = Path to created plan file (e.g., `plans/feat-user-authentication.md`)
- `CONTEXT_PATH` = Path to context file (e.g., `plans/feat-user-authentication.context.md`)

**If plan-creation presents post-creation options, select "Deepen plan" to continue the flow.**

---

## Phase 2: Deepen Plan

Invoke the plan-deepening skill with the plan path:

```
skill: plan-deepening
arguments: [PLAN_PATH]
```

This phase:
- Discovers and applies ALL available skills from all 5 sources
- Checks documented learnings from `docs/solutions/`
- Launches per-section research agents
- Queries Context7 for framework documentation
- Synthesizes and deduplicates findings
- Adds "Research Insights" subsections to each plan section

**Capture output:**
- `SKILLS_APPLIED` = Count of skills used
- `LEARNINGS_APPLIED` = Count of relevant learnings incorporated

**If plan-deepening presents post-enhancement options, select "Run plan review" to continue the flow.**

---

## Phase 3: Review Plan

Invoke the plan-reviewing skill with the enhanced plan:

```
skill: plan-reviewing
arguments: [PLAN_PATH]
```

This phase:
- Discovers ALL available reviewer agents
- Runs ALL reviewers in parallel (no filtering)
- Deduplicates findings
- Detects conflicts between recommendations
- Writes review summary

**Capture output:**
- `REVIEWERS_RUN` = Count of reviewer agents executed
- `FINDINGS_COUNT` = Total findings (P1, P2, P3)
- `CONFLICTS_COUNT` = Number of conflicts detected

---

## Phase 4: Present Results

Display comprehensive summary:

```
Plan Complete

Plan: [PLAN_PATH]
Context: [CONTEXT_PATH]

Phases:
- Create: [completed | skipped (existing plan)]
- Deepen: [SKILLS_APPLIED] skills, [LEARNINGS_APPLIED] learnings applied
- Review: [REVIEWERS_RUN] reviewers, [FINDINGS_COUNT] findings (P1: [n], P2: [n], P3: [n])

Conflicts: [CONFLICTS_COUNT or None]

P1 Findings (if any):
- [List critical findings that need resolution]
```

---

## Post-Execution Options

Use **AskUserQuestion** to present next steps:

**Question:** "Plan ready at `[PLAN_PATH]`. What would you like to do?"

**Options:**

1. **Start /fly:work (Recommended)** - Begin implementation with the enhanced, reviewed plan
2. **View detailed findings** - Show full review report with all findings
3. **Address conflicts** - Work through conflicting recommendations interactively
4. **Address P1 findings** - Resolve critical issues before proceeding
5. **Open plan in editor** - Review the plan file manually

### Handle Selection

| Selection | Action |
|-----------|--------|
| Start /fly:work | Invoke `skill: executing-work` with `PLAN_PATH` |
| View detailed findings | Display full review summary from Phase 3 |
| Address conflicts | List each conflict, gather user resolution, update plan |
| Address P1 findings | List P1s, discuss resolution for each, update plan |
| Open plan in editor | Run `open [PLAN_PATH]` |

---

## State Flow Between Phases

The orchestrator maintains state between phases:

```
[Input Detection]
       |
       v
   MODE, INPUT
       |
       v
[Phase 1: Create] -----> PLAN_PATH, CONTEXT_PATH
       |                       |
       v                       |
[Phase 2: Deepen] <------------+
       |                       |
       v                       |
   SKILLS_APPLIED              |
   LEARNINGS_APPLIED           |
       |                       |
       v                       |
[Phase 3: Review] <------------+
       |
       v
   REVIEWERS_RUN
   FINDINGS_COUNT
   CONFLICTS_COUNT
       |
       v
[Phase 4: Present]
       |
       v
[Post-Execution Options]
```

---

## Error Handling

### Phase Failures

- **plan-creation fails**: Report error, do not proceed to deepening
- **plan-deepening fails**: Report error, still run review on original plan
- **plan-reviewing fails**: Report error, present results from successful phases

### Recovery

- Each phase writes to disk before completing
- Re-running `/fly:plan` with an existing plan path skips creation
- Context file tracks which phases completed

---

## Examples

### Full Mode (Feature Description)

```
/fly:plan Add user authentication with OAuth2 support
```

Runs: plan-creation -> plan-deepening -> plan-reviewing

### Design Mode (Design Doc)

```
/fly:plan plans/oauth2-authentication-design.md
```

Runs: plan-creation (uses design) -> plan-deepening -> plan-reviewing

### Review Mode (Existing Plan)

```
/fly:plan plans/feat-user-authentication.md
```

Runs: plan-deepening -> plan-reviewing (skips creation)

---

## Key Principles

- **Orchestration only** - This file coordinates skills, does not implement them
- **Sequential phases** - Each phase completes before the next begins
- **State handoff** - Plan path captured from Phase 1 flows to Phases 2 and 3
- **Graceful degradation** - Partial failures still produce useful output
- **User control** - Post-execution options let user choose next action
- **Independent skills** - Each skill can also be invoked directly
