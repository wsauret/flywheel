---
name: plan-creation
description: Research codebase and create implementation plans. Triggers on "create plan", "plan for", "write a plan".
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

# Plan Creation Skill

Transform feature descriptions into well-structured markdown plan files. Can run standalone or be orchestrated by `/fly:plan`.

**Subagent Dispatch:** Follow guidelines in `CLAUDE.md`.

## Input

Feature description via `$ARGUMENTS`. If empty, ask user.

---

## Phase 1: Research (Parallel Agents)

Launch three research agents simultaneously:

```
Task repo-researcher: "Analyze codebase for patterns related to: <feature>.
Find: existing implementations, file structure, naming conventions.
Return: file paths with line numbers (e.g., src/services/auth.ts:42)
Flag OPEN QUESTIONS for ambiguities or multiple valid approaches."

Task best-practices-researcher: "Research best practices for: <feature>.
Find: industry standards, common patterns, anti-patterns.
Use WebSearch for current (2026) best practices.
Flag OPEN QUESTIONS for trade-offs or context-dependent recommendations."

Task framework-docs-researcher: "Research framework docs for: <feature>.
Use mcp__plugin_Flywheel_context7__resolve-library-id then query-docs.
Return: code examples, configuration patterns.
Flag OPEN QUESTIONS for configuration choices or version considerations."
```

After agents complete, consolidate:
- File paths with line numbers
- External documentation URLs
- Team conventions from CLAUDE.md
- All OPEN QUESTIONS flagged by agents

---

## Phase 1.5: Research Validation Gate

**BLOCKING:** Verify research quality before planning.

### Checklist

1. **Completeness**: Did all agents return findings?
2. **Accuracy**: Do 3-5 file paths actually exist?
3. **Coverage**: Any obvious gaps for this feature?
4. **Conflicts**: Any contradictions between agents?

### If validation fails

List gaps as bullet points. For minor gaps (1-2 items): note in Open Questions and proceed. For significant gaps: ask user whether to re-run or proceed with caveats. Maximum 2 re-research attempts.

---

## Phase 2: Structure

### Title & Filename

Draft clear title: `feat: Add user authentication`

Convert to kebab-case filename per `references/formatting-guide.md`:
- `feat: Add User Auth` → `feat-add-user-auth.md`

### Choose Detail Level

Select template from `references/plan-templates.md`:

| Level | Use For |
|-------|---------|
| MINIMAL | Simple bugs, small improvements |
| MORE | Most features, complex bugs |
| A LOT | Major features, architectural changes |

---

## Phase 3: Write Plan

Using chosen template:
1. Fill all sections with research findings
2. Include specific file paths with line numbers
3. Add code examples with syntax highlighting
4. Ensure acceptance criteria are testable
5. Include Open Questions from research

Write to: `plans/<filename>.md`

---

## Phase 4: Create Context File

Persist research for downstream phases.

Write to: `plans/<filename>.context.md`

Use template from `references/plan-templates.md` (Context File Template section).

---

## Phase 5: Plan Review (HIGH LEVERAGE)

**Bad plan lines lead to hundreds of incorrect code lines.**

Present summary:

```
Plan Summary for: [Title]

Scope: [3-5 bullet points]
Key Decisions: [Decision]: [rationale]
Phases: [N] phases
Files: [N] files to modify
Open Questions: [N] requiring resolution
```

**AskUserQuestion:**
- Approve plan - Looks good
- Adjust scope - Add or remove items
- Change approach - Different strategy
- Add constraints - Missing requirements

Maximum 2 revision cycles.

---

## Phase 6: Post-Creation Options

**AskUserQuestion:** "Plan ready at `plans/<name>.md`. What next?"

| Option | Action |
|--------|--------|
| Deepen plan | Invoke `skill: plan-deepening` |
| Review plan | Invoke `skill: reviewing` |
| Start work | Invoke `skill: executing-work` |
| Done for now | Display path and exit |

---

## Error Handling

- **Agent failure:** Log and continue; require 50% success minimum
- **Missing CLAUDE.md:** Note conventions may be incomplete
- **Context7 failure:** Fall back to WebSearch
- **Write failure:** Create `plans/` with `mkdir -p`, report errors

---

## CRITICAL: No Code Changes

This skill is research and planning ONLY.

**Allowed:**
- Read source files
- Search codebase
- Query documentation
- Write markdown to `plans/`

**Prohibited:**
- Create/edit source code
- Create/edit test files
- Modify configuration
- "Helpfully" start coding

**If tempted to write code, STOP and add it to the plan instead.**

---

## Anti-Patterns

- Skip research (even "simple" features benefit)
- Over-engineer simple issues (use MINIMAL)
- Vague acceptance criteria (must be testable)
- Omit file references (include paths with line numbers)
- Skip AskUserQuestion (user must choose next step)

---

## Detailed References

For templates and formatting conventions:
- `references/plan-templates.md` - MINIMAL/MORE/A LOT templates, context file template
- `references/formatting-guide.md` - Filename conventions, content formatting
