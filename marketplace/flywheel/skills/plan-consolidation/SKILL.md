---
name: plan-consolidation
description: Restructure a deepened and reviewed plan into a single, actionable document ready for /work. Synthesizes research insights, review findings, and original content into a clean checklist format. Triggers on "consolidate plan", "finalize plan", "make plan work-ready".
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
---

# Plan Consolidation Skill

Transform a plan that has been deepened (with Research Insights) and reviewed (with Review Summary) into a single, coherent, actionable document optimized for the `/work` skill.

**Philosophy:** The deepening and reviewing phases add valuable content, but scatter it throughout the document. Consolidation restructures everything into a work-ready format with checklists, integrated insights, and clear action items.

**Note: The current year is 2026.**

---

## Input

The plan file path is provided via `$ARGUMENTS`. This should be a plan that has already been:
1. Created (by plan-creation skill)
2. Deepened (by plan-deepening skill) - contains "Research Insights" subsections
3. Reviewed (by plan-reviewing skill) - contains "Plan Review Summary" section

If the plan is missing these sections, warn the user and ask whether to proceed anyway.

---

## Phase 1: Analyze Current Plan Structure

### Step 1: Read the Plan File

```bash
cat [plan_path]
```

### Step 2: Detect Required Sections

Verify the plan contains:
- [ ] **Original content** - The plan's core sections (Technical Approach, Implementation, etc.)
- [ ] **Enhancement Summary** - Added by plan-deepening at the top
- [ ] **Research Insights** - Subsections under each original section
- [ ] **Plan Review Summary** - Appended by plan-reviewing at the bottom

### Step 3: Catalog All Content

Create an inventory:

```
ORIGINAL SECTIONS:
- [Section 1 title]
- [Section 2 title]
- [Section 3 title]

RESEARCH INSIGHTS FOUND:
- Section 1: [count] insights
- Section 2: [count] insights
- Section 3: [count] insights

REVIEW FINDINGS:
- P1 (Critical): [count]
- P2 (Important): [count]
- P3 (Nice-to-have): [count]
- Conflicts: [count]
```

### Step 4: Handle Missing Sections

**If Enhancement Summary missing:**
- Warn: "Plan has not been deepened. Research insights may be limited."
- Ask: "Continue with consolidation anyway?"

**If Plan Review Summary missing:**
- Warn: "Plan has not been reviewed. No findings to incorporate."
- Ask: "Continue with consolidation anyway?"

**If both missing:**
- Error: "This plan has not been processed. Run `/fly:plan` first or deepen/review manually."

---

## Phase 2: Extract and Organize Content

### Step 1: Extract Review Findings

From the "Plan Review Summary" section, extract all findings into structured format:

```markdown
P1_FINDINGS:
- [Finding 1]: [Description] (Source: [agent])
- [Finding 2]: [Description] (Source: [agent])

P2_FINDINGS:
- [Finding 1]: [Description] (Source: [agent])

P3_FINDINGS:
- [Finding 1]: [Description] (Source: [agent])

CONFLICTS:
- [Topic]: Side A vs Side B (Resolution: [if provided])
```

### Step 2: Extract Research Insights

For each "Research Insights" subsection, extract into categories:

```markdown
BEST_PRACTICES:
- [Practice 1] (Section: [X], Source: [Y])
- [Practice 2] (Section: [X], Source: [Y])

ANTI_PATTERNS:
- [Anti-pattern 1] (Section: [X])
- [Anti-pattern 2] (Section: [X])

CODE_EXAMPLES:
- [Example 1 description] (Section: [X], Language: [Y])
  ```code```
- [Example 2 description] (Section: [X], Language: [Y])
  ```code```

SECURITY_ITEMS:
- [Item 1] (Section: [X])

PERFORMANCE_ITEMS:
- [Item 1] (Section: [X])

EDGE_CASES:
- [Edge case 1]: [Handling strategy] (Section: [X])
```

### Step 3: Extract Implementation Steps

