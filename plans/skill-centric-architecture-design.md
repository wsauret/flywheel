---
created: 2026-01-18
status: validated
type: design
brainstorm_session: true
---

# Design: Skill-Centric Architecture Migration

## Overview

**What we're building:**

A hybrid skill-centric architecture where:
- **4 skills** contain the procedural knowledge for each workflow phase (brainstorming, planning, executing-work, reviewing, compounding)
- **5 thin commands** provide explicit `/fly:*` entry points that invoke skills
- **16 agents** remain as specialized parallel workers, now with scoped tool access
- **Research persistence pattern** standardizes how research is saved to `.context.md` files and cleared from context

**Why:**
- **Token efficiency**: Research output saved to files and cleared from context; skills load only when needed
- **Maintainability**: 370-594 line commands become ~20 line commands + ~150-300 line skills; concerns are separated
- **Auto-activation**: Skills can trigger on natural language ("create a plan for X") in addition to explicit commands
- **Focused agents**: Scoped tool access (e.g., review agents get only Read/Grep/Glob) improves speed and accuracy

**What's NOT changing:**
- The workflow sequence (brainstorm → plan → work → review)
- The 16 agent definitions (just adding tool scoping)
- The ability to use explicit `/commands`

## Context & Requirements

### Problem Statement

1. **Token efficiency**: Context window fills up from conversation history and research output accumulating in context
2. **Inconsistent research persistence**: `.context.md` files exist but are used inconsistently with no clear pattern
3. **Maintainability**: Workflow commands are 370-594 lines, mixing orchestration with procedural knowledge

### Success Criteria

| Metric | Target |
|--------|--------|
| Research not in context after persist | 0 research agent output in context |
| Context file reused by downstream skills | Loads from .context.md, no re-research |
| Overall context reduction | >30% reduction for full workflow |
| Auto-activation accuracy | >80% correct activation on natural language |
| Lines per command | ~15-20 (down from 370-594) |
| Lines per skill | ~150-300 (focused) |

### Constraints

- Must use `/fly:*` namespace to avoid conflicts with built-in `/plan` and `/review` commands
- Skills must be able to invoke agents via Task tool
- Planning skill must handle create → deepen → review as distinct phases

### Out of Scope

- Backward compatibility with `/workflows:*` commands (not needed)
- New agent definitions (only scoping existing 16)
- Changes to file-todos, compound-docs, git-worktree skills (unchanged)

## All Explored Approaches

### Approach A: Research-First Migration

Start by solving the token problem (research persistence), then convert to skills.

**Pros:**
- Addresses biggest pain point (token efficiency) immediately
- Research pattern is reusable across all skills

**Cons:**
- Two-step migration instead of one
- Research orchestrator adds a new abstraction

**Effort:** M

### Approach B: Skill-First Migration (Original Draft Plan)

Convert commands to skills first, with research persistence built into each skill. 10-week phased rollout.

**Pros:**
- Follows existing detailed plan
- Clear phased structure

**Cons:**
- Research persistence logic duplicated in each skill
- Longer before token efficiency benefits
- 10-week timeline is substantial

**Effort:** L

### Approach C: Minimal Extraction

Don't do a full migration. Just extract research patterns and keep commands.

**Pros:**
- Least work, fastest to implement
- Solves token problem without architectural change

**Cons:**
- Doesn't achieve auto-activation UX
- Doesn't address maintainability of large commands

**Effort:** S

### Selection Rationale

**Selected: Hybrid of A + B** - Parallel build with research persistence as first-class pattern.

We chose to build skills with research persistence baked in from the start, but using a parallel build approach (build new system alongside old, then switch) rather than incremental phased migration. This gives us:
- Token efficiency from day one (research persistence pattern)
- Full skill-centric benefits (auto-activation, maintainability)
- Faster timeline (4 weeks vs 10 weeks)
- Clean cut (no deprecation period needed)

## Selected Approach Details

### Command Structure

| Command | Invokes Skill |
|---------|---------------|
| `/fly:brainstorm` | `brainstorming` |
| `/fly:plan` | `planning` |
| `/fly:work` | `executing-work` |
| `/fly:review` | `reviewing` |
| `/fly:compound` | `compounding` |

### User Flows

**Flow 1: Full Feature Development (explicit commands)**

```
User: /fly:brainstorm "add dark mode"
      ↓ brainstorming skill activates
      → explores approaches, validates design
      → saves design to plans/dark-mode-design.md
      → offers: "Ready to plan implementation?"

User: /fly:plan plans/dark-mode-design.md
      ↓ planning skill activates
      → creates plan, deepens with research, reviews for gaps
      → saves to plans/dark-mode.md + plans/dark-mode.context.md
      → offers: "Ready to execute?"

User: /fly:work plans/dark-mode.md
      ↓ executing-work skill activates
      → loads .context.md, executes tasks
      → offers: "Ready for review?"

User: /fly:review
      ↓ reviewing skill activates
      → runs review agents in parallel
      → produces review report
```

