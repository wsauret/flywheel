---
name: plan-creation
description: Draft initial implementation plans based on codebase patterns. Creative/generative phase - validation happens in plan-verification. Triggers on "create plan", "plan for", "write a plan".
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

Draft implementation plans based on user intent and existing codebase patterns. This is the **creative/generative** phase - external validation happens later in plan-verification.

**Philosophy:** Focus on WHAT to build based on HOW things are already built. Don't validate external claims yet - flag them for verification.

**Context Compaction:** This skill creates `.context.md` files to persist research findings. This enables recovery if context is lost and provides downstream phases with key file paths and patterns without re-reading.

**Subagent Dispatch:** Follow guidelines in `CLAUDE.md`.

## Input

Feature description via `$ARGUMENTS`. If empty, ask user.

---

## Phase 1: Understand Codebase Context

Research the codebase to understand existing patterns. This informs HOW to structure the plan.

```
Task repo-researcher: "Analyze codebase for patterns related to: <feature>.

Find:
1. Existing implementations of similar features
2. File structure and naming conventions
3. Architectural patterns used
4. Testing patterns for similar components

Return: file paths with line numbers (e.g., src/services/auth.ts:42)
Flag OPEN QUESTIONS for ambiguities or multiple valid approaches."
```

Also check:
- `CLAUDE.md` for team conventions
- Recent similar features for precedent

After research completes, consolidate:
- File paths with line numbers
- Existing patterns to follow
- Team conventions
- OPEN QUESTIONS about approach

**NOTE:** External validation (framework docs, best practices) happens in plan-verification. Here we draft based on what we know.

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
1. Fill all sections based on codebase research
2. Include specific file paths with line numbers
3. Follow existing patterns identified in Phase 1
4. Ensure acceptance criteria are testable
5. Include Open Questions from research

### Flag Claims for Verification

As you draft, identify assumptions that need external validation:

```markdown
## Claims to Verify

The following assumptions should be validated in plan-verification:

- [ ] "React Query supports offline persistence" - verify in docs
- [ ] "Redis pub/sub handles 10k connections" - verify performance claims
- [ ] "Next.js 14 has stable server actions" - verify version compatibility
```

**Don't validate these yourself** - flag them clearly for the verification phase.

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
| Verify plan (Recommended) | Invoke `skill: plan-verification` |
| Review plan | Invoke `skill: plan-review` |
| Start work | Invoke `skill: work-implementation` |
| Done for now | Display path and exit |

**Recommended flow:** Verify → Review → Consolidate → Work

---

## Error Handling

- **Agent failure:** Log and continue with available findings
- **Missing CLAUDE.md:** Note conventions may be incomplete
- **No similar patterns found:** Ask user for guidance on approach
- **Write failure:** Create `plans/` with `mkdir -p`, report errors

---

## CRITICAL: No Code Changes

This skill is research and planning ONLY.

**Allowed:**
- Read source files
- Search codebase
- Write markdown to `plans/`

**Prohibited:**
- Create/edit source code
- Create/edit test files
- Modify configuration
- "Helpfully" start coding
- Validate external claims (that's plan-verification)

**If tempted to write code, STOP and add it to the plan instead.**
**If tempted to research framework docs, STOP and flag it for verification instead.**

---

## Anti-Patterns

- **Skip codebase research** - Even "simple" features benefit from understanding patterns
- **Over-engineer simple issues** - Use MINIMAL template
- **Vague acceptance criteria** - Must be testable
- **Omit file references** - Include paths with line numbers
- **Skip AskUserQuestion** - User must choose next step
- **Validate external claims** - Flag for verification, don't research yourself
- **Assume library capabilities** - If you're not 100% sure, flag it

---

## Detailed References

For templates and formatting conventions:
- `references/plan-templates.md` - MINIMAL/MORE/A LOT templates, context file template
- `references/formatting-guide.md` - Filename conventions, content formatting
