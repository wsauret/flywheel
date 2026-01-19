---
name: workflows:review_plan
description: Deepen and review a plan in a single orchestrated workflow
argument-hint: "[path to plan file]"
---

# Review Plan - Combined Deepening & Review

## Introduction

**Note: The current year is 2026.** Use this when searching for recent documentation and best practices.

This command combines `/deepen-plan` and `/plan_review` into a single orchestrated workflow. It:

1. **Deepens** the plan with research, skills, and learnings (Stage 1)
2. **Reviews** the enhanced plan with reviewer agents (Stage 2)
3. **Consolidates** all findings with deduplication and conflict marking

This changes the workflow from:

```
plan → deepen-plan → plan_review → work → review
```

To:

```
plan → review_plan → work → review
```

## Plan File

<plan_path> #$ARGUMENTS </plan_path>

**If the plan path above is empty:**

1. Check for recent plans: `ls -la plans/`
2. Ask the user: "Which plan would you like to review? Please provide the path (e.g., `plans/my-feature.md`)."

Do not proceed until you have a valid plan file path.

## Main Tasks

### 1. Load Plan & Context

<thinking>
First, load the plan file and check for companion files:
1. Context file from `/workflows:plan` - contains prior research
2. Design document from `/workflows:brainstorm` - contains all explored approaches
The design document is especially important because it allows reviewers to suggest alternative approaches without redoing exploration work.
</thinking>

**Read the plan file completely.**

**Check for companion context file:**

```bash
# Derive context file path from plan path
CONTEXT_FILE="${PLAN_PATH%.md}.context.md"

# Check if it exists
if [ -f "$CONTEXT_FILE" ]; then
  echo "✅ Found research context: $CONTEXT_FILE"
  cat "$CONTEXT_FILE"
else
  echo "⚠️ No research context found - agents will research from scratch"
fi
```

**Check for associated design document:**

```bash
# Check plan frontmatter for design_doc reference
DESIGN_DOC=$(grep "design_doc:" "$PLAN_PATH" | sed 's/design_doc: //')

# If not in frontmatter, try deriving from plan name
if [ -z "$DESIGN_DOC" ]; then
  # e.g., plans/feat-user-auth.md → plans/user-auth-design.md
  PLAN_BASENAME=$(basename "$PLAN_PATH" .md)
  DESIGN_DOC="plans/${PLAN_BASENAME#feat-}-design.md"
  DESIGN_DOC="plans/${DESIGN_DOC#fix-}"
  DESIGN_DOC="plans/${DESIGN_DOC#refactor-}"
fi

if [ -f "$DESIGN_DOC" ]; then
  echo "✅ Found design document: $DESIGN_DOC"
  echo "   Contains explored approaches from brainstorming"
  cat "$DESIGN_DOC"
else
  echo "ℹ️ No design document found - reviewers won't have alternative approaches to reference"
fi
```

**If context file exists:**

- Read it completely before proceeding
- Extract "File References" section - these are pre-identified relevant files
- Note "Gotchas & Warnings" - these inform all research
- This context will be passed to ALL sub-agents in both stages

**If design document exists:**

- Read it completely before proceeding
- Extract "All Explored Approaches" section - these are alternatives to the selected approach
- Note "Selection Rationale" - why current approach was chosen over alternatives
- This allows reviewers to recommend switching to a different approach if issues are found
- Pass design document context to ALL reviewer agents

**Initialize stage tracking** (will be updated as stages complete):

```yaml
stages:
  - name: review_plan_started
    started: <timestamp>
    has_design_doc: true/false
```

---

## STAGE 1: Deepen Plan

<thinking>
Execute the full `/deepen-plan` workflow to enhance the plan with research, skills, and learnings. The enhanced plan will be written to disk so Stage 2 reviewers see the improved version.
</thinking>

### 1.1 Parse and Analyze Plan Structure

**Read the plan file and extract:**

- [ ] Overview/Problem Statement
- [ ] Proposed Solution sections
- [ ] Technical Approach/Architecture
- [ ] Implementation phases/steps
- [ ] Code examples and file references
- [ ] Acceptance criteria
- [ ] Any UI/UX components mentioned
- [ ] Technologies/frameworks mentioned
- [ ] Domain areas (data models, APIs, UI, security, performance)

**Cross-reference with context file (if available):**

