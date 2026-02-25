---
name: plan-creation
description: Research codebase, validate claims, and draft implementation plans. Single-pass creation with integrated validation. Triggers on "create plan", "plan for", "write a plan".
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

Research the codebase, validate technical claims, and draft implementation plans — all in a single pass.

**Philosophy:** Create plans grounded in codebase reality AND validated against external docs. Don't defer validation — bad assumptions caught early are cheap; caught late they become bad code.

**Context Compaction:** This skill creates `.context.md` files to persist research findings. This enables recovery if context is lost and provides downstream phases with key file paths and patterns without re-reading.

## Input

Feature description via `$ARGUMENTS`. If empty, ask user.

---

## Phase 0: Check for Existing Knowledge

Before starting codebase research, check for relevant existing knowledge:

1. **Standards** (`docs/standards/`) — Search by tags for reusable patterns. Load matching standards as context for plan drafting.
2. **Solutions** (`docs/solutions/`) — Verified fixes from past work. Search solution files for relevant matches (up to 5).
3. **Research** (`docs/research/`) — Check for recent research (within 30 days):
   ```bash
   find docs/research -name "*<topic-keywords>*" -mtime -30 2>/dev/null | head -3
   ```

If relevant knowledge found, use it as a starting point for Phase 1 (avoids re-researching). Note findings in the context file.

Skip any directory that doesn't exist. If no matches, proceed normally to Phase 1.

---

## Phase 1: Understand Codebase Context

Research the codebase using a **locate then analyze** pattern:

**BLOCKING:** Do NOT use Read/Grep/Glob for TARGET CODEBASE research — dispatch locator Tasks first, then feed results to analyzer Tasks. Skill references, plan artifacts, and template files are exempt from this requirement.

1. **Locate (parallel, cheap):** Run locator-codebase, locator-patterns, and locator-docs Tasks simultaneously to find WHERE relevant code lives. Return paths only.
2. **Analyze (targeted):** Feed top 10-15 paths into an analyzer-codebase Task. Document existing implementations, conventions, and architectural patterns. Flag OPEN QUESTIONS.
3. **Also check:** `CLAUDE.md` for team conventions; recent similar features for precedent.
4. **Consolidate:** File paths with line numbers, existing patterns, team conventions, open questions.

Read `references/research-dispatch.md` before proceeding — it contains the full Task dispatch templates for locators, analyzer, and the DRY/integration checks added in Phase 1.

---

## Phase 1.5: Research Validation Gate

**BLOCKING:** Verify codebase research quality before drafting.

### Checklist

1. **File paths exist**: Spot-check 3-5 referenced paths
2. **Patterns identified**: Found relevant existing implementations?
3. **Conventions clear**: Know how this codebase handles similar features?
4. **DRY checked**: No proposed work duplicates existing code?

### If validation fails

For minor gaps: note in Open Questions and proceed. For significant gaps (no similar patterns found): ask user for guidance. Maximum 2 re-research attempts.

---

## Phase 2: Validate External Claims

**Goal:** Verify technical claims before they become plan assumptions. Only run when high-risk topics are detected.

Read `references/validation-research.md` before proceeding — it contains the high-risk keyword heuristic, Context7 workflow, and dispatch templates.

### Decision Heuristic

Scan the draft plan content for high-risk keywords (security, payments, crypto, migrations, privacy). If any found → run external validation. If none → skip this phase.

### When triggered:

1. **Framework Docs Validation** — Verify claimed library features via Context7
2. **Version Compatibility** — Check for breaking changes and deprecations
3. **Best Practices** — Look up recommended patterns for high-risk areas

Incorporate validated findings directly into the plan as you draft it. Flag `CLAIM_INVALID` or `VERSION_ISSUE` as Open Questions if they change the approach.

---

## Phase 3: Structure

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

## Phase 4: Write Plan

Using chosen template:
1. Fill all sections based on codebase research
2. Include specific file paths with line numbers
3. Follow existing patterns identified in Phase 1
4. Ensure acceptance criteria are testable
5. Include Open Questions from research (internal and external)
6. Structure each implementation phase with test steps before implementation steps (test-first ordering). Reference `flywheel-conventions/references/tdd-cycle.md` for skip conditions.
7. Decompose phases along Single Responsibility lines — each phase should have one clear purpose
8. Check for duplication across phases — shared setup, utilities, or patterns should be extracted into an early foundation phase
9. Integrate validated external findings (best practices, security notes) into relevant plan sections — don't quarantine them in a separate section

**Example (phase decomposition):**
Bad:
- Phase 2: Implement feature end-to-end (DB/API/UI)
- Phase 3: Write all tests at the end
- Phase 4: Refactor/cleanup

Good:
- Phase 2: Foundation (shared fixtures/helpers) + tests first
- Phase 3: API layer changes + tests first
- Phase 4: UI integration + tests first

Write to: `docs/plans/<filename>.md`

---

## Phase 5: Create Context File

Persist research for downstream phases.

Write to: `docs/plans/<filename>.context.md`

Use template from `references/plan-templates.md` (Context File Template section).

---

## Phase 6: Plan Review (HIGH LEVERAGE)

**Bad plan lines lead to hundreds of incorrect code lines.**

Present summary:

```
Plan Summary for: [Title]

Scope: [3-5 bullet points]
Key Decisions: [Decision]: [rationale]
Phases: [N] phases
Files: [N] files to modify
Open Questions: [N] requiring resolution
Validation: [external research run / skipped (no high-risk topics)]
```

**AskUserQuestion:**
- Approve plan - Looks good
- Adjust scope - Add or remove items
- Change approach - Different strategy
- Add constraints - Missing requirements

Maximum 2 revision cycles.

---

## Phase 7: Post-Creation Options

**AskUserQuestion:** "Plan draft ready at `docs/plans/<name>.md`. What next?"

| Option | Action |
|--------|--------|
| Run review (Recommended) | Invoke `skill: plan-review` |
| Done for now | Display path and exit |

---

## Error Handling

- **Agent failure:** Log and continue with available findings
- **Missing CLAUDE.md:** Note conventions may be incomplete
- **No similar patterns found:** Ask user for guidance on approach
- **Context7 failure:** Fall back to WebSearch for external validation
- **Write failure:** Create `docs/plans/` with `mkdir -p`, report errors

---

## Anti-Patterns

- **Write code** — This skill is research and planning ONLY. If tempted to code, add it to the plan instead
- **Skip codebase research** — Even "simple" features benefit from understanding patterns
- **Read target codebase files directly instead of dispatching analyzers** — Use the locate->analyze pattern (locators first, then targeted analyzer Tasks)
- **Skip locators and go straight to analyzers with assumed paths** — Locators discover; analyzers analyze. Both steps required
- **Over-engineer simple issues** — Use MINIMAL template
- **Defer all testing to a final phase** — Tests should be per-phase, not an afterthought. Each implementation phase includes test steps before implementation steps
- **Vague acceptance criteria** — Must be testable
- **Omit file references** — Include paths with line numbers
- **Skip AskUserQuestion** — User must choose next step
- **Skip external validation for high-risk topics** — Security, payments, migrations MUST be validated against docs
- **Run external validation for everything** — Only high-risk topics warrant the token cost

---

## Detailed References

- `references/research-dispatch.md` - Full Task dispatch templates for Phase 1 locate/analyze/DRY/integration pattern
- `references/validation-research.md` - High-risk heuristic, Context7 workflow, external validation dispatch templates
- `references/plan-templates.md` - MINIMAL/MORE/A LOT templates, context file template
- `references/formatting-guide.md` - Filename conventions, content formatting
