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

**Never write the full design in one shot.** Iterate through dialogue, not monologue.

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

Run research agents to understand context. **DO NOT present findings to user** -- use them to ask smarter questions.

Read `references/research-dispatch.md` before proceeding -- contains locator/analyzer dispatch templates and extraction checklist.

Run locators in parallel (codebase, patterns, docs, web), then analyze top findings for existing patterns, constraints, and conventions.

---

## Phase 1.5: Research Review -- CHECKPOINT

**HIGH LEVERAGE checkpoint. Bad research leads to bad design leads to thousands of bad lines of code.**

Read `references/research-dispatch.md` before proceeding -- contains the presentation format and AskUserQuestion options.

Present a concise research summary (scope, key files, patterns, concerns). AskUserQuestion to approve, add focus, or redirect. Maximum 2 re-research cycles.

---

## Phase 2: Understand the Idea

Ask questions **one at a time** to refine the idea.

**Rules:**
1. One question per message
2. Prefer multiple choice (AskUserQuestion with 2-4 options)
3. Lead with recommendation
4. YAGNI ruthlessly -- challenge scope creep

**Question sequence:**
1. Clarify core problem
2. Understand user/audience
3. Define success criteria
4. Identify constraints
5. Scope check -- "Is X part of this?"

**Continue until you understand:** core problem, who benefits, what success looks like, what's out of scope, key constraints.

### CHECKPOINT: Understanding Confirmation

Read `references/research-dispatch.md` before proceeding -- contains the confirmation template.

Confirm understanding of problem, audience, success criteria, and scope boundaries before moving to approaches.

---

## Phase 2.5: Surface Relevant Learnings

Read `references/research-dispatch.md` before proceeding -- contains the past solutions lookup procedure and presentation format.

Check `docs/solutions/` for relevant past solutions. If matches found, present top 3-5 and ask if they should inform approach selection. If no matches, proceed silently.

---

## Phase 3: Explore Approaches -- CHECKPOINT

**ALWAYS present 2-3 approaches** -- even for "obvious" solutions.

Read `references/approach-exploration.md` before proceeding -- contains the approach format template with tradeoffs table, selection process, and hybrid handling.

Use best practices research to inform approaches. Present each with summary, tradeoffs table, when-to-choose guidance, and effort estimate. Ask user to select via AskUserQuestion.

---

## Phase 4: Validate Design Incrementally -- CHECKPOINT (per section)

Present design in **small chunks (200-300 words each)**.

**Section order:**
1. Overview
2. User flows
3. Architecture
4. Data model (if applicable)
5. Error handling
6. Success criteria

**After EACH section:** "Does this look right so far?" Handle feedback immediately before moving to next section.

---

## Phase 5: Create Design Document

Read `references/design-document-template.md` before proceeding -- contains the full document template, approach format, and validation sections.

Write to `docs/plans/<topic>-design.md`. Include ALL explored approaches (not just selected), validated sections, selection rationale, and open questions.

---

## Phase 5b: Design Iteration (if needed)

Read `references/design-iteration.md` before proceeding -- contains the 5-step iteration procedure (confirm, research, propose, apply, re-validate).

If user has feedback on the design: confirm understanding of changes, research if needed, present proposed modifications, apply surgically, re-validate only modified sections. Max 3 iteration cycles.

---

## Handoff to Plan Creation

Read `references/design-document-template.md` before proceeding -- contains the handoff presentation format and AskUserQuestion options.

When design is validated, present the design summary with problem, selected approach, and key decisions. Offer next steps: `/fly:plan`, `/fly:work`, continue exploring, or save for later.

---

## Context Management

Read `references/context-management.md` before proceeding -- contains warning thresholds, compaction actions, and the >40% context recovery procedure.

Brainstorm sessions can run long. Watch for warning signs (too many research cycles, too many questions, too many iteration cycles). Compact proactively by writing state to design document.

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

## References

- `references/research-dispatch.md` -- Research dispatch templates, review format, understanding confirmation, past solutions lookup
- `references/approach-exploration.md` -- Approach format template with tradeoffs, selection process
- `references/design-document-template.md` -- Output document template, approach format, validation sections, handoff format
- `references/design-iteration.md` -- 5-step design iteration procedure
- `references/context-management.md` -- Warning thresholds, compaction actions, context recovery