- [ ] Merge file references from context with plan references
- [ ] Note which areas already have good research coverage
- [ ] Identify gaps where deeper research is needed

**Create a section manifest:**

```
Section 1: [Title] - [Brief description of what to research] - [Context coverage: High/Medium/Low/None]
Section 2: [Title] - [Brief description of what to research] - [Context coverage: High/Medium/Low/None]
...
```

### 1.2 Discover and Apply Available Skills

**Step 1: Discover ALL available skills from ALL sources**

```bash
# 1. Project-local skills (highest priority - project-specific)
ls .claude/skills/ 2>/dev/null

# 2. User's global skills (~/.claude/)
ls ~/.claude/skills/ 2>/dev/null

# 3. compound-engineering plugin skills
ls ~/.claude/plugins/cache/*/compound-engineering/*/skills/ 2>/dev/null

# 4. ALL other installed plugins - check every plugin for skills
find ~/.claude/plugins/cache -type d -name "skills" 2>/dev/null
```

**Step 2: For each discovered skill, read its SKILL.md to understand what it does**

**Step 3: Match skills to plan content**

For each skill discovered:

- Read its SKILL.md description
- Check if any plan sections match the skill's domain
- If there's a match, spawn a sub-agent to apply that skill's knowledge

**Step 4: Spawn a sub-agent for EVERY matched skill (in PARALLEL)**

For each matched skill:

```
Task general-purpose: "You have the [skill-name] skill available at [skill-path].

YOUR JOB: Use this skill on the plan.

STARTING CONTEXT: [If context file exists]
A research context file exists at [context-file-path] with prior research.
Read it first - it contains file references, naming conventions, gotchas.

1. Read the context file first (if provided)
2. Read the skill: cat [skill-path]/SKILL.md
3. Follow the skill's instructions exactly
4. Apply the skill to this content:

[relevant plan section or full plan]

5. Return the skill's full output"
```

**Spawn ALL skill sub-agents in PARALLEL. No limit - 10, 20, 30 skill sub-agents is fine.**

### 1.3 Discover and Apply Learnings/Solutions

**LEARNINGS LOCATION - Check these exact folders:**

```
docs/solutions/           <-- PRIMARY: Project-level learnings
├── performance-issues/
├── debugging-patterns/
├── configuration-fixes/
├── integration-issues/
├── deployment-issues/
└── [other-categories]/
```

**Step 1: Find ALL learning markdown files**

```bash
find docs/solutions -name "*.md" -type f 2>/dev/null
find .claude/docs -name "*.md" -type f 2>/dev/null
find ~/.claude/docs -name "*.md" -type f 2>/dev/null
```

**Step 2: Read frontmatter of each learning to filter**

Each learning file has YAML frontmatter with `tags`, `category`, `module`, `symptom`, `root_cause`.

**Step 3: Filter - only spawn sub-agents for LIKELY relevant learnings**

Compare each learning's frontmatter against the plan:

- Do any tags match technologies/patterns in the plan?
- Is the category relevant to this plan?
- Does the plan touch this module?

**SKIP** learnings clearly not applicable.
**SPAWN** sub-agents for learnings that MIGHT apply.

**Step 4: Spawn sub-agents for filtered learnings (in PARALLEL)**

### 1.4 Launch Per-Section Research Agents

For each major section in the plan, spawn dedicated sub-agents to research improvements:

```
Task Explore: "
STARTING CONTEXT: [If context file exists]
Read the research context file first: [context-file-path]
BUILD ON this research - don't duplicate it. Focus on DEEPENING and finding NEW insights.

Research additional best practices, patterns, and real-world examples for: [section topic].

Find what's MISSING:
- Deeper industry standards beyond what's documented
- Performance considerations not yet covered
- Edge cases and pitfalls not mentioned in gotchas
- More recent documentation and tutorials (2025-2026)

Return concrete, actionable recommendations that ADD to the existing research."
```

**Also use Context7 MCP for framework documentation:**

```
mcp__plugin_compound-engineering_context7__resolve-library-id: Find library ID for [framework]
mcp__plugin_compound-engineering_context7__query-docs: Query documentation for specific patterns
```

**Use WebSearch for current best practices (2025-2026).**

### 1.5 Run ALL Review Agents (Deepening Phase)