Parse the original plan content to identify implementation phases/steps:

```markdown
IMPLEMENTATION_PHASES:
- Phase 1: [Name]
  - Step 1.1: [Action]
  - Step 1.2: [Action]
- Phase 2: [Name]
  - Step 2.1: [Action]
  - Step 2.2: [Action]
```

### Step 4: Map Insights to Implementation Steps

For each implementation step, identify relevant:
- Research insights that apply
- Review findings that affect it
- Code examples to use
- Anti-patterns to avoid

---

## Phase 3: Synthesize into Actionable Format

### Synthesis Principles

1. **Deduplicate ruthlessly** - Same insight mentioned in multiple places -> one entry
2. **Prioritize by impact** - P1 findings before P2, high-impact insights first
3. **Integrate, don't append** - Insights belong IN the checklist, not after it
4. **Preserve source attribution** - Know where recommendations came from
5. **Make it executable** - Every item should be a concrete action

### Handle Conflicts

For each conflict detected:
1. **If resolution was provided in review:** Apply it, note the decision
2. **If both sides have merit:** Present both with recommendation
3. **If genuinely ambiguous:** Flag for user decision before implementation

### Handle P1 Findings

P1 findings are CRITICAL and MUST be addressed before implementation:
- If P1s exist, add "Critical Items Before Implementation" section at the top
- Each P1 must be either:
  - Resolved with a specific action in the checklist, OR
  - Flagged as blocking (implementation cannot proceed)

---

## Phase 4: Generate Consolidated Plan

Write the consolidated plan using this structure:

```markdown
# [Plan Title]

## Status
- **Created:** [date from original plan]
- **Deepened:** [date from Enhancement Summary]
- **Reviewed:** [date from Review Summary]
- **Consolidated:** [today's date]
- **Ready for:** /fly:work

## Executive Summary

[1-2 paragraph synthesis of what this plan accomplishes. Pull from original plan overview, enhanced with key insights from deepening.]

## Critical Items Before Implementation

[Only include this section if P1 findings or unresolved conflicts exist]

### P1 Findings (MUST Address)
- **[Finding title]** (Source: [agent])
  - Issue: [Description]
  - Resolution: [How it's addressed in the checklist below, OR "BLOCKS IMPLEMENTATION"]

### Unresolved Conflicts
- **[Topic]**
  - Option A: [Description] (Supported by: [agents])
  - Option B: [Description] (Supported by: [agents])
  - **Decision needed before:** [Which phase this blocks]

## Implementation Checklist

### Phase 1: [Name]

- [ ] **Step 1.1: [Concrete action]**
  - Research insight: [Relevant finding - be specific]
  - Review note: [If any finding applies to this step]
  - Code reference: [If a code example applies]
  
- [ ] **Step 1.2: [Concrete action]**
  - Anti-pattern to avoid: [Specific warning]
  - Edge case: [What to handle]

### Phase 2: [Name]

- [ ] **Step 2.1: [Concrete action]**
  [Continue pattern...]

### Phase N: [Final Phase]

- [ ] **Step N.1: [Final action]**
- [ ] **Verification: Run tests and confirm all acceptance criteria**

## Technical Reference

### Best Practices to Follow

[Consolidated from all Research Insights - deduplicated, organized by topic]

1. **[Topic 1]**
   - [Practice] (Source: [agent/section])
   
2. **[Topic 2]**
   - [Practice] (Source: [agent/section])

### Anti-Patterns to Avoid

[Consolidated from Research Insights + Review findings]

1. **[Anti-pattern]**: [Why it's problematic]
2. **[Anti-pattern]**: [Why it's problematic]

### Code Examples

[Key code snippets from Research Insights, organized by topic. Only include examples that are directly useful for implementation.]

**[Topic/Purpose]:**
```[language]
// [File path where this would go]
[code example]
```

**[Topic/Purpose]:**
```[language]
[code example]
```

### Security Considerations

[Consolidated security items from deepening + review]

- [ ] [Security item 1]
- [ ] [Security item 2]

### Performance Considerations

[Consolidated performance items from deepening + review]

- [ ] [Performance item 1]
- [ ] [Performance item 2]

## Review Findings Summary

### Addressed in Plan

[P1/P2 items that have been incorporated into the implementation checklist above]

| Finding | Priority | Resolution | Checklist Location |
|---------|----------|------------|-------------------|
| [Finding] | P1 | [How addressed] | Phase X, Step Y |
| [Finding] | P2 | [How addressed] | Phase X, Step Y |

### Deferred Items

[P3 items that are nice-to-have but not blocking]

- **[P3 Finding]**: [Why deferred] - Consider for future iteration

### Resolved Conflicts

[How each conflict was resolved, if any]

- **[Topic]**: Chose [Option X] because [rationale]

---

## Appendix: Raw Research & Review Data

<details>
<summary>Original Enhancement Summary</summary>

[Copy the Enhancement Summary section from deepening verbatim]

</details>

<details>
<summary>Original Review Summary</summary>

[Copy the Plan Review Summary section from reviewing verbatim]

</details>

<details>
<summary>Full Research Insights by Section</summary>

[Copy all Research Insights subsections verbatim, preserving structure]

</details>
```

