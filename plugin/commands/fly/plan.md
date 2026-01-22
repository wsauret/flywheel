---
name: fly:plan
description: Full planning workflow - create, deepen, and review. Orchestrates three independent skills.
argument-hint: "[feature description OR path to *-design.md OR path to existing plan]"
---

# Full Planning Workflow

**Note: The current year is 2026.**

<input> #$ARGUMENTS </input>

This orchestrator coordinates the full planning workflow by calling three independent skills in sequence, then consolidating:
1. **plan-creation** - Research and create the initial plan
2. **plan-deepening** - Enhance with skills, learnings, and research agents (writes to plan file)
3. **plan-reviewing** - Run all reviewer agents and synthesize findings (writes to plan file)
4. **consolidation** - Restructure into a single, actionable plan ready for `/fly:work`

Each skill can also be invoked independently. All outputs are materialized to the same plan file.

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
- Writes review summary **to the plan file**

**Capture output:**
- `REVIEWERS_RUN` = Count of reviewer agents executed
- `FINDINGS_COUNT` = Total findings (P1, P2, P3)
- `CONFLICTS_COUNT` = Number of conflicts detected

---

## Phase 4: Consolidate into Final Actionable Plan

After deepening and reviewing, the plan file contains:
- Original plan content
- Enhancement Summary (from deepening)
- Research Insights subsections (from deepening)
- Plan Review Summary (from reviewing)

**This phase consolidates everything into a clean, work-ready format.**

### Step 1: Read the Current Plan

```bash
cat [PLAN_PATH]
```

### Step 2: Restructure into Actionable Format

Reorganize the plan into this final structure:

```markdown
# [Plan Title]

## Status
- **Created:** [date]
- **Deepened:** [date]
- **Reviewed:** [date]
- **Ready for:** /fly:work

## Executive Summary
[1-2 paragraph synthesis of what this plan accomplishes]

## Critical Items Before Implementation
[Extract P1 findings that MUST be addressed - if any]
[Extract unresolved conflicts - if any]

## Implementation Checklist

### Phase 1: [Name]
- [ ] Step 1.1: [Concrete action]
  - **Research insight:** [Relevant finding from deepening]
  - **Review note:** [Relevant finding from review, if any]
- [ ] Step 1.2: [Concrete action]
  ...

### Phase 2: [Name]
- [ ] Step 2.1: [Concrete action]
  ...

[Continue for all phases]

## Technical Reference

### Best Practices to Follow
[Consolidated from Research Insights - deduplicated]

### Anti-Patterns to Avoid
[Consolidated from Research Insights + Review findings]

### Code Examples
[Key code snippets from Research Insights, organized by topic]

### Security Considerations
[Consolidated security items from deepening + review]

### Performance Considerations
[Consolidated performance items from deepening + review]

## Review Findings Summary

### Addressed in Plan
[P1/P2 items that have been incorporated into the implementation checklist above]

### Deferred Items
[P3 items that are nice-to-have but not blocking]

### Resolved Conflicts
[How each conflict was resolved, if any]

---
## Appendix: Raw Research & Review Data
<details>
<summary>Original Enhancement Summary</summary>
[The Enhancement Summary section from deepening]
</details>

<details>
<summary>Original Review Summary</summary>
[The Plan Review Summary section from reviewing]
</details>
```

### Step 3: Write Consolidated Plan

Use the **Write tool** to overwrite the plan file with the consolidated version:

```
Write: [PLAN_PATH]
Content: [The consolidated plan markdown]
```

### Step 4: Verify Consolidation

```bash
# Verify the plan has the new structure
grep -c "Implementation Checklist" [PLAN_PATH]
# Should return 1
```

### Step 5: Update Context File

Update the context file with consolidation metadata to complete the audit trail.

**Context file path:** `[PLAN_PATH with .md replaced by .context.md]`
- Plan: `plans/feat-user-auth.md`
- Context: `plans/feat-user-auth.context.md`

Append the consolidation record:

```markdown
## Consolidation [YYYY-MM-DD HH:MM]

### Actions Performed
- Restructured into actionable checklist format
- Integrated research insights into implementation steps
- Consolidated review findings
- Created Technical Reference section

### Plan Status
- **P1 findings:** [count] ([addressed/blocking])
- **P2 findings:** [count] (incorporated)
- **P3 findings:** [count] (deferred)
- **Conflicts:** [count] ([resolved/pending])

### Ready for Implementation
- **Status:** [Ready for /fly:work | Blocked by P1 findings]
- **Checklist items:** [count]
- **Implementation phases:** [count]
```

Write the updated context file:

```
Write: [CONTEXT_PATH]
Content: [Original context content + Consolidation metadata section]
```

**Result:** The plan file is now a single, coherent, actionable document ready for `/fly:work`. The context file contains a complete audit trail of all phases.

---

## Phase 5: Present Results

Display comprehensive summary:

```
Plan Complete & Consolidated

Plan: [PLAN_PATH]
Context: [CONTEXT_PATH]

Phases:
- Create: [completed | skipped (existing plan)]
- Deepen: [SKILLS_APPLIED] skills, [LEARNINGS_APPLIED] learnings applied
- Review: [REVIEWERS_RUN] reviewers, [FINDINGS_COUNT] findings (P1: [n], P2: [n], P3: [n])
- Consolidate: Restructured into actionable checklist format

Conflicts: [CONFLICTS_COUNT or None - note if resolved during consolidation]

Critical Items (if any):
- [P1 findings that need resolution before implementation]
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
       | (writes Enhancement Summary + Research Insights TO PLAN FILE)
       v                       |
   SKILLS_APPLIED              |
   LEARNINGS_APPLIED           |
       |                       |
       v                       |
[Phase 3: Review] <------------+
       |
       | (writes Review Summary TO PLAN FILE)
       v
   REVIEWERS_RUN
   FINDINGS_COUNT
   CONFLICTS_COUNT
       |
       v
[Phase 4: Consolidate]
       |
       | (restructures plan into actionable format)
       v
   PLAN_PATH (now contains consolidated, work-ready content)
       |
       v
[Phase 5: Present]
       |
       v
[Post-Execution Options]
```

**Key Point:** After Phase 4, the plan file at `PLAN_PATH` is a single, coherent document with:
- Implementation checklist with concrete steps
- Research insights integrated into relevant steps
- Review findings addressed or deferred
- Ready for `/fly:work`

---

## Error Handling

### Phase Failures

- **plan-creation fails**: Report error, do not proceed to deepening
- **plan-deepening fails**: Report error, still run review on original plan
- **plan-reviewing fails**: Report error, still run consolidation on what we have
- **consolidation fails**: Report error, present the un-consolidated plan (still has all content, just not restructured)

### Recovery

- Each phase writes to disk before completing (deepening and reviewing both write to the plan file)
- Re-running `/fly:plan` with an existing plan path skips creation
- Context file tracks which phases completed
- If consolidation fails, the plan file still contains all research and review content (just not reorganized)

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
- **Single plan file** - All phases write to the SAME plan file (deepening adds insights, reviewing adds summary, consolidation restructures)
- **Materialize before proceeding** - Each skill MUST write its outputs to the plan file before completing
- **State handoff** - Plan path captured from Phase 1 flows to all subsequent phases
- **Graceful degradation** - Partial failures still produce useful output
- **User control** - Post-execution options let user choose next action
- **Independent skills** - Each skill can also be invoked directly
- **Work-ready output** - After consolidation, the plan is ready for `/fly:work` with actionable checklists
