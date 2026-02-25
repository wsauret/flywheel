# Flywheel

A plugin for Claude Code and OpenCode that turns development cycles into momentum.

## Install

### Claude Code

**Marketplace (recommended):**

```
/plugin marketplace add wsauret/flywheel
/plugin install flywheel@flywheel-marketplace
```

**Local:**

```bash
git clone https://github.com/wsauret/flywheel.git
cd flywheel
./install_claude_code.sh
```

### OpenCode

```bash
git clone https://github.com/wsauret/flywheel.git
cd flywheel
python3 install_opencode.py
```

This transforms the plugin into OpenCode's config format and writes to `~/.config/opencode/`. Re-run the script to update.

### Optional: Context7 Setup

Context7 provides up-to-date framework documentation for the planning workflow.
Both installers will prompt you to configure Context7 automatically.

To get an API key, sign up at https://context7.com/dashboard. If you skip during
install, you can configure it manually later:

**Claude Code:**

```bash
claude mcp add --header "CONTEXT7_API_KEY: your-key-here" \
  --transport http context7 https://mcp.context7.com/mcp
```

**OpenCode** — add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}"
      }
    }
  }
}
```

### Staying Up To Date

**Claude Code:** Run `/plugins` and toggle auto-update on for `flywheel-marketplace`.

**OpenCode:** Re-run `python3 install_opencode.py` to pick up changes.

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

- **`/fly:compound`** (Claude Code) or **`/fly/compound`** (OpenCode) documents solutions while context is fresh
- **`/fly:ship`** automatically compounds learnings when opening a PR, so knowledge capture is built into the shipping flow
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
Plan → Work → Ship → Repeat
```

Brainstorm and research are optional entry points. Review can be added before shipping. Ship automatically compounds learnings.

| Command (Claude Code) | Command (OpenCode) | Purpose |
|-----------------------|-------------------|---------|
| `/fly:brainstorm` | `/fly/brainstorm` | Explore ideas conversationally before detailed planning |
| `/fly:research` | `/fly/research` | Codebase research using a locate→analyze pattern |
| `/fly:plan` | `/fly/plan` | Create, enrich, review, and consolidate implementation plans |
| `/fly:work` | `/fly/work` | Execute plans with continuous testing and quality checks |
| `/fly:review` | `/fly/review` | Multi-agent code review with structured todo tracking |
| `/fly:compound` | `/fly/compound` | Document solved problems for future reference |
| `/fly:debug` | `/fly/debug` | Iterative debug loop with fix-verify cycles |
| `/fly:ship` | `/fly/ship` | Create branch, commit, push, open a PR, and compound learnings |

Each cycle builds on the last: plans inform future plans, reviews catch more issues, patterns get documented.

## How It Works

### Planning in phases

`/fly:plan` orchestrates three skills in sequence, each writing to the same plan file:

1. **Create** — Research the codebase (locate→analyze pattern), validate high-risk claims against external docs (Context7), and draft the plan
2. **Review** — Run all reviewer agents in parallel (architecture, performance, data integrity, etc.), deduplicate findings, and convert conflicts to open questions
3. **Consolidate** — Resolve open questions with the user one at a time, then restructure everything into an actionable checklist ready for `/fly:work`

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
| Reviewers | 6 | architecture, code-quality, performance, patterns, data-integrity, plan-philosophy |
| Research Locators | 4 | codebase, patterns, docs, web |
| Research Analyzers | 5 | codebase, patterns, docs, web, git-history |
| Commands | 8 | brainstorm, research, plan, work, review, compound, debug, ship |
| Skills | 13 | plan-creation, plan-review, plan-consolidation, work-implementation, work-review, and more |

See `flywheel/README.md` for full agent, command, and skill reference tables.

## Inspiration

This project is heavily inspired by:

- **[Compound Engineering Plugin](https://github.com/EveryInc/compound-engineering-plugin)** by Every — The original implementation of compound engineering workflows for Claude Code.
- **[HumanLayer Claude Config](https://github.com/humanlayer/humanlayer/tree/main/.claude)** by HumanLayer — Patterns for human-in-the-loop AI development.

## License

[MIT](LICENSE)
