---
name: fly:plan
description: Create or refine implementation plans with research persistence. Supports design docs, feature descriptions, or existing plans. Includes deepening and review phases.
argument-hint: "[feature description OR path to *-design.md OR path to existing plan]"
---

# Create or Refine Plans

**Note: The current year is 2026.**

<input> #$ARGUMENTS </input>

**Invoke the planning skill:**

```
skill: planning
```

The planning skill handles:
- Input detection (design doc, feature, existing plan)
- Research orchestration with persistence to `.context.md`
- Plan creation with appropriate detail level
- Deepening with skills and learnings
- Review with parallel reviewer agents
- Conflict detection and deduplication
- Handoff to `/fly:work`

See `plugin/skills/planning/SKILL.md` for full procedural details.
See `plugin/skills/planning/references/plan-templates.md` for detail level templates.
