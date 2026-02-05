# Flywheel Plugin

A Claude Code plugin that makes each unit of engineering work easier than the last.

## Install

In Claude Code, run:

```
/plugin marketplace add wsauret/flywheel
/plugin install flywheel@flywheel-marketplace
```

### Optional: Context7 Setup

Context7 provides up-to-date framework documentation for the planning workflow.
Get a free API key at https://context7.com/dashboard, then run:

```bash
claude mcp add --header "CONTEXT7_API_KEY: your-key-here" \
  --transport http context7 https://mcp.context7.com/mcp
```

### Local Install (for contributors)

```bash
git clone https://github.com/wsauret/flywheel.git
cd flywheel
./install.sh
```

The install script will:
1. Add the marketplace to Claude Code
2. Install the Flywheel plugin
3. Optionally configure Context7 with your API key

### Upgrading from local-marketplace

If you previously installed via the old local-marketplace pattern:

```bash
claude plugin marketplace remove local-marketplace
```

Then follow the standard install instructions above.

## Workflow

```
Brainstorm → Plan → Work → Review → Compound → Repeat
```

| Command | Purpose |
|---------|---------|
| `/fly:brainstorm` | Explore ideas conversationally before detailed planning |
| `/fly:research` | Comprehensive codebase research using locate→analyze pattern |
| `/fly:plan` | Create, verify, review, and consolidate implementation plans |
| `/fly:work` | Execute plans with continuous testing and quality checks |
| `/fly:review` | Multi-agent code review with structured todo tracking |
| `/fly:compound` | Document solved problems for future reference |

Each cycle compounds: plans inform future plans, reviews catch more issues, patterns get documented.

## Commands

### `/fly:brainstorm`
Conversational exploration of ideas before detailed planning. Asks one question at a time, explores 2-3 approaches, validates design incrementally. Creates a design document that feeds into planning.

### `/fly:research`
Comprehensive codebase research using a two-phase locate→analyze pattern. Spawns locator agents in parallel (cheap, haiku) to find WHERE things are, then analyzer agents (expensive, sonnet) to understand HOW they work. Creates persistent research documents in `docs/research/`.

### `/fly:plan`
Full planning workflow that orchestrates four phases:
1. **Create** - Draft initial plan based on codebase patterns (creative/generative)
2. **Verify** - Validate assumptions against docs, check claims aren't hallucinated (fact-checking)
3. **Review** - Critique from multiple perspectives via reviewer agents (security, performance, architecture)
4. **Consolidate** - Resolve open questions with user, synthesize into actionable checklists

Each phase writes to the same plan file. Open questions and conflicts between agents are surfaced for user decision during consolidation.

### `/fly:work`
Execute plans using a probe-dispatch-checkpoint pattern. Loads context files, dispatches subagents per phase, runs tests continuously, and maintains state for recovery.

### `/fly:review`
Exhaustive code reviews using multi-agent analysis. Discovers and runs ALL available reviewer agents in parallel, deduplicates findings, detects conflicts, and creates structured todo files.

### `/fly:compound`
Document solved problems using parallel subagents while context is fresh. Creates structured documentation in `docs/solutions/` with YAML frontmatter for fast lookup.

## Skills

Core workflow skills (invoked by commands):
- **brainstorm** - Conversational exploration of ideas before planning
- **codebase-research** - Comprehensive research using locate→analyze pattern
- **plan-creation** - Draft plans based on codebase patterns; flags claims for verification
- **plan-verification** - Validate assumptions are real, not hallucinated; check framework compatibility
- **plan-review** - Critique from multiple perspectives; conflicts become open questions
- **plan-consolidation** - Resolve questions with user input; create actionable checklists
- **work-implementation** - Execute plans following patterns, testing continuously
- **work-review** - Multi-agent code review with todo file creation

Utility skills:
- **compound-docs** - Structured problem documentation with YAML validation
- **git-worktree** - Isolated parallel development with worktrees
- **flywheel-conventions** - Shared conventions for subagents (internal)

## Agents

### Reviewers (8)
Run in parallel during plan-review and work-review:
- **architecture-reviewer** - System design and architectural patterns
- **code-quality-reviewer** - Python/TypeScript review with high quality bar
- **code-simplicity-reviewer** - YAGNI, complexity reduction
- **pattern-reviewer** - Patterns and anti-patterns detection
- **security-reviewer** - Vulnerabilities, OWASP compliance
- **performance-reviewer** - Bottlenecks, optimization opportunities
- **data-integrity-reviewer** - Migrations, transactions, referential integrity
- **git-history-reviewer** - Code evolution and contributor patterns

### Research Locators (4)
Find WHERE things are (cheap, parallel, haiku model):
- **codebase-locator** - Find file paths and components
- **pattern-locator** - Find pattern locations (file:line refs)
- **docs-locator** - Find documentation files
- **web-searcher** - Find relevant URLs (no fetching)

### Research Analyzers (4)
Understand HOW things work (expensive, targeted, sonnet model):
- **codebase-analyzer** - Document implementation details
- **pattern-analyzer** - Extract code examples with context
- **docs-analyzer** - Extract insights from documentation
- **web-analyzer** - Fetch and analyze web content

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

### Compound Engineering

**Each unit of engineering work should make subsequent units easier—not harder.**

In traditional engineering, you expect each feature to make the next feature harder to build—more code means more edge cases, more interdependencies, more issues. In compound engineering, you expect each feature to make the next feature *easier* to build.

This happens because compound engineering creates a learning loop: each bug, failed test, or problem-solving insight gets documented and used by future agents. The complexity of your codebase still grows, but so does the AI's knowledge of it.

The loop is: **Plan → Work → Review → Compound → Repeat**

Roughly 80% of compound engineering is in planning and review, 20% is in work and compounding. The "compound" step is where the magic happens—you take what you learned and record it so the agent uses it next time. These learnings are automatically distributed to your team because they live in your codebase.

### Human Leverage

AI coding tools struggle with complex codebases, but you can succeed if you focus human attention at the highest-leverage points:

| Review Target | Prevents |
|---------------|----------|
| Research | Thousands of bad lines |
| Plans | Hundreds of bad lines |
| Code | Individual mistakes |

A bad line of research—a misunderstanding of how the codebase works—leads to thousands of bad lines of code. A bad line in a plan leads to hundreds. Flywheel requires human approval at research and plan boundaries because that's where your attention has the most impact.

### Frequent Intentional Compaction

Context windows fill up with search results, file contents, and tool outputs. Flywheel manages this through deliberate compaction at each phase:

- **Research** produces compact `.context.md` files, not sprawling chat
- **Plans** distill research into actionable checklists
- **Subagents** get fresh context for tasks, return compact results
- **Session files** enable recovery without re-reading everything

This keeps context utilization in the 40-60% range where models perform best.

## Inspiration

This project is heavily inspired by two excellent projects:

- **[Compound Engineering Plugin](https://github.com/EveryInc/compound-engineering-plugin)** by Every - The original implementation of compound engineering workflows for Claude Code, demonstrating how to make each unit of work easier than the last.

- **[HumanLayer Claude Config](https://github.com/humanlayer/humanlayer/tree/main/.claude)** by HumanLayer - Patterns for human-in-the-loop AI development, including approval workflows and structured agent interactions.
