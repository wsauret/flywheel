# Flywheel Plugin

A Claude Code plugin that makes each unit of engineering work easier than the last.

## Install

```bash
# Unzip and run the install script
unzip flywheel.zip
cd flywheel
./install.sh
```

The install script will:
1. Add the local marketplace to Claude Code
2. Install the Flywheel plugin
3. Optionally configure Context7 with your API key (get one free at https://context7.com/dashboard)

<!-- When public:
git clone https://github.com/wsauret/flywheel-plugin.git
cd flywheel-plugin
./install.sh
-->

## Workflow

```
Brainstorm → Plan → Work → Review → Compound → Repeat
```

| Command | Purpose |
|---------|---------|
| `/fly:brainstorm` | Explore ideas conversationally before detailed planning |
| `/fly:plan` | Create, deepen, review, and consolidate implementation plans |
| `/fly:work` | Execute plans with continuous testing and quality checks |
| `/fly:review` | Multi-agent code review with structured todo tracking |
| `/fly:compound` | Document solved problems for future reference |

Each cycle compounds: plans inform future plans, reviews catch more issues, patterns get documented.

## Commands

### `/fly:brainstorm`
Conversational exploration of ideas before detailed planning. Asks one question at a time, explores 2-3 approaches, validates design incrementally. Creates a design document that feeds into planning.

### `/fly:plan`
Full planning workflow that orchestrates four phases:
1. **Create** - Research codebase and create initial plan
2. **Deepen** - Enhance with skills, learnings, and research agents (20-40 parallel sub-agents)
3. **Review** - Run all reviewer agents and synthesize findings
4. **Consolidate** - Resolve open questions with user, create actionable checklists

Each phase writes to the same plan file. Open questions and conflicts between agents are surfaced for user decision during consolidation.

### `/fly:work`
Execute plans using a probe-dispatch-checkpoint pattern. Loads context files, dispatches subagents per phase, runs tests continuously, and maintains state for recovery.

### `/fly:review`
Exhaustive code reviews using multi-agent analysis. Discovers and runs ALL available reviewer agents in parallel, deduplicates findings, detects conflicts, and creates structured todo files.

### `/fly:compound`
Document solved problems using parallel subagents while context is fresh. Creates structured documentation in `docs/solutions/` with YAML frontmatter for fast lookup.

## Skills

Core workflow skills (invoked by commands):
- **brainstorming** - Collaborative dialogue to explore and validate designs
- **plan-creation** - Research-backed plan generation
- **plan-deepening** - Parallel research agents enhance plans
- **plan-reviewing** - All reviewers run in parallel, conflicts become open questions
- **plan-consolidation** - Resolve questions with user, create actionable checklists
- **executing-work** - Probe-dispatch-checkpoint execution
- **reviewing** - Multi-agent code review
- **compounding** - Coordinate documentation capture

Utility skills:
- **compound-docs** - Structured problem documentation with YAML validation
- **git-worktree** - Isolated parallel development with worktrees
- **test-first-methodology** - TDD and systematic debugging

## Agents

Review agents (run in parallel during plan-reviewing and reviewing):
- **architecture-strategist** - System design and architectural patterns
- **code-simplicity-reviewer** - YAGNI, complexity reduction
- **pattern-recognition-specialist** - Patterns and anti-patterns
- **security-reviewer** - Vulnerabilities, OWASP compliance
- **performance-analyst** - Bottlenecks, optimization opportunities
- **data-integrity-guardian** - Migrations, transactions, referential integrity
- **python-reviewer** - Python-specific conventions
- **typescript-reviewer** - TypeScript-specific conventions

Research agents (run in parallel during plan-deepening):
- **best-practices-researcher** - External docs and examples
- **framework-docs-researcher** - Library documentation via Context7
- **repo-research-analyst** - Repository patterns and conventions
- **git-history-analyst** - Code evolution and contributor patterns

## Key Features

### Open Questions Flow
Each planning phase surfaces questions and conflicts rather than resolving them:
- Research agents flag trade-offs and ambiguities
- Reviewer agents represent different perspectives (security vs performance vs simplicity)
- Conflicts between agents become open questions
- Consolidation asks user to decide, one question at a time

### Knowledge Compounding
Solved problems are captured in `docs/solutions/` with:
- YAML frontmatter for categorization and search
- Cross-references to related solutions
- Critical patterns extraction for "Required Reading"

### Context7 Integration
Framework documentation queries via MCP:
- Resolve library IDs for any framework/library
- Query up-to-date documentation and examples
- Fallback to web search when needed

## Philosophy

**Each unit of engineering work should make subsequent units easier—not harder.**

Traditional development accumulates technical debt. Every feature adds complexity. The codebase becomes harder to work with over time.

Compound engineering inverts this. 80% is in planning and review, 20% is in execution:
- Plan thoroughly before writing code
- Review to catch issues and capture learnings
- Codify knowledge so it's reusable
- Keep quality high so future changes are easy

## Learn More

- [Compound engineering: how Every codes with agents](https://every.to/chain-of-thought/compound-engineering-how-every-codes-with-agents)
- [The story behind compounding engineering](https://every.to/source-code/my-ai-had-already-fixed-the-code-before-i-saw-it)