**Flow 2: Auto-Activation (natural language)**

```
User: "I want to build a notification system"
      ↓ planning skill auto-activates (detects "build" + feature)
      → same flow as above, but triggered by intent
```

**Flow 3: Mid-Stream Entry**

```
User: /fly:work plans/existing-feature.md
      ↓ executing-work skill activates
      → checks for .context.md (loads if exists)
      → proceeds with execution
```

**Flow 4: Plan Iteration**

```
User: /fly:plan plans/dark-mode.md  (existing plan file)
      ↓ planning skill detects existing plan
      → enters "deepen/review" mode instead of "create" mode
```

### Architecture

**Directory Structure:**

```
plugin/
├── skills/                           # Detailed procedural knowledge
│   ├── brainstorming/
│   │   └── SKILL.md                  # ~150 lines
│   ├── planning/
│   │   ├── SKILL.md                  # ~250-300 lines (create + deepen + review)
│   │   └── references/
│   │       └── plan-templates.md
│   ├── executing-work/
│   │   └── SKILL.md                  # ~200 lines
│   ├── reviewing/
│   │   ├── SKILL.md                  # ~150 lines
│   │   └── checklists/
│   ├── compounding/
│   │   └── SKILL.md                  # ~100 lines
│   ├── file-todos/                   # (existing, unchanged)
│   ├── compound-docs/                # (existing, unchanged)
│   └── git-worktree/                 # (existing, unchanged)
│
├── agents/                           # Scoped parallel workers
│   ├── research/                     # Tools: Read, Grep, Glob, WebFetch, WebSearch
│   │   ├── repo-research-analyst.md
│   │   ├── framework-docs-researcher.md
│   │   ├── git-history-analyzer.md
│   │   └── best-practices-researcher.md
│   ├── review/                       # Tools: Read, Grep, Glob
│   │   ├── security-sentinel.md
│   │   ├── performance-oracle.md
│   │   ├── code-simplicity-reviewer.md
│   │   ├── architecture-strategist.md
│   │   ├── data-integrity-guardian.md
│   │   ├── pattern-recognition-specialist.md
│   │   ├── agent-native-reviewer.md
│   │   ├── python-reviewer.md
│   │   └── typescript-reviewer.md
│   └── workflow/                     # Tools: Read, Write, Edit, Bash, Grep, Glob
│       ├── pr-comment-resolver.md
│       ├── spec-flow-analyzer.md
│       └── lint.md
│
├── commands/                         # Thin wrappers (~15-20 lines each)
│   └── fly/
│       ├── brainstorm.md
│       ├── plan.md
│       ├── work.md
│       ├── review.md
│       └── compound.md
│
└── commands/workflows/               # DELETE after migration
    └── (old commands)
```

**Planning Skill Phases:**

```
┌─────────────────────────────────────────────────────────────┐
│                      planning skill                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Phase 1: Research (parallel agents)                         │
│  ├──→ Task repo-research-analyst                             │
│  ├──→ Task best-practices-researcher                         │
│  └──→ Task framework-docs-researcher                         │
│                                                              │
│  Phase 2: Persist Research                                   │
│  └──→ Write plans/*.context.md                               │
│                                                              │
│  Phase 3: Create Plan                                        │
│  └──→ Write plans/*.md (initial plan structure)              │
│                                                              │
│  Phase 4: Deepen (substantial - parallel agents)             │
│  ├──→ Task git-history-analyzer (understand evolution)       │
│  ├──→ Task pattern-recognition-specialist (find patterns)    │
│  └──→ Update plan with deeper research                       │
│                                                              │
│  Phase 5: Review (substantial - parallel agents)             │
│  ├──→ Task architecture-strategist (validate approach)       │
│  ├──→ Task code-simplicity-reviewer (check overengineering)  │
│  ├──→ Task python-reviewer OR typescript-reviewer (repo)     │
│  └──→ Produce review findings, update plan if needed         │
│                                                              │
│  Phase 6: Finalize                                           │
│  └──→ Offer handoff to /fly:work                             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Research Persistence Pattern

Every skill that runs research agents follows this flow:

```
1. Run research agents in parallel
2. Collect results
3. Extract key findings into structured .context.md file
4. Clear research from conversation context
5. Downstream skills load .context.md instead of re-researching
```

**Context File Structure:**

```markdown
<!-- plans/dark-mode.context.md -->
---
created: 2026-01-18
plan: plans/dark-mode.md
agents_run:
  - repo-research-analyst
  - best-practices-researcher
  - framework-docs-researcher
