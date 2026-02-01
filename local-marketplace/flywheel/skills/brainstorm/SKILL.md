---
name: brainstorm
description: Conversational exploration of ideas before detailed planning. One question at a time, 2-3 approaches, incremental validation. Triggers on "explore", "brainstorm", "think about".
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Task
  - AskUserQuestion
---

# Brainstorming Skill

Transform ideas into validated designs through natural collaborative dialogue. Output is a design document for the planning skill.

---

## Core Philosophy: Interactive Design

**Never write the full design in one shot.** This skill transforms ideas into validated designs through iterative dialogue, not monologue.

Human attention is precious. We invest it at the highest-leverage points:

| Checkpoint | Prevents |
|------------|----------|
| Research validation | Building on wrong assumptions |
| Understanding confirmation | Solving wrong problem |
| Approach selection | Pursuing suboptimal path |
| Design validation | Shipping wrong design |

> "A bad line of research could lead to thousands of bad lines of code."

**Anti-patterns:**
- Dumping research findings on user (present insights, not data)
- Asking multiple questions at once (one at a time)
- Skipping approach exploration (always present 2-3 options)
- Presenting design without incremental validation
- Writing full design then asking "does this look good?"

---

## Input

Feature idea via `$ARGUMENTS`. If empty, ask: "What would you like to explore?"

---

## Phase 1: Silent Research

Run research agents to understand context. **DO NOT present findings to user** - use them to ask smarter questions.

### 1.1 Locate (Parallel, Cheap)

Run locators in parallel:

```
Task codebase-locator: "Find files related to: <feature_idea>. Return paths only."
Task pattern-locator: "Find patterns related to: <feature_idea>. Return file:line refs."
Task docs-locator: "Find docs about: <feature_idea>. Return paths only."
Task web-searcher: "Find best practices for: <feature_idea>. Return URLs only." [15s timeout]
```

### 1.2 Analyze Top Findings (Targeted)

```
Task codebase-analyzer: "
Analyze top 10 files from locators for: <feature_idea>
Document existing patterns, constraints, naming conventions.
"
```

**Extract for internal use:**
- Relevant existing patterns
- Technical constraints
- Similar implementations
- Naming conventions
- Best practices

---

## Phase 1.5: Research Review 🔍→👤 CHECKPOINT

**HIGH LEVERAGE checkpoint. Bad research → bad design → thousands of bad lines of code.**

Present summary (NOT raw findings):

```
Research Summary for: [Feature]

Scope Identified: [3-5 bullets]
Key Files: [paths with purpose]
Patterns Discovered: [pattern: description]
Potential Concerns: [risks]
```

**AskUserQuestion:**
- Approve and proceed
- Add focus area - Need more investigation
- Redirect research - Wrong direction

Maximum 2 re-research cycles.

---

## Phase 2: Understand the Idea

Ask questions **one at a time** to refine the idea.

**Rules:**
1. **One question per message**
2. **Prefer multiple choice** (AskUserQuestion with 2-4 options)
3. **Lead with recommendation**
4. **YAGNI ruthlessly** - Challenge scope creep

**Question sequence:**
1. Clarify core problem
2. Understand user/audience
3. Define success criteria
4. Identify constraints
5. Scope check - "Is X part of this?"

**Continue until you understand:**
- Core problem being solved
- Who benefits and how
- What success looks like
- What's out of scope
- Key constraints

### 👤 CHECKPOINT: Understanding Confirmation

Before exploring approaches, confirm understanding:

```
I understand we're solving:

**Problem:** [1-2 sentences]
**For:** [audience]
**Success looks like:** [outcome]
**Out of scope:** [explicit boundaries]

Is this accurate?
```

---

## Phase 2.5: Surface Relevant Learnings

Check `docs/solutions/` for relevant past solutions.

```bash
grep -l "<keyword>" docs/solutions/**/*.md 2>/dev/null
```

**If matches found (max 3-5):**

```
💡 Relevant Past Solutions:

1. **[Title]** (path)
   - Symptom: [from frontmatter]
   - Why relevant: [connection to problem]
```

Ask if learnings should inform approach selection.

**If no matches:** Proceed silently.

---