<thinking>
Run all review agents during deepening to catch issues early. These reviewers see the plan mid-enhancement. Stage 2 reviewers will see the final enhanced plan - both perspectives catch different issues.
</thinking>

**Step 1: Discover ALL available agents**

```bash
find .claude/agents -name "*.md" 2>/dev/null
find ~/.claude/agents -name "*.md" 2>/dev/null
find ~/.claude/plugins/cache/*/compound-engineering/*/agents -name "*.md" 2>/dev/null
find ~/.claude/plugins/cache -path "*/agents/*.md" 2>/dev/null
```

**For compound-engineering plugin specifically:**

- USE: `agents/review/*` (all reviewers)
- USE: `agents/research/*` (all researchers)
- USE: `agents/design/*` (design agents)
- USE: `agents/docs/*` (documentation agents)
- SKIP: `agents/workflow/*` (workflow orchestrators, not reviewers)

**Step 2: Launch ALL agents in parallel**

```
Task [agent-name]: "Review this plan using your expertise. Apply all your checks and patterns.

RESEARCH CONTEXT: [If context file exists]
A research context file exists at [context-file-path] with prior research.
Read it first - use file paths rather than searching for them again.

Plan content: [full plan content]"
```

**CRITICAL: Do NOT filter agents by "relevance" - run them ALL. Launch ALL agents in a SINGLE message with multiple Task tool calls.**

### 1.6 Synthesize Deepening Findings

**Collect outputs from ALL sources:**

1. **Skill-based sub-agents** - Code examples, patterns, recommendations
2. **Learnings/Solutions sub-agents** - Relevant documented learnings
3. **Research agents** - Best practices, documentation, examples
4. **Review agents** - Architecture, security, performance feedback
5. **Context7 queries** - Framework documentation
6. **Web searches** - Current best practices

**For each agent's findings, extract:**

- [ ] Concrete recommendations (actionable items)
- [ ] Code patterns and examples (copy-paste ready)
- [ ] Anti-patterns to avoid (warnings)
- [ ] Performance considerations
- [ ] Security considerations
- [ ] Edge cases discovered
- [ ] Documentation links
- [ ] Skill-specific patterns
- [ ] Relevant learnings (past solutions)

### 1.7 Enhance Plan Sections

**Enhancement format for each section:**

```markdown
## [Original Section Title]

[Original content preserved]

### Research Insights

**Best Practices:**

- [Concrete recommendation 1]
- [Concrete recommendation 2]

**Performance Considerations:**

- [Optimization opportunity]

**Implementation Details:**

\`\`\`[language]
// Concrete code example from research
\`\`\`

**Edge Cases:**

- [Edge case 1 and how to handle]

**References:**

- [Documentation URL]
```

### 1.8 Write Enhanced Plan to Disk

**IMPORTANT:** Write the enhanced plan to disk NOW so Stage 2 reviewers see the improved version.

**Update the plan file in-place** with all enhancements.

**Update the context file** with deepening insights:

```markdown
## Deepening Insights (from review_plan Stage 1)

### Skills Applied

- **[skill-name]**: [Key insight applied]

### Learnings Applied

- `[learning-file]`: [How it was applied]

### Additional Research Findings

[New findings from research agents]

### New Gotchas Discovered

- [New warnings discovered]
```

**Add stage metadata to context file:**

```yaml
stages:
  - name: deepen
    completed: <timestamp>
    skill_count: <N>
    research_agent_count: <N>
    learning_count: <N>
    review_agent_count: <N>
```

---

## STAGE 2: Review Enhanced Plan

<thinking>
Now that the plan has been enhanced and written to disk, run the full `/plan_review` workflow. Reviewers will see the enhanced version and can validate what was added during deepening.
</thinking>

### 2.1 Load Enhanced Plan & Updated Context

**Read the now-enhanced plan file** (written by Stage 1).

**Read the updated context file** (has deepening research).

Reviewers now have access to:

- Enhanced plan content
- All research findings from Stage 1
- Skills and learnings that were applied
- File references for efficient lookup

### 2.2 Run ALL Reviewer Agents

**Discover all reviewer agents** (same discovery as Stage 1).

**Launch ALL reviewer agents in PARALLEL:**

