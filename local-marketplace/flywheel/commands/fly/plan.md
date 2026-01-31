---
name: fly:plan
description: Full planning workflow - create, verify, review, and consolidate. Orchestrates four independent skills.
argument-hint: "[feature description OR path to *-design.md OR path to existing plan]"
---

# Full Planning Workflow

**Note: The current year is 2026.**

<input> #$ARGUMENTS </input>

This orchestrator coordinates the full planning workflow by calling four independent skills in sequence:
1. **plan-creation** - Research and create the initial plan
2. **plan-verification** - Verify assumptions are real, validate against docs, check compatibility (writes to plan file)
3. **plan-review** - Run all reviewer agents and synthesize findings (writes to plan file)
4. **plan-consolidation** - Restructure into a single, actionable plan ready for `/fly:work`

Each skill can also be invoked independently. All outputs are materialized to the same plan file.

---

## IMPORTANT: Planning Mode Only

**DO NOT WRITE OR EDIT ANY CODE DURING PLANNING!**

This entire workflow is for research and planning only. Implementation happens later in `/fly:work`.

- ✅ Research the codebase (read files, search patterns)
- ✅ Query documentation and best practices
- ✅ Write and edit markdown plan files in `plans/`
- ✅ Create context files for downstream phases
- ❌ Do NOT create or edit source code files
- ❌ Do NOT implement any features or fixes
- ❌ Do NOT modify application code, tests, or configs
- ❌ That's for `/fly:work` after the plan is approved

---

## Input Detection

**Check the input type to determine which phases to run:**

### Detection Logic

```
If input ends with "-design.md" AND file exists:
  -> DESIGN MODE
  -> Read design doc for context
  -> Run: plan-creation (uses design as input) -> plan-verification -> plan-review

If input is ".md" file in plans/ AND file exists:
  -> REVIEW MODE
  -> Skip creation, use existing plan
  -> Run: plan-verification -> plan-review

Otherwise:
  -> FULL MODE
  -> Run: plan-creation -> plan-verification -> plan-review
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

## Phase 2: Verify Plan

Invoke the plan-verification skill with the plan path:

```
skill: plan-verification
arguments: [PLAN_PATH]
```

This phase:
- Validates technical claims against framework documentation
- Checks for DRY violations and existing solutions in codebase
- Verifies version compatibility
- Confirms proposed APIs/features actually exist
- Adds "Research Validation" subsections to each plan section

**Capture output:**
- `CLAIMS_VALIDATED` = Count of claims verified
- `ISSUES_FOUND` = Blockers, warnings, and enhancements identified

**If plan-verification presents post-verification options, select "Run plan review" to continue the flow.**

---

## Phase 3: Review Plan

Invoke the plan-review skill with the enhanced plan:

```
skill: plan-review
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

After verification and reviewing, the plan file contains scattered content:
- Original plan content
- Verification Summary (from plan-verification)
- Research Validation subsections (from plan-verification)
- Plan Review Summary (from plan-review)

**This phase consolidates everything into a clean, work-ready format using the plan-consolidation skill.**

### Invoke the Consolidation Skill

```
skill: plan-consolidation
arguments: [PLAN_PATH]
```

This skill:
- Extracts all research insights, review findings, and implementation steps
- Synthesizes into a single actionable document with checklists
- Integrates insights directly into relevant implementation steps
- Handles P1 findings and conflicts appropriately
- Preserves raw data in collapsible Appendix sections
- Updates the context file with consolidation metadata

**Capture output:**
- `CHECKLIST_ITEMS` = Count of checklist items created
- `PHASES_COUNT` = Number of implementation phases
- `P1_STATUS` = "all addressed" or "N blocking"
- `CONFLICTS_STATUS` = "all resolved" or "N pending"

**If plan-consolidation presents post-consolidation options, select "Start /fly:work" to continue OR address blocking items first if any P1 findings remain unresolved.**

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
- Verify: [CLAIMS_VALIDATED] claims validated, [ISSUES_FOUND] issues found
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
| Start /fly:work | Invoke `skill: work-implementation` with `PLAN_PATH` |
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
[Phase 2: Verify] <------------+
       |                       |
       | (skill: plan-verification)
       | (writes Verification Summary + Research Validation TO PLAN FILE)
       v                       |
   CLAIMS_VALIDATED            |
   ISSUES_FOUND                |
       |                       |
       v                       |
[Phase 3: Review] <------------+
       |
       | (skill: plan-review)
       | (writes Review Summary TO PLAN FILE)
       v
   REVIEWERS_RUN
   FINDINGS_COUNT
   CONFLICTS_COUNT
       |
       v
[Phase 4: Consolidate]
       |
       | (skill: plan-consolidation)
       | (restructures entire plan into actionable format)
       v
   CHECKLIST_ITEMS
   PHASES_COUNT
   P1_STATUS
   CONFLICTS_STATUS
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
- Technical reference section with best practices and code examples
- Raw data preserved in collapsible Appendix
- Ready for `/fly:work`

---

## Error Handling

### Phase Failures

- **plan-creation fails**: Report error, do not proceed to verification
- **plan-verification fails**: Report error, still run review on original plan
- **plan-review fails**: Report error, still run consolidation on what we have
- **plan-consolidation fails**: Report error, present the un-consolidated plan (still has all content, just not restructured)

### Recovery

- Each phase writes to disk before completing (verification, reviewing, and consolidation all write to the plan file)
- Re-running `/fly:plan` with an existing plan path skips creation
- Context file tracks which phases completed
- If consolidation fails, the plan file still contains all research and review content (just not reorganized)
- Consolidation creates a `.pre-consolidation.backup` file that can be restored

---

## Examples

### Full Mode (Feature Description)

```
/fly:plan Add user authentication with OAuth2 support
```

Runs: plan-creation -> plan-verification -> plan-review -> plan-consolidation

### Design Mode (Design Doc)

```
/fly:plan plans/oauth2-authentication-design.md
```

Runs: plan-creation (uses design) -> plan-verification -> plan-review -> plan-consolidation

### Review Mode (Existing Plan)

```
/fly:plan plans/feat-user-authentication.md
```

Runs: plan-verification -> plan-review -> plan-consolidation (skips creation)

### Consolidation Only Mode

```
/fly:consolidate plans/feat-user-authentication.md
```

Runs: plan-consolidation only (for plans already deepened and reviewed)

---

## Key Principles

- **Orchestration only** - This file coordinates skills, does not implement them
- **Sequential phases** - Each phase completes before the next begins
- **Single plan file** - All phases write to the SAME plan file (verification adds validation, reviewing adds summary, consolidation restructures)
- **Materialize before proceeding** - Each skill MUST write its outputs to the plan file before completing
- **State handoff** - Plan path captured from Phase 1 flows to all subsequent phases
- **Graceful degradation** - Partial failures still produce useful output
- **User control** - Post-execution options let user choose next action
- **Independent skills** - Each skill can also be invoked directly:
  - `skill: plan-creation` - Create a plan
  - `skill: plan-verification` - Validate assumptions and claims
  - `skill: plan-review` - Run reviewer agents
  - `skill: plan-consolidation` - Restructure for work
- **Work-ready output** - After consolidation, the plan is ready for `/fly:work` with actionable checklists
