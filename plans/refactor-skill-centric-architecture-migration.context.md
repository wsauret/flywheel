---
plan: refactor-skill-centric-architecture-migration.md
design_doc: plans/skill-centric-architecture-design.md
created: 2026-01-18
feature: "Skill-centric architecture migration - converting workflow commands to skills with research persistence"
researchers:
  - codebase-analysis
  - design-document-review
---

# Research Context: Skill-Centric Architecture Migration

## Repository Analysis

### Architecture & Conventions

- **Project type**: Claude Code plugin (Markdown-based configuration with YAML frontmatter)
- **Plugin structure**: `plugin/` directory containing commands, agents, and skills
- **Config format**: YAML frontmatter in markdown files for metadata

### File References (for subsequent agents to load)

```
plugin/commands/workflows/plan.md:1-594        # Current plan command (594 lines)
plugin/commands/workflows/work.md:1-335        # Current work command (335 lines)
plugin/commands/workflows/brainstorm.md:1-370  # Current brainstorm command (370 lines)
plugin/commands/workflows/review_plan.md:1-783 # Current review_plan command (783 lines)
plugin/commands/workflows/review_work.md:1-427 # Current review_work command (427 lines)
plugin/commands/workflows/compound.md:1-199    # Current compound command (199 lines)

plugin/skills/file-todos/SKILL.md:1-252        # Existing skill example (252 lines)
plugin/skills/compound-docs/SKILL.md           # Existing skill example
plugin/skills/git-worktree/SKILL.md            # Existing skill example

plugin/agents/review/security-sentinel.md      # Agent with description in frontmatter
plugin/agents/research/repo-research-analyst.md # Research agent example

plans/skill-centric-architecture-design.md     # Design document with all approaches
```

### Naming Conventions

- **Commands**: `name: workflows:<command-name>` in YAML frontmatter
- **Skills**: Directory with `SKILL.md` file (e.g., `skills/file-todos/SKILL.md`)
- **Agents**: `name: <agent-name>` with `description:` containing examples
- **Plans**: `plans/<type>-<descriptive-name>.md` in kebab-case

### Current Plugin Structure

```
plugin/
├── agents/
│   ├── research/           # 4 research agents
│   │   ├── repo-research-analyst.md
│   │   ├── best-practices-researcher.md
│   │   ├── framework-docs-researcher.md
│   │   └── git-history-analyzer.md
│   ├── review/             # 9 review agents
│   │   ├── security-sentinel.md
│   │   ├── performance-oracle.md
│   │   ├── architecture-strategist.md
│   │   ├── code-simplicity-reviewer.md
│   │   ├── data-integrity-guardian.md
│   │   ├── pattern-recognition-specialist.md
│   │   ├── agent-native-reviewer.md
│   │   ├── python-reviewer.md
│   │   └── typescript-reviewer.md
│   └── workflow/           # 3 workflow agents
│       ├── pr-comment-resolver.md
│       ├── spec-flow-analyzer.md
│       └── lint.md
├── commands/
│   ├── workflows/          # 6 workflow commands (TO BE REPLACED)
│   │   ├── brainstorm.md   # 370 lines
│   │   ├── plan.md         # 594 lines
│   │   ├── review_plan.md  # 783 lines
│   │   ├── work.md         # 335 lines
│   │   ├── review_work.md  # 427 lines
│   │   └── compound.md     # 199 lines
│   ├── triage.md
│   ├── resolve-file-todos.md
│   └── resolve-pr-comments.md
├── skills/
│   ├── file-todos/         # Existing skill (unchanged)
│   │   ├── SKILL.md
│   │   └── assets/
│   ├── compound-docs/      # Existing skill (unchanged)
│   │   ├── SKILL.md
│   │   ├── assets/
│   │   └── references/
│   └── git-worktree/       # Existing skill (unchanged)
│       └── SKILL.md
└── README.md
```

### Team Conventions (from CLAUDE.md)

- Multi-repository parent directory structure
- Our team works on Python services in `backend/services/`
- Plugin development follows Claude Code plugin conventions
- Commands use `$ARGUMENTS` variable for user input
- Agents invoked via `Task <agent-name>:` pattern