---

## File References
<!-- Critical files identified during research -->
- src/theme/ThemeProvider.tsx:45 - existing theme context
- src/styles/variables.css:1 - CSS custom properties
- src/hooks/useLocalStorage.ts:12 - persistence hook

## Patterns Found
<!-- Conventions to follow -->
- Theme values stored in CSS variables (--color-*)
- User preferences persisted via useLocalStorage
- Components use `useTheme()` hook, not direct context

## Gotchas & Warnings
<!-- Things that could go wrong -->
- ThemeProvider must wrap entire app (see App.tsx:8)
- Some legacy components use hardcoded colors (grep for #fff, #000)

## External References
<!-- Docs, examples consulted -->
- React context best practices: [link]
- CSS custom properties guide: [link]
```

**Token Impact:**

| Without Pattern | With Pattern |
|-----------------|--------------|
| 3 agents × 3000 tokens = 9000 tokens in context | ~500 tokens (file reference + key points) |
| Re-research if context compacted | Load from file anytime |

### Agent Scoping

**Agent Tool Matrix:**

| Category | Agent | Tools | Rationale |
|----------|-------|-------|-----------|
| **Research** | repo-research-analyst | Read, Grep, Glob, WebFetch | Codebase + web research |
| | best-practices-researcher | Read, Grep, Glob, WebFetch, WebSearch | Needs web search |
| | framework-docs-researcher | Read, Grep, Glob, WebFetch, WebSearch | Needs web search |
| | git-history-analyzer | Read, Grep, Glob, Bash | Bash for git commands only |
| **Review** | architecture-strategist | Read, Grep, Glob | Read-only analysis |
| | code-simplicity-reviewer | Read, Grep, Glob | Read-only analysis |
| | security-sentinel | Read, Grep, Glob | Read-only analysis |
| | performance-oracle | Read, Grep, Glob | Read-only analysis |
| | pattern-recognition-specialist | Read, Grep, Glob | Read-only analysis |
| | data-integrity-guardian | Read, Grep, Glob | Read-only analysis |
| | agent-native-reviewer | Read, Grep, Glob | Read-only analysis |
| | python-reviewer | Read, Grep, Glob | Read-only analysis |
| | typescript-reviewer | Read, Grep, Glob | Read-only analysis |
| **Workflow** | pr-comment-resolver | Read, Write, Edit, Bash, Grep, Glob | Needs to fix code |
| | spec-flow-analyzer | Read, Grep, Glob | Read-only analysis |
| | lint | Read, Bash | Run lint commands |

**Implementation in frontmatter:**

```yaml
---
name: security-sentinel
description: "Use this agent when..."
model: inherit
tools:
  - Read
  - Grep
  - Glob
---
```

### Migration Approach

**Strategy: Parallel Build, Then Switch**

```
Week 1-2: Build all 4 skills + thin commands in new structure
Week 3:   Test thoroughly, fix issues
Week 4:   Delete old /workflows:* commands, ship
```

**Implementation Order:**

1. Create directory structure (`commands/fly/`, `skills/planning/`, etc.)
2. Build planning skill first (most complex, validates pattern)
3. Build executing-work skill second (tests .context.md loading)
4. Build remaining skills (brainstorming, reviewing, compounding)
5. Add tool scoping to all 16 agents (parallel with skill work)
6. Create thin commands (trivial once skills exist)
7. Test full workflow (brainstorm → plan → work → review → compound)
8. Delete old `commands/workflows/` (clean cut)

**Rollback Plan:**

- Old commands are in git history
- `git revert` to restore `commands/workflows/`
- Skills can coexist with commands (no conflict)

## Open Questions

None - all key decisions validated during brainstorming.

## Research Context

### Codebase Patterns Referenced

- Current commands in `plugin/commands/workflows/` (370-594 lines each)
- Existing skills in `plugin/skills/` (file-todos, compound-docs, git-worktree)
- Agent definitions in `plugin/agents/` (16 agents across research/review/workflow)
- Superpowers plugin in `inspiration/superpowers/` (skill-centric reference)

### Framework Considerations

- Claude Code plugin framework uses YAML frontmatter in markdown files
- Skills use `allowed-tools` field to restrict tool access
- Agents use `tools` field for scoping
- Commands use `name` with namespace (e.g., `fly:plan`)

### Similar Implementations

- Superpowers plugin demonstrates skill-centric patterns
- Skill chaining via `REQUIRED SUB-SKILL` annotations
- Description engineering with WHEN + WHEN NOT patterns
