---
name: workflows:brainstorm
description: Conversational exploration of ideas before detailed planning. One question at a time, explores 2-3 approaches, validates design incrementally.
argument-hint: "[feature idea or problem to explore]"
---

# Brainstorm Ideas Into Designs

## Introduction

**Note: The current year is 2026.** Use this when dating designs and searching for documentation.

Help turn ideas into fully formed designs through natural collaborative dialogue. This command focuses on **what to build** - exploring requirements, constraints, and approaches before detailed implementation planning.

The output is a design document that `/workflows:plan` can use to skip research and focus on **how to build it**.

## Feature Idea

<feature_idea> #$ARGUMENTS </feature_idea>

**If the feature idea above is empty, ask the user:** "What would you like to explore? Describe the feature, improvement, or problem you're thinking about."

Do not proceed until you have a clear idea to explore.

---

## Phase 1: Context Gathering (Silent)

<thinking>
First, understand the project context. Run research agents but DON'T dump findings on the user - use them to inform better questions. The user wants a conversation, not a research report.
</thinking>

**Run these agents in parallel (results for YOUR use, not to present):**

- Task repo-research-analyst(feature_idea) - Understand codebase patterns
- Task framework-docs-researcher(feature_idea) - Understand framework constraints

**Extract and keep for yourself:**
- [ ] Relevant existing patterns (to reference when exploring approaches)
- [ ] Technical constraints (to inform feasibility questions)
- [ ] Similar implementations (to suggest as approaches)
- [ ] Naming conventions (to use in design)

**DO NOT present research findings to the user.** Use them silently to ask smarter questions.

---

## Phase 2: Understand the Idea (Conversational)

<thinking>
Ask questions one at a time to refine the idea. Prefer multiple choice when possible - it's easier for users to pick from options than to generate answers. Focus on understanding purpose, constraints, and success criteria.
</thinking>

### Questioning Guidelines

**CRITICAL RULES:**
1. **One question per message** - Never ask multiple questions at once
2. **Prefer multiple choice** - Use AskUserQuestion with 2-4 options when possible
3. **Lead with recommendation** - When you have an opinion, state it and explain why
4. **YAGNI ruthlessly** - Challenge scope creep, ask "do we really need this?"

**Question Sequence (adapt as needed):**

1. **Clarify the core problem** - "What's the main problem you're trying to solve?"
2. **Understand the user** - "Who is this for? What's their context?"
3. **Define success** - "How will we know this is working?"
4. **Identify constraints** - "What can't change? What are the boundaries?"
5. **Scope check** - "Is [X] part of this, or a separate feature?"

**Use AskUserQuestion like this:**

```
AskUserQuestion:
Question: "What should happen when [scenario]?"
Options:
1. [Option A - your recommendation] (Recommended)
2. [Option B]
3. [Option C - simpler alternative]
```

**Keep going until you understand:**
- [ ] The core problem being solved
- [ ] Who benefits and how
- [ ] What success looks like
- [ ] What's explicitly out of scope
- [ ] Key constraints (technical, business, user)

---

## Phase 3: Explore Approaches

<thinking>
Before settling on a design, always present 2-3 approaches with trade-offs. Lead with your recommendation but give real alternatives. Use research findings to inform realistic options.
</thinking>

### Always Present 2-3 Approaches

**NEVER skip this step.** Even for "obvious" solutions, present alternatives.

**Present each approach with:**
```
### Approach A: [Name] (Recommended)

[2-3 sentence summary]

**Pros:**
- [Pro 1]
- [Pro 2]

**Cons:**
- [Con 1]
- [Con 2]

**Effort:** S / M / L

**Why recommended:** [1 sentence]
```

**Then ask:**
```
AskUserQuestion:
Question: "Which approach should we go with?"
Options:
1. Approach A - [brief summary] (Recommended)
2. Approach B - [brief summary]
3. Approach C - [brief summary]
4. Combine/modify approaches
```

**If user wants to combine or modify:**
- Clarify what aspects of each to combine
- Present the hybrid as a new "Approach D"
- Confirm before proceeding

---

## Phase 4: Validate Design (Incremental)

<thinking>
Present the design in small chunks (200-300 words each). After each chunk, ask if it looks right. This prevents building up to a big reveal that misses the mark.
</thinking>

### Present Design in Sections

