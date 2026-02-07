---
name: plan-creation
description: Draft initial implementation plans based on codebase patterns. Creative/generative phase - validation happens in plan-enrich. Triggers on "create plan", "plan for", "write a plan".
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

Draft implementation plans based on user intent and existing codebase patterns. This is the **creative/generative** phase - external validation happens later in plan-enrich.

**Philosophy:** Focus on WHAT to build based on HOW things are already built. Don't validate external claims yet - flag them for verification.

**Context Compaction:** This skill creates `.context.md` files to persist research findings. This enables recovery if context is lost and provides downstream phases with key file paths and patterns without re-reading.

## Input

Feature description via `$ARGUMENTS`. If empty, ask user.

---

## Phase 0: Check for Existing Knowledge

Before starting codebase research, check for relevant existing knowledge:

1. **Standards** (`docs/standards/`) — Search by tags for reusable patterns. Load matching standards as context for plan drafting.
2. **Research** (`docs/research/`) — Check for recent research (within 30 days):
   ```bash
   find docs/research -name "*<topic-keywords>*" -mtime -30 2>/dev/null | head -3
   ```

If relevant knowledge found, use it as a starting point for Phase 1 (avoids re-researching). Note findings in the context file.

If no matches, proceed normally to Phase 1.

---

## Phase 1: Understand Codebase Context

Research the codebase using a **locate then analyze** pattern:

1. **Locate (parallel, cheap):** Run codebase-locator, pattern-locator, and docs-locator Tasks simultaneously to find WHERE relevant code lives. Return paths only.
2. **Analyze (targeted):** Feed top 10-15 paths into a codebase-analyzer Task. Document existing implementations, conventions, and architectural patterns. Flag OPEN QUESTIONS.
3. **Also check:** `CLAUDE.md` for team conventions; recent similar features for precedent.
4. **Consolidate:** File paths with line numbers, existing patterns, team conventions, open questions.

Read `references/research-dispatch.md` before proceeding — it contains the full Task dispatch templates for each locator and the analyzer.

**NOTE:** External validation (framework docs, best practices) happens in plan-enrich. Here we draft based on what we know.

---

## Phase 1.5: Research Validation Gate

**BLOCKING:** Verify codebase research quality before drafting.

### Checklist

1. **File paths exist**: Spot-check 3-5 referenced paths
2. **Patterns identified**: Found relevant existing implementations?
3. **Conventions clear**: Know how this codebase handles similar features?

### If validation fails

For minor gaps: note in Open Questions and proceed. For significant gaps (no similar patterns found): ask user for guidance. Maximum 2 re-research attempts.

---

## Phase 2: Structure

### Title & Filename

Draft clear title: `feat: Add user authentication`

Convert to kebab-case filename per `references/formatting-guide.md`:
- `feat: Add User Auth` -> `feat-add-user-auth.md`

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
1. Fill all sections based on codebase research
2. Include specific file paths with line numbers
3. Follow existing patterns identified in Phase 1
4. Ensure acceptance criteria are testable
5. Include Open Questions from research

Read `references/verification-claims.md` before proceeding — it contains the template and guidelines for flagging assumptions that need external validation in plan-enrich. **Do not validate external claims yourself.**

Write to: `docs/plans/<filename>.md`

---

## Phase 4: Create Context File

Persist research for downstream phases.

Write to: `docs/plans/<filename>.context.md`

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

**AskUserQuestion:** "Plan draft ready at `docs/plans/<name>.md`. What next?"

| Option | Action |
|--------|--------|
| Run verification (Recommended) | Invoke `skill: plan-enrich` |
| Done for now | Display path and exit |

---

## Error Handling

- **Agent failure:** Log and continue with available findings
- **Missing CLAUDE.md:** Note conventions may be incomplete
- **No similar patterns found:** Ask user for guidance on approach
- **Write failure:** Create `docs/plans/` with `mkdir -p`, report errors

---

## Anti-Patterns

- **Write code** — This skill is research and planning ONLY. If tempted to code, add it to the plan instead
- **Validate external claims** — Flag for verification in plan-enrich, don't research yourself
- **Skip codebase research** — Even "simple" features benefit from understanding patterns
- **Over-engineer simple issues** — Use MINIMAL template
- **Vague acceptance criteria** — Must be testable
- **Omit file references** — Include paths with line numbers
- **Skip AskUserQuestion** — User must choose next step

---

## Detailed References

- `references/research-dispatch.md` - Full Task dispatch templates for Phase 1 locate/analyze pattern
- `references/verification-claims.md` - Template and guidelines for flagging external claims
- `references/plan-templates.md` - MINIMAL/MORE/A LOT templates, context file template
- `references/formatting-guide.md` - Filename conventions, content formatting
