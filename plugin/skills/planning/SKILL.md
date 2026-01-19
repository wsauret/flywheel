---
name: planning
description: Create detailed implementation plans with research persistence. Handles design docs, feature descriptions, or existing plans. Includes deepening and review phases. Triggers on "plan", "create a plan", "implement", "build".
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Bash
  - Task
  - AskUserQuestion
---

# Planning Skill

Transform feature descriptions or design documents into well-structured implementation plans. Includes research, deepening, and review phases in one orchestrated flow.

## Input Detection

The input (`$ARGUMENTS`) can be:
1. **Design document path** (ends with `-design.md`) → Skip research, use design context
2. **Existing plan path** (ends with `.md` in `plans/`) → Deepen and review only
3. **Feature description** → Check for existing design doc, then research

**Detection logic:**
```
If input ends with "-design.md" AND file exists:
  → DESIGN MODE: Extract approach, requirements, constraints
  → Skip to Phase 2 (Issue Planning)

If input is .md file in plans/ AND NOT design doc:
  → REVIEW MODE: Skip to Phase 3 (Deepen) and Phase 4 (Review)

Otherwise:
  → RESEARCH MODE: Check if plans/<kebab-case>-design.md exists
  → If exists, use it; if not, run quick brainstorm (2-3 approaches)
```

---

## Phase 1: Research & Context Gathering

**Run these agents in parallel:**
- Task repo-research-analyst(feature_description)
- Task best-practices-researcher(feature_description)
- Task framework-docs-researcher(feature_description)

**Extract and document:**
- [ ] Relevant patterns with file paths (`src/file.ts:42`)
- [ ] Framework documentation URLs
- [ ] Similar implementations in codebase
- [ ] Team conventions from CLAUDE.md

### Persist Research to Context File

**File:** `plans/<plan-name>.context.md`

**Structure:**
```markdown
---
plan: <plan-filename>.md
created: <date>
feature: "<feature description>"
researchers:
  - repo-research-analyst
  - best-practices-researcher
  - framework-docs-researcher
---

# Research Context: <Feature Name>

## File References
<list of specific file paths, one per line>

## Naming Conventions
- [Convention type]: [pattern observed]

## External Research
### Framework Documentation
- [URL with description]

### Best Practices
- [Best practice with source]

## Gotchas & Warnings
- ⚠️ [Warning about patterns or pitfalls]

## Research Quality
- **Confidence**: High/Medium/Low
- **Last verified**: <date>
```

---

## Phase 2: Issue Planning & Structure

### Title & Categorization
- Draft clear title: `feat: Add user authentication`, `fix: Cart total calculation`
- Convert to kebab-case filename: `feat-add-user-authentication.md`
- Determine type: enhancement, bug, refactor

### Choose Detail Level

**MINIMAL** (simple bugs, small improvements):
- Problem statement
- Acceptance criteria
- Essential context

**MORE** (most features, complex bugs):
- Overview, problem statement, proposed solution
- Technical considerations
- Acceptance criteria with testing
- Dependencies and risks

**A LOT** (major features, architectural changes):
- Full implementation phases
- Alternative approaches considered
- Resource requirements
- Risk mitigation strategies

See `references/plan-templates.md` for detailed templates.

### Write Plan File

**File:** `plans/<type>-<descriptive-name>.md`

Include:
- YAML frontmatter with `design_doc:` if applicable
- All relevant sections for chosen detail level
- Code examples with file path references
- ERD diagram if new models

---

## Phase 3: Deepen Plan

**Purpose:** Enhance plan with skills, learnings, and additional research.

### Discover & Apply Skills

```bash
# Find all available skills
ls .claude/skills/ 2>/dev/null
ls ~/.claude/skills/ 2>/dev/null
find ~/.claude/plugins/cache -type d -name "skills" 2>/dev/null
```

For each skill that matches plan content:
- Task general-purpose: "Apply [skill] to this plan: [relevant section]"

**Run ALL matched skills in PARALLEL.**

### Discover & Apply Learnings

```bash
find docs/solutions -name "*.md" -type f 2>/dev/null
```

Filter by frontmatter tags/category matching plan technologies.
Spawn sub-agents for relevant learnings.

### Research Agents

For each major section, spawn:
- Task Explore: "Research best practices for [topic], building on existing context"

**Use Context7 MCP** for framework documentation:
- mcp__plugin_Flywheel_context7__resolve-library-id
- mcp__plugin_Flywheel_context7__query-docs

### Update Plan with Enhancements

Add to each section:
```markdown
### Research Insights

**Best Practices:**
- [Recommendation]

**Performance Considerations:**
- [Optimization]

**Edge Cases:**
- [Edge case and handling]
```

**Write enhanced plan to disk** before review phase.

---

## Phase 4: Review Plan

### Run ALL Reviewer Agents

```bash
find ~/.claude/plugins/cache -path "*/agents/review/*.md" 2>/dev/null
```

Launch ALL reviewers in PARALLEL:
- Task [reviewer]: "Review this enhanced plan. Use context file for file references.
  Return: P1 (Critical), P2 (Important), P3 (Nice-to-have), Validations.
  If design doc available, consider if alternative approach would be better."

### Collect & Deduplicate Findings

- **Identical findings**: Merge, note source count
- **Similar findings**: Group under theme
- **Conflicts**: Mark clearly with both sides

### Detect Conflicts

Compare recommendations for contradictions:
- Technology choices
- Architectural patterns
- Performance vs simplicity tradeoffs

```markdown
## CONFLICT: [Topic]

**Side A** ([agents]): [Recommendation]
**Side B** ([agents]): [Recommendation]
**Suggested resolution:** [If obvious]
```

### Write Review Summary

Add to plan:
```markdown
## Review Summary

**Completed:** <date>
**Total Findings:** <N> (P1: <n>, P2: <n>, P3: <n>)
**Conflicts:** <N>

### Critical (P1)
- [Finding]

### Important (P2)
- [Finding]

### Conflicts Identified
[If any]
```

Update context file with full reviewer details.

---

## Phase 5: Present Results & Handoff

### Display Summary

```
✅ Plan Complete

📄 Plan: plans/<name>.md
📋 Context: plans/<name>.context.md

Research: <N> agents run
Deepening: <N> skills, <N> learnings applied
Review: <N> reviewers, <N> findings (P1: <n>, P2: <n>)
Conflicts: <N>
```

### Post-Execution Options

Use AskUserQuestion:
```
Question: "Plan ready at `plans/<name>.md`. What next?"
Options:
1. Start /fly:work (Recommended) - Begin implementation
2. View detailed findings - Show full review report
3. Address conflicts - Work through conflicting recommendations
4. Open plan in editor - Review the plan file
5. Create GitHub/Linear issue - Push to project tracker
```

---

## Error Handling

### Agent Failures
- Log failure with agent name and error
- Continue with remaining agents
- Report failures in summary
- Minimum 50% success to produce output

### Recovery
- Context file tracks stage progress
- Re-running resumes from last completed stage

---

## Key Principles

- **Research persists to files** - Context file enables downstream reuse
- **Deepen before review** - Reviewers see enhanced plan
- **Run agents in parallel** - Speed over sequential
- **Deduplicate findings** - Consolidate similar recommendations
- **Mark conflicts clearly** - User decides on tradeoffs
