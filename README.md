# Flywheel

A Claude Code plugin that turns development cycles into momentum.

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

### Local Install

```bash
git clone https://github.com/wsauret/flywheel.git
cd flywheel
./install.sh
```

### Auto-Update

To receive updates automatically, enable auto-update for the marketplace:

```
/plugins
```

Then toggle auto-update on for `flywheel-marketplace`.

### Upgrading from local-marketplace

If you previously installed via the old local-marketplace pattern:

```bash
claude plugin marketplace remove local-marketplace
```

Then follow the standard install instructions.

## What Problems Does This Solve?

### Context windows fill up too fast

AI agents struggle with large codebases because context windows fill with search results, file contents, and tool outputs. Flywheel manages this through deliberate compaction at each phase:

- **Research** produces compact `.context.md` files, not sprawling chat
- **Plans** distill research into actionable checklists
- **Subagents** get fresh context for tasks, return compact results
- **Session files** enable recovery without re-reading everything

This keeps context utilization low, which is where models perform best.

### Knowledge walks out the door

When an agent solves a problem, the solution lives in chat history and disappears. Flywheel captures lessons so they persist:

- **`/fly:compound`** documents solutions while context is fresh
- **`docs/solutions/`** stores them as a searchable knowledge base with YAML frontmatter
- **Planning skills** surface relevant past solutions automatically

These learnings live in your codebase, so they're shared with your team.

### Human attention is spent on the wrong things

Reviewing code line-by-line catches individual mistakes. Reviewing research and plans catches structural problems before they become code:

| Review Target | Prevents |
|---------------|----------|
| Research | Thousands of bad lines |
| Plans | Hundreds of bad lines |
| Code | Individual mistakes |

Flywheel requires human approval at research and plan boundaries because that's where your attention has the most impact.

## Workflow

```
Brainstorm → Plan → Work → Review → Compound → Repeat
```

| Command | Purpose |
|---------|---------|
| `/fly:brainstorm` | Explore ideas conversationally before detailed planning |
| `/fly:research` | Codebase research using a locate→analyze pattern |
| `/fly:plan` | Create, enrich, review, and consolidate implementation plans |
| `/fly:work` | Execute plans with continuous testing and quality checks |
| `/fly:review` | Multi-agent code review with structured todo tracking |
| `/fly:compound` | Document solved problems for future reference |

Each cycle builds on the last: plans inform future plans, reviews catch more issues, patterns get documented.

## How It Works

### Planning in phases

`/fly:plan` orchestrates four phases, each writing to the same plan file:

1. **Create** — Draft a plan based on codebase patterns (creative/generative)
2. **Enrich** — Validate assumptions against docs and add research insights
3. **Review** — Critique from multiple reviewer agents (security, performance, architecture)
4. **Consolidate** — Surface open questions for user decision and then write out a plan ready for implementation

### Research with tiered agents

`/fly:research` uses a two-phase locate→analyze pattern:

- **Locators** (cheap, parallel, haiku) find WHERE things are — paths and file:line refs only
- **Analyzers** (expensive, targeted, sonnet) understand HOW things work — full file reads on the top findings

### Execution with recovery

`/fly:work` uses a probe-dispatch-checkpoint pattern. State files and session tracking mean you can clear context mid-work and resume with "carry on".

### Multi-agent review

`/fly:review` runs all available reviewer agents in parallel, deduplicates findings, detects conflicts between reviewers, and creates structured todo files.

## Components

| Type | Count | Examples |
|------|-------|---------|
| Reviewers | 9 | architecture, security, performance, code-quality, simplicity, patterns, data-integrity, git-history, agent-native |
| Research Locators | 4 | codebase, patterns, docs, web |
| Research Analyzers | 4 | codebase, patterns, docs, web |
| Commands | 6 | brainstorm, research, plan, work, review, compound |
| Skills | 11 | plan-creation, plan-enrich, plan-review, plan-consolidation, work-implementation, work-review, and more |

See `flywheel/README.md` for full agent, command, and skill reference tables.

## Inspiration

This project is heavily inspired by:

- **[Compound Engineering Plugin](https://github.com/EveryInc/compound-engineering-plugin)** by Every — The original implementation of compound engineering workflows for Claude Code.
- **[HumanLayer Claude Config](https://github.com/humanlayer/humanlayer/tree/main/.claude)** by HumanLayer — Patterns for human-in-the-loop AI development.

## License

[MIT](LICENSE)
