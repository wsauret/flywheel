---
name: brainstorming
description: Conversational exploration of ideas before detailed planning. One question at a time, explores 2-3 approaches, validates design incrementally. Triggers on "explore", "brainstorm", "think about", "let's discuss".
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Task
  - AskUserQuestion
---

# Brainstorming Skill

Transform ideas into validated designs through natural collaborative dialogue. Output is a design document that the planning skill can consume.

## Input

The feature idea or problem to explore is provided via `$ARGUMENTS`.

**If empty:** Ask "What would you like to explore? Describe the feature, improvement, or problem you're thinking about."

---

## Phase 1: Silent Research

Run research agents to understand context. **DO NOT present findings to user** - use them to ask smarter questions.

**Run in parallel (all three):**
- Task repo-research-analyst(feature_idea)
- Task framework-docs-researcher(feature_idea)
- Task best-practices-researcher(feature_idea)

**Timeout policy:**
- repo-research-analyst: Required (local, fast)
- framework-docs-researcher: Required (local, fast)
- best-practices-researcher: **15s timeout** - continue without if slow

**Extract for internal use:**
- Relevant existing patterns (to reference when exploring approaches)
- Technical constraints (to inform feasibility questions)
- Similar implementations (to suggest as approaches)
- Naming conventions (to use in design)
- Best practices from external sources (to validate approaches)

---

## Phase 2: Understand the Idea

Ask questions **one at a time** to refine the idea. Prefer multiple choice.

**Rules:**
1. **One question per message** - Never ask multiple questions at once
2. **Prefer multiple choice** - Use AskUserQuestion with 2-4 options
3. **Lead with recommendation** - State your opinion and explain why
4. **YAGNI ruthlessly** - Challenge scope creep

**Question sequence (adapt as needed):**
1. Clarify the core problem
2. Understand the user/audience
3. Define success criteria
4. Identify constraints
5. Scope check - "Is [X] part of this, or separate?"

**Continue until you understand:**
- [ ] The core problem being solved
- [ ] Who benefits and how
- [ ] What success looks like
- [ ] What's explicitly out of scope
- [ ] Key constraints

---

## Phase 3: Explore Approaches

**ALWAYS present 2-3 approaches** - even for "obvious" solutions.

**Use best practices research** to inform approaches:
- Reference industry patterns discovered
- Note when an approach aligns with best practices
- Flag when an approach deviates (and why it might still be valid)

**Format each approach:**
```
### Approach A: [Name] (Recommended)

[2-3 sentence summary]

**Pros:** [bullet list]
**Cons:** [bullet list]
**Effort:** S / M / L

**Why recommended:** [1 sentence]
```

**Then ask user to select** using AskUserQuestion with approach options.

If user wants to combine/modify: Clarify what aspects, present hybrid as new approach, confirm.

---

## Phase 4: Validate Design Incrementally

Present design in **small chunks (200-300 words each)**. After each chunk, ask if it looks right.

**Section order:**
1. Overview (what we're building, why)
2. User flows (step-by-step from user perspective)
3. Architecture (components, how they connect)
4. Data model (if applicable)
5. Error handling (what can go wrong)
6. Success criteria (how we'll verify it works)

**After EACH section:** "Does this look right so far? Anything to adjust?"

Handle feedback immediately - don't move to next section until current one is validated.

---

## Phase 5: Create Design Document

**File path:** `plans/<topic>-design.md` (kebab-case topic)

**Structure:**
```markdown
---
created: <date>
status: validated
type: design
brainstorm_session: true
---

# Design: [Feature Name]

## Overview
[What we're building and why]

## Context & Requirements

### Problem Statement
[Core problem being solved]

### Success Criteria
[How we'll know it works]

### Constraints
[Technical, business, user constraints]

### Out of Scope
[What's explicitly NOT included]

## All Explored Approaches

### Approach A: [Name] ✓ SELECTED
[Full details with pros/cons/effort]

### Approach B: [Name]
[Full details with pros/cons/effort]

### Selection Rationale
[Why selected approach was chosen]

## Selected Approach Details

### User Flows
[From Phase 4]

### Architecture
[From Phase 4]

### Data Model
[If applicable]

### Error Handling
[From Phase 4]

## Open Questions
[Any unresolved questions]
```

### Announce & Offer Handoff

```
✅ Design document saved: plans/<topic>-design.md

Summary:
- Selected approach: [Approach name]
- [N] alternative approaches documented
- [N] sections validated
```

**Use AskUserQuestion:**
```
Question: "Design validated and saved. What would you like to do next?"
Options:
1. Start /fly:plan (Recommended) - Create detailed implementation plan
2. Review the design document - Open and review what was created
3. Continue refining - Revisit specific sections
4. Done for now - Save and come back later
```

---

## Key Principles

- **One question at a time** - Never overwhelm with multiple questions
- **Multiple choice preferred** - Faster to pick than generate
- **Lead with recommendations** - "I recommend X because Y"
- **YAGNI ruthlessly** - "Do we really need this for v1?"
- **Incremental validation** - Don't build up to big reveals
- **Preserve all approaches** - Document ALL approaches, not just selected

## Error Handling

### Agent Failures
- Log failure with agent name and error
- Continue without research context if agents fail
- Proceed to questioning phase - research enhances but isn't required
- **best-practices-researcher timeout (15s)**: Continue with partial results

### User Abandonment
- If user stops responding, save partial progress to draft file
- Note where conversation ended for resume

## Anti-Patterns

- Don't dump research findings on user
- Don't ask multiple questions at once
- Don't skip approach exploration
- Don't present big design documents all at once
- Don't only document the selected approach