---

## Phase 5: Write Consolidated Plan

### Step 1: Create Backup

```bash
cp [plan_path] [plan_path].pre-consolidation.backup
```

### Step 2: Write Consolidated Content

Use the **Write tool** to overwrite the plan file with the consolidated version:

```
Write: [plan_path]
Content: [The consolidated plan markdown from Phase 4]
```

**This overwrites the plan file.** The original content with deepening and review data is preserved in the Appendix collapsible sections.

### Step 3: Verify Consolidation

```bash
# Verify the plan has the new structure
grep -c "Implementation Checklist" [plan_path]
# Should return 1

# Verify appendix contains raw data
grep -c "Raw Research & Review Data" [plan_path]
# Should return 1

# Count checklist items
grep -c "^\- \[ \]" [plan_path]
# Should match expected implementation steps
```

---

## Phase 6: Update Context File

Update the context file with consolidation metadata to complete the audit trail.

### Step 1: Determine Context File Path

```bash
CONTEXT_PATH="${plan_path%.md}.context.md"
```

### Step 2: Read Existing Context

```bash
cat [CONTEXT_PATH]
```

### Step 3: Append Consolidation Record

```markdown
## Consolidation [YYYY-MM-DD HH:MM]

### Actions Performed
- Restructured into actionable checklist format
- Integrated [X] research insights into implementation steps
- Incorporated [Y] review findings
- Created Technical Reference section
- Preserved raw data in Appendix

### Synthesis Statistics
- **Total checklist items:** [count]
- **Implementation phases:** [count]
- **Best practices consolidated:** [count]
- **Anti-patterns documented:** [count]
- **Code examples preserved:** [count]

### Plan Status
- **P1 findings:** [count] ([all addressed / N blocking])
- **P2 findings:** [count] (incorporated)
- **P3 findings:** [count] (deferred)
- **Conflicts:** [count] ([all resolved / N pending])

### Ready for Implementation
- **Status:** [Ready for /fly:work | Blocked by P1 findings | Blocked by unresolved conflicts]
- **Recommended next step:** [/fly:work [plan_path] | Address blocking items first]
```

### Step 4: Write Updated Context File

```
Write: [CONTEXT_PATH]
Content: [Original context content + Consolidation metadata section]
```

---

## Phase 7: Present Results

Display comprehensive summary to the user:

```
Plan Consolidated

Plan: [plan_path]
Context: [context_path]

Consolidation Summary:
- Implementation phases: [count]
- Checklist items: [count]
- Research insights integrated: [count]
- Review findings addressed: [count]

Status:
- P1 findings: [count] ([status])
- Conflicts: [count] ([status])
- Ready for: [/fly:work OR "Blocked - see Critical Items section"]

The plan is now structured as an actionable checklist with:
- Integrated research insights per step
- Technical reference section
- Raw data preserved in Appendix
```