```
Task [reviewer-agent]: "Review this ENHANCED plan using your expertise.

IMPORTANT: This plan has already been through a deepening stage. Your job is to:
1. Validate the enhancements made during deepening
2. Find any issues the deepening stage missed
3. Check for contradictions or over-engineering introduced
4. Consider if an alternative approach would be better (if design doc available)

RESEARCH CONTEXT AVAILABLE:
Read [context-file-path] first - it contains:
- File references (use these instead of searching)
- What was added during deepening (validate these)
- Gotchas and warnings already identified

DESIGN DOCUMENT AVAILABLE (if brainstorm was run):
Read [design-doc-path] - it contains:
- ALL approaches that were explored during brainstorming
- Pros/cons/effort for each approach
- Why the current approach was selected
If you find issues with the selected approach, check if one of the alternative
approaches would address the issue. You can recommend switching approaches.

Plan content: [full enhanced plan content]

Return your findings in this format:
- P1 (Critical): [Issues that must be fixed before implementation]
- P2 (Important): [Issues that should be addressed]
- P3 (Nice-to-have): [Suggestions for improvement]
- Validations: [What deepening got right]
- Alternative Approach Recommendation: [If applicable - which approach from design doc might be better and why]"
```

**CRITICAL: Launch ALL reviewers in a SINGLE message with multiple Task tool calls.**

### 2.3 Collect Review Findings

**For each reviewer, capture:**

- Reviewer name
- P1/P2/P3 findings
- Validations (what deepening got right)
- Specific recommendations
- Alternative approach recommendations (if any)

**Track stage metadata:**

```yaml
stages:
  - name: review
    completed: <timestamp>
    reviewer_count: <N>
    findings_count: <N>
    p1_count: <N>
    p2_count: <N>
    p3_count: <N>
    approach_switch_recommendations: <N>
```

---

## STAGE 3: Consolidate Findings

<thinking>
Combine findings from both Stage 1 (deepening) and Stage 2 (review). Deduplicate similar findings, identify conflicts, and produce a unified summary.
</thinking>

### 3.1 Collect All Findings

**From Stage 1 (Deepening):**

- Research insights
- Skill application results
- Learning applications
- Deepening-phase review findings

**From Stage 2 (Review):**

- All reviewer findings (P1/P2/P3)
- Validations
- Recommendations

### 3.2 Deduplicate Findings

**Deduplication rules:**

1. **Identical findings**: Merge into one, note source count ("3 agents recommended...")
2. **Similar findings**: Group under common theme, list variations
3. **Complementary findings**: Keep both, mark as related

**Group by topic/recommendation:**

- Technology choices
- Architectural patterns
- Performance considerations
- Security recommendations
- Simplicity suggestions

### 3.3 Detect Conflicts

**Compare recommendations across these dimensions:**

- Technology choices (e.g., "use Redis" vs "avoid external dependencies")
- Architectural patterns (e.g., "add abstraction" vs "keep simple")
- Performance vs simplicity tradeoffs
- Security strictness levels

**Threshold for conflict:** Recommendations that would result in different implementations.

**Mark conflicts:**

```markdown
## CONFLICT: [Topic]

**Side A** ([source agents]):
[Recommendation A]

**Side B** ([source agents]):
[Recommendation B]

**Impact:** [What decision affects]

**Suggested resolution:** [If obvious, suggest; otherwise mark for user decision]
```

### 3.4 Write Consolidated Output

**Add to plan file:**

```markdown
## Review Summary (from /workflows:review_plan)

**Completed:** <date>
**Stages:** deepen → review
**Total Findings:** <N> (P1: <n>, P2: <n>, P3: <n>)
**Conflicts:** <N> requiring user decision
**Approach Switch Recommendations:** <N> (if design doc available)

### Key Improvements Applied (from Deepening)

- [Major improvement 1]
- [Major improvement 2]

### Reviewer Feedback Summary

**Critical (P1):**

- [P1 finding 1]

**Important (P2):**

- [P2 finding 1]

**Nice-to-have (P3):**

- [P3 finding 1]

### Alternative Approach Recommendations

[If any reviewers recommended switching to a different approach from the design document]

- **[Reviewer]** recommends **Approach B** because: [reason]
- Reference: See `plans/<topic>-design.md` for full approach details

### Conflicts Identified

[If any conflicts, list them with both sides]

### Validations

[What reviewers confirmed was done well]
```

**Update context file with full details:**