**Section order:**
1. Overview (what we're building, why)
2. User flows (step-by-step from user perspective)
3. Architecture (components, how they connect)
4. Data model (if applicable)
5. Error handling (what can go wrong)
6. Success criteria (how we'll verify it works)

**After EACH section, ask:**
```
"Does this look right so far? Anything to adjust before I continue?"
```

**Handle feedback immediately:**
- If something's wrong, revise and present again
- Don't move to next section until current one is validated
- It's OK to go back to earlier sections if new info emerges

**Section template:**
```markdown
### [Section Name]

[200-300 words of design content]

**Key decisions:**
- [Decision 1 and rationale]
- [Decision 2 and rationale]

---
Does this look right so far?
```

---

## Phase 5: Finalize & Save

<thinking>
Once all sections are validated, compile into a design document. Include ALL explored approaches (not just selected) so review_plan can access alternatives.
</thinking>

### Create Design Document

**File path:** `plans/<topic>-design.md`

**Convert topic to kebab-case:**
- "User Authentication Flow" → `plans/user-authentication-flow-design.md`
- "Add dark mode toggle" → `plans/dark-mode-toggle-design.md`

### Design Document Structure

```markdown
---
created: <date>
status: validated
type: design
brainstorm_session: true
---

# Design: [Feature Name]

## Overview

[What we're building and why - from Phase 4]

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

[Full details from Phase 3]

**Pros:**
- [...]

**Cons:**
- [...]

**Effort:** [S/M/L]

### Approach B: [Name]

[Full details from Phase 3]

**Pros:**
- [...]

**Cons:**
- [...]

**Effort:** [S/M/L]

### Approach C: [Name]

[If applicable - full details]

### Selection Rationale

[Why the selected approach was chosen over alternatives]

## Selected Approach Details

### User Flows

[From Phase 4 validation]

### Architecture

[From Phase 4 validation]

### Data Model

[If applicable - from Phase 4]

### Error Handling

[From Phase 4 validation]

## Open Questions

[Any unresolved questions discovered during brainstorming]

## Research Context

### Codebase Patterns Referenced

[Relevant patterns found during silent research]

### Framework Considerations

[Framework-specific notes from research]

### Similar Implementations

[Internal or external references]
```

### Write the Design Document

**Save to:** `plans/<topic>-design.md`

**Announce completion:**
```
✅ Design document saved: plans/<topic>-design.md

Summary:
- Selected approach: [Approach name]
- [N] alternative approaches documented
- [N] sections validated
```

### Offer Handoff

**Use AskUserQuestion:**

```
Question: "Design validated and saved. What would you like to do next?"
Options:
1. Start `/workflows:plan` (Recommended) - Create detailed implementation plan from this design
2. Review the design document - Open and review what was created
3. Continue refining - Revisit specific sections of the design
4. Done for now - Save and come back later
```

**Based on selection:**
- **`/workflows:plan`** → Run `/workflows:plan plans/<topic>-design.md`
- **Review** → `open plans/<topic>-design.md`
- **Refine** → Ask which section to revisit, return to Phase 4
- **Done** → Confirm save location and exit

---

## Key Principles

### One Question at a Time
Never overwhelm with multiple questions. If a topic needs more exploration, break it into multiple single questions.

### Multiple Choice Preferred
Use AskUserQuestion with options whenever possible. It's faster to pick than to generate.

### Lead with Recommendations
When you have an opinion, state it clearly: "I recommend X because Y. But you could also Z."

### YAGNI Ruthlessly
Actively challenge scope creep:
- "Do we really need this for v1?"
- "Could this be a fast-follow instead?"
- "What's the simplest version that solves the problem?"

### Incremental Validation
Don't build up to a big reveal. Present in small chunks, validate each one.

### Be Flexible
Go back when something doesn't make sense. It's OK to revisit earlier decisions.

### Preserve All Approaches
Document ALL approaches explored, not just the selected one. This helps `/workflows:review_plan` suggest alternatives if issues are found.

---

## Anti-Patterns to Avoid

❌ **Don't dump research findings** - Use them to ask better questions, don't present them
❌ **Don't ask multiple questions at once** - One question per message, always
❌ **Don't skip approach exploration** - Even "obvious" features have alternatives
❌ **Don't present big design documents** - Break into 200-300 word chunks
❌ **Don't forget to validate each section** - Ask "does this look right?" after each
❌ **Don't only document selected approach** - All approaches go in the design doc
❌ **Don't gold-plate** - Simpler is better, challenge unnecessary complexity

---

NEVER CODE! This command is for brainstorming and design only.