---

## Phase 8: Post-Consolidation Options

Use **AskUserQuestion** to present next steps:

**Question:** "Plan consolidated at `[plan_path]`. What would you like to do?"

**Options:**

1. **Start /fly:work (Recommended)** - Begin implementation with the consolidated plan
2. **View the consolidated plan** - Open plan in editor to review
3. **Address blocking items** - Work through P1 findings or conflicts
4. **Re-run specific phase** - Deepen or review again before proceeding
5. **Revert to pre-consolidation** - Restore from backup

### Handle Selection

| Selection | Action |
|-----------|--------|
| Start /fly:work | Invoke `skill: executing-work` with `[plan_path]` |
| View plan | Run `open [plan_path]` or display content |
| Address blocking items | List each P1/conflict, discuss resolution, update plan |
| Re-run specific phase | Ask which phase, invoke corresponding skill |
| Revert | Run `cp [plan_path].pre-consolidation.backup [plan_path]` |

---

## Error Handling

### Missing Required Content

- **No original plan content:** Error - file may be corrupted
- **No Enhancement Summary:** Warn and continue (plan wasn't deepened)
- **No Review Summary:** Warn and continue (plan wasn't reviewed)
- **No implementation steps found:** Ask user to identify phases manually

### Write Failures

- If Write fails, display consolidated content to user
- Suggest saving to alternative path
- Never lose consolidation work due to write failure

### Malformed Input

- If plan structure is unexpected, attempt best-effort consolidation
- Note sections that couldn't be parsed
- Ask user to verify output

---

## Anti-Patterns

### Don't Just Append
- **Wrong:** Slap a "Consolidated Summary" at the top
- **Right:** Restructure entire document into new format

### Don't Lose Raw Data
- **Wrong:** Delete the Enhancement Summary and Review findings
- **Right:** Preserve in Appendix collapsible sections

### Don't Leave Insights Floating
- **Wrong:** "Technical Reference" section disconnected from checklist
- **Right:** Link insights directly to relevant checklist items

### Don't Ignore P1 Findings
- **Wrong:** Move P1s to "Findings Summary" and proceed
- **Right:** Either resolve them in checklist OR block implementation

### Don't Create Vague Checklists
- **Wrong:** "- [ ] Implement authentication"
- **Right:** "- [ ] Step 2.1: Create JWT token generation in `src/auth/tokens.ts`"

### Don't Over-Consolidate
- **Wrong:** Remove all nuance from conflicting recommendations
- **Right:** Preserve important context, note when judgment is required

---

## Auto-Triggers

This skill activates on:
- "consolidate plan"
- "finalize plan"
- "make plan work-ready"
- "restructure plan for work"
- "prepare plan for implementation"

---

## Quality Checks

Before finalizing consolidation:

- [ ] All P1 findings are either addressed or flagged as blocking
- [ ] All conflicts are either resolved or flagged as pending
- [ ] Every implementation step has a concrete action
- [ ] Research insights are integrated into relevant steps (not just listed)
- [ ] Code examples have file paths and are syntactically correct
- [ ] Appendix contains all original deepening/review data
- [ ] Context file updated with consolidation metadata
- [ ] Plan is genuinely ready for `/fly:work`

---

## Key Principles Summary

1. **RESTRUCTURE, NOT APPEND** - Transform the document, don't just add to it
2. **INTEGRATE INSIGHTS** - Research findings belong IN the checklist steps
3. **PRESERVE RAW DATA** - Appendix keeps full context available
4. **ADDRESS OR BLOCK** - P1 findings must be resolved or flag implementation
5. **CONCRETE ACTIONS** - Every checklist item is executable
6. **MAINTAIN TRACEABILITY** - Know where each recommendation came from
7. **READY FOR WORK** - Output should feed directly into executing-work skill
