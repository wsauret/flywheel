# Design Document Template

Output format for validated designs.

## File Location

```
plans/<topic>-design.md
```

Use kebab-case for topic.

---

## Template

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
[From validation phase]

### Architecture
[From validation phase]

### Data Model
[If applicable]

### Error Handling
[From validation phase]

## Open Questions
[Any unresolved questions]
```

---

## Approach Format

Present 2-3 approaches with explicit tradeoffs:

```markdown
### Approach A: [Name] (Recommended)

**Summary:** [2-3 sentences explaining the approach]

**Tradeoffs:**
| Pro | Con |
|-----|-----|
| [Benefit 1] | [Drawback 1] |
| [Benefit 2] | [Drawback 2] |
| [Benefit 3] | [Drawback 3] |

**When to choose this:** [Scenario where this is the best choice]
**When NOT to choose this:** [Scenario where this approach fails]

**Effort:** S / M / L

**Why recommended:** [1 sentence if this is the recommended approach]
```

**Key:** Forcing tradeoffs ensures we think about failure modes, not just benefits.

---

## Validation Sections

Present design in small chunks (200-300 words each). Order:

1. Overview (what, why)
2. User flows (step-by-step from user perspective)
3. Architecture (components, connections)
4. Data model (if applicable)
5. Error handling (what can go wrong)
6. Success criteria (how to verify)

After EACH section: "Does this look right so far?"

---

## Completion Summary

```
✅ Design document saved: plans/<topic>-design.md

Summary:
- Selected approach: [Approach name]
- [N] alternative approaches documented
- [N] sections validated
```

---

## Handoff Options

Present explicit next steps:

```markdown
Design complete: `plans/[topic]-design.md`

The design documents:
- **Problem:** [1 sentence summary]
- **Selected approach:** [approach name]
- **Key decisions:** [3-5 bullet points]

**Next steps:**

1. **Create implementation plan:** `/fly:plan plans/[topic]-design.md`
   - Creates a phase-by-phase implementation plan from this design

2. **Start implementing directly:** `/fly:work`
   - Only if design is simple enough (S effort)

3. **Explore more:** Continue brainstorming
   - If new questions emerged during design

4. **Done for now:** Save and come back later

Which would you like to do?
```

**AskUserQuestion format:**
```
Question: "Design validated and saved. What next?"
Options:
1. Create implementation plan (Recommended) - /fly:plan
2. Start implementing directly - /fly:work (S effort only)
3. Continue refining - Revisit specific sections
4. Done for now - Save and come back later
```