## Phase 3: Explore Approaches 🔍→👤 CHECKPOINT

**ALWAYS present 2-3 approaches** - even for "obvious" solutions.

Use best practices research to inform approaches. Note when approach aligns or deviates.

**Format each approach with explicit tradeoffs:**

```markdown
## Approach: [Name] (Recommended)

**Summary:** [2-3 sentences]

**Tradeoffs:**
| Pro | Con |
|-----|-----|
| [Benefit 1] | [Drawback 1] |
| [Benefit 2] | [Drawback 2] |

**When to choose this:** [Scenario where this is best]
**When NOT to choose this:** [Scenario where this fails]

**Effort:** S/M/L
```

This forces thinking about failure modes, not just benefits.

Ask user to select using AskUserQuestion.

If user wants to combine: clarify aspects, present hybrid, confirm.

---

## Phase 4: Validate Design Incrementally 🔍→👤 CHECKPOINT (per section)

Present design in **small chunks (200-300 words each)**.

**Section order:**
1. Overview
2. User flows
3. Architecture
4. Data model (if applicable)
5. Error handling
6. Success criteria

**After EACH section:** "Does this look right so far?"

Handle feedback immediately before moving to next section.

---

## Phase 5: Create Design Document

Write to `docs/plans/<topic>-design.md` using template from `references/design-document-template.md`.

**Include:**
- ALL explored approaches (not just selected)
- Validated sections
- Selection rationale
- Open questions

---

## Phase 5b: Design Iteration (if needed)

If user has feedback on the design after Phase 5:

### 1. Confirm Understanding

```
Based on your feedback, I understand you want to:
- [Change 1 with specific detail]
- [Change 2 with specific detail]

Is this correct?
```

### 2. Research If Needed

- If changes require new technical understanding: spawn locator/analyzer
- If changes are scope adjustments: skip research

### 3. Present Proposed Changes

```
I plan to update the design by:
- [Modification 1]
- [Modification 2]

Does this align with your intent?
```

### 4. Apply Changes Surgically

- Edit specific sections, don't rewrite whole document
- Preserve what's working
- Use Edit tool for precision

### 5. Re-validate Modified Sections

- Only validate the parts that changed
- "Here's the updated [section]. Does this look right?"

**Max 3 iteration cycles.** If still not converged, suggest stepping back to re-examine the core problem (Phase 2).

---

## Handoff to Plan Creation

When design is validated, present:

```
Design complete: `docs/plans/[topic]-design.md`

The design documents:
- **Problem:** [1 sentence]
- **Selected approach:** [approach name]
- **Key decisions:** [list of 3-5]

**Next steps:**

1. **Create implementation plan:** `/fly:plan docs/plans/[topic]-design.md`
   - Creates a phase-by-phase implementation plan

2. **Start implementing directly:** `/fly:work`
   - Only if design is simple enough (S effort)

3. **Explore more:** Continue brainstorming
   - If new questions emerged during design

Which would you like to do?
```

---

## Context Management

Brainstorm sessions can run long. Watch for:

**Warning signs:**
- >3 research cycles in Phase 1.5
- >5 questions in Phase 2
- >3 design iteration cycles in Phase 5b

**Compaction actions:**
- After Phase 1.5: Write research summary to context file
- After Phase 3: Archive non-selected approaches to design doc
- After each Phase 4 section: Reference design doc path, not content

**If context >40%:**
1. Write current state to design document
2. Present: "We've explored a lot. Let me save progress and we can continue fresh."
3. AskUserQuestion: Continue now / Clear context and resume / Stop here

---

## Key Principles

- **One question at a time**
- **Multiple choice preferred**
- **Lead with recommendations**
- **YAGNI ruthlessly**
- **Incremental validation**
- **Preserve all approaches**

---

## Error Handling

- **Agent failures**: Continue without research context
- **web-searcher timeout (15s)**: Continue with partial results
- **User abandonment**: Save partial progress to draft

---

## Anti-Patterns

- Dump research findings on user
- Ask multiple questions at once
- Skip approach exploration
- Present big documents all at once
- Only document selected approach

---

## Detailed References

- `references/design-document-template.md` - Output format, approach format, validation sections