```yaml
stages:
  - name: review_plan_completed
    completed: <timestamp>
    deepen_skill_count: <N>
    deepen_research_agent_count: <N>
    deepen_learning_count: <N>
    review_reviewer_count: <N>
    review_findings_count: <N>
    conflicts_count: <N>
```

Add detailed findings sections:

```markdown
## Review Feedback (from review_plan Stage 2)

### Summary

- **Total findings**: <N>
- **P1 (Critical)**: <N>
- **P2 (Important)**: <N>
- **P3 (Nice-to-have)**: <N>
- **Conflicts**: <N>

### [Reviewer Name]

[Full findings from this reviewer]

### Conflicts Identified

[Full conflict details for user resolution]
```

---

## STAGE 4: Present Results

### 4.1 Display Summary

Present a summary of what was accomplished:

```
✅ Plan Review Complete

📄 Plan: [plan_path]
📋 Context: [context_path]

STAGE 1 (Deepen):
- Skills applied: <N>
- Learnings applied: <N>
- Research agents: <N>
- Review agents: <N>

STAGE 2 (Review):
- Reviewers run: <N>
- P1 (Critical): <N>
- P2 (Important): <N>
- P3 (Nice-to-have): <N>

CONFLICTS: <N> requiring your decision
APPROACH SWITCHES: <N> recommended by reviewers (if design doc available)
```

### 4.2 Post-Execution Options

Use **AskUserQuestion** to present next steps:

**Question:** "Plan reviewed at `[plan_path]`. What would you like to do next?"

**Options:**

1. **View enhanced plan** - Open the plan file to see all changes
2. **View detailed findings** - Show full review report from all reviewers
3. **Address conflicts** - Work through the [N] conflicting recommendations
4. **Consider approach switches** - Review the [N] alternative approach recommendations (if any)
5. **Start `/workflows:work`** - Begin implementing with the reviewed plan
6. **Iterate** - Run review_plan again on specific sections

**Based on selection:**

- **View plan** → `open [plan_path]` or display plan content
- **View findings** → Display consolidated findings report from context file
- **Address conflicts** → For each conflict, present options and let user choose:
  - Show both sides of the conflict
  - Ask user to pick Side A, Side B, or provide alternative
  - Update plan with user's decision
  - Remove conflict from list
  - Loop until all conflicts addressed
- **Consider approach switches** → For each approach recommendation:
  - Show the reviewer's recommendation and reasoning
  - Load the alternative approach details from the design document
  - Present comparison: current approach vs recommended alternative
  - Ask user: Keep current, Switch to alternative, or Hybrid
  - If switching, update plan to use new approach (significant rework may be needed)
- **`/workflows:work`** → Call the /workflows:work command with the plan file path
- **Iterate** → Ask which sections need more research, re-run targeted agents

---

## Error Handling

### Agent Failures

**If individual agents fail:**

- Log the failure with agent name and error
- Continue with remaining agents
- Report failures in summary
- Include partial results from successful agents

**Minimum success threshold:** Require 50% agent success to produce output.

**If below threshold:**

```
⚠️ Too many agent failures (<50% success rate)

Failed agents:
- [agent-1]: [error]
- [agent-2]: [error]

Successful agents:
- [agent-3]: [completed]

Options:
1. Proceed with partial results
2. Retry failed agents
3. Abort and investigate
```

### Stage Failures

**If Stage 1 (Deepen) fails entirely:**

- Report which step failed
- Preserve any partial results in context file
- Suggest: "Re-run `/workflows:review_plan` - it will detect partial progress and continue"

**If Stage 2 (Review) fails entirely:**

- Keep Stage 1 enhancements (already written to disk)
- Report failure
- Suggest: "Re-run `/workflows:review_plan` - Stage 1 results are preserved, will resume at Stage 2"

### Recovery

If process crashes mid-execution:

1. Check context file for stage markers
2. Identify last completed stage
3. Offer to resume from that point

---

## Quality Checks

Before finalizing:

- [ ] Plan file has been enhanced with research insights
- [ ] Context file tracks all stage completions
- [ ] All findings are deduplicated
- [ ] Conflicts are clearly marked with both sides
- [ ] Summary accurately reflects total findings
- [ ] P1/P2/P3 counts are correct
- [ ] Post-execution options are presented

---

NEVER CODE! This command is for research and review only.