## External Research

### Framework Documentation

- Claude Code plugin system: YAML frontmatter metadata
- Skill format: `name:` and `description:` in frontmatter
- Agent format: `name:`, `description:`, `model:` in frontmatter
- Tool scoping: `tools:` array in agent frontmatter (to be added)

### Best Practices Found

- Skills contain procedural knowledge (150-300 lines focused content)
- Commands are thin wrappers that invoke skills (~15-20 lines)
- Research should persist to `.context.md` files and clear from context
- Agents should have scoped tool access based on their role

### Similar Implementations

- `plugin/skills/file-todos/SKILL.md:1-252` - Existing skill pattern
- `inspiration/superpowers/` - Reference skill-centric implementation

## Gotchas & Warnings

- Commands must use `/fly:*` namespace to avoid conflicts with built-in `/plan` and `/review`
- Skills need `allowed-tools` field for tool restriction
- Agents need `tools:` field for scoping (not currently present)
- Design doc validated that `review_plan` should be merged into `planning` skill phases
- `review_work` remains separate as it reviews code, not plans

## Gaps & Unknowns

- Exact YAML syntax for tool scoping in agents (need to verify Claude Code docs)
- Whether `allowed-tools` vs `tools` is the correct field name for skills
- How auto-activation triggers work in Claude Code (description pattern matching)

## Research Quality

- **Confidence**: High (based on design document and existing codebase analysis)
- **Last verified**: 2026-01-18
- **Gaps**: Tool scoping syntax may need verification

## Design Document Summary

The design document (`plans/skill-centric-architecture-design.md`) provides:

### Selected Approach: Hybrid of Research-First + Skill-First

Parallel build with research persistence as first-class pattern:
- Build skills with research persistence baked in from the start
- Parallel build approach (new system alongside old, then switch)
- 4-week timeline (vs original 10-week phased migration)

### Key Architecture Decisions

1. **4 skills** for workflow phases:
   - `brainstorming/SKILL.md` (~150 lines)
   - `planning/SKILL.md` (~250-300 lines, includes create + deepen + review)
   - `executing-work/SKILL.md` (~200 lines)
   - `reviewing/SKILL.md` (~150 lines)
   - `compounding/SKILL.md` (~100 lines)

2. **5 thin commands** as entry points:
   - `/fly:brainstorm` -> brainstorming skill
   - `/fly:plan` -> planning skill
   - `/fly:work` -> executing-work skill
   - `/fly:review` -> reviewing skill
   - `/fly:compound` -> compounding skill

3. **16 agents** with scoped tool access:
   - Research agents: Read, Grep, Glob, WebFetch, WebSearch
   - Review agents: Read, Grep, Glob (read-only)
   - Workflow agents: Read, Write, Edit, Bash, Grep, Glob

4. **Research persistence pattern**:
   - Run research agents in parallel
   - Persist findings to `.context.md` file
   - Clear research from conversation context
   - Downstream skills load `.context.md` instead of re-researching

### Success Criteria from Design

| Metric | Target |
|--------|--------|
| Research not in context after persist | 0 research agent output in context |
| Context file reused by downstream skills | Loads from .context.md, no re-research |
| Overall context reduction | >30% reduction for full workflow |
| Auto-activation accuracy | >80% correct activation on natural language |
| Lines per command | ~15-20 (down from 370-594) |
| Lines per skill | ~150-300 (focused) |

### Migration Strategy

**Parallel Build, Then Switch:**
- Week 1-2: Build all 5 skills + thin commands
- Week 3: Test thoroughly, fix issues
- Week 4: Delete old `/workflows:*` commands, ship

### Implementation Order (from design)

1. Create directory structure
2. Build planning skill first (most complex, validates pattern)
3. Build executing-work skill second (tests .context.md loading)
4. Build remaining skills (brainstorming, reviewing, compounding)
5. Add tool scoping to all 16 agents (parallel with skill work)
6. Create thin commands (trivial once skills exist)
7. Test full workflow (brainstorm -> plan -> work -> review -> compound)
8. Delete old `commands/workflows/` (clean cut)
