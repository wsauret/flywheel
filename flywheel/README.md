# Flywheel Plugin

A Claude Code plugin that turns development cycles into momentum.

## What Problems Does This Solve?

### Context windows fill up too fast

AI agents struggle with large codebases because context windows fill with search results, file contents, and tool outputs. Flywheel manages this through deliberate compaction at each phase:

- **Research → Plan → Implement workflow** - Each phase produces compact artifacts, not sprawling chat
- **`.context.md` files** - Persist research findings across sessions
- **`.state.md` files** - Enable recovery if context is lost mid-work
- **Subagent dispatch** - Fresh context for research tasks, compact results returned

This keeps context utilization in the 40-60% range where models perform best.

**Session Recovery:** If you need to clear context mid-work (`/clear`), just run `/fly:work` with no arguments. The session file remembers where you left off.

### Knowledge walks out the door

When an agent solves a problem, the solution lives in chat history and disappears. Flywheel captures lessons so they persist:

- **`/fly:compound`** - Document solutions while context is fresh
- **`docs/solutions/`** - Searchable knowledge base with YAML frontmatter
- **Automatic discovery** - Planning skills surface relevant past solutions

These learnings live in your codebase, so they're automatically shared with your team.

### Human attention is spent on the wrong things

Reviewing code line-by-line catches individual mistakes. Reviewing research and plans catches structural problems before they become code:

| Review Target | Prevents |
|---------------|----------|
| Research | Thousands of bad lines |
| Plans | Hundreds of bad lines |
| Code | Individual mistakes |

Flywheel requires human approval at research and plan boundaries because that's where your attention has the most impact.

## Installation

In Claude Code, run:

```
/plugin marketplace add wsauret/flywheel
/plugin install flywheel@flywheel-marketplace
```

For local development or OpenCode, see the [repository README](https://github.com/wsauret/flywheel).

## Components

| Component | Count |
|-----------|-------|
| Agents | 17 |
| Commands | 6 |
| Skills | 12 |
| Hooks | 3 |

## Agents

Agents are organized into categories for easier discovery.

### Reviewers (9)

| Agent | Description |
|-------|-------------|
| `agent-native-reviewer` | Agent parity and tool accessibility review |
| `architecture-reviewer` | Analyze architectural decisions and compliance |
| `code-quality-reviewer` | Python/TypeScript review with high quality bar |
| `code-simplicity-reviewer` | Final pass for simplicity and minimalism |
| `data-integrity-reviewer` | Database migrations and data integrity |
| `git-history-reviewer` | Analyze git history and code evolution |
| `pattern-reviewer` | Analyze code for patterns and anti-patterns |
| `performance-reviewer` | Performance analysis and optimization |
| `security-reviewer` | Security audits and vulnerability assessments |

### Research Locators (4) - Cheap, Parallel

Find WHERE things are without reading full contents. Use haiku model.

| Agent | Tools | Description |
|-------|-------|-------------|
| `codebase-locator` | Grep, Glob | Find WHERE files and components live |
| `pattern-locator` | Grep, Glob | Find WHERE patterns exist (file:line refs) |
| `docs-locator` | Grep, Glob | Find WHERE documentation lives |
| `web-searcher` | WebSearch | Find relevant URLs (no fetching) |

### Research Analyzers (4) - Expensive, Targeted

Understand HOW things work by reading files. Use sonnet model. Documentarian mode - no suggestions.

| Agent | Tools | Description |
|-------|-------|-------------|
| `codebase-analyzer` | Read, Grep, Glob | Understand HOW code works |
| `pattern-analyzer` | Read, Grep, Glob | Extract code examples with context |
| `docs-analyzer` | Read, Grep, Glob | Extract insights from documentation |
| `web-analyzer` | WebFetch, Read | Fetch and analyze web content deeply |

## Commands

### Workflow Commands

Core workflow commands use `fly:` prefix:

| Command | Description |
|---------|-------------|
| `/fly:brainstorm` | Conversational exploration of ideas. One question at a time, explores 2-3 approaches, validates design incrementally. |
| `/fly:research` | Comprehensive codebase research using locate→analyze pattern. Creates persistent research documents. |
| `/fly:plan` | Create or refine implementation plans with research persistence. Handles design docs, feature descriptions, or existing plans. |
| `/fly:work` | Execute work plans efficiently. Loads context files, follows patterns, tests continuously. |
| `/fly:review` | Perform exhaustive code reviews using multi-agent analysis. Creates todo files for findings. |
| `/fly:compound` | Document solved problems using parallel subagents. Captures solutions while context is fresh. |

**Recommended Workflow:**
```
/fly:brainstorm → /fly:research (optional) → /fly:plan → /fly:work → /fly:review → /fly:compound
```

## Skills

### Workflow Skills

| Skill | Description |
|-------|-------------|
| `brainstorm` | Conversational exploration of ideas before planning |
| `codebase-research` | Comprehensive research using locate→analyze pattern |
| `plan-creation` | Draft plans based on codebase patterns (creative); flags claims for verification |
| `plan-enrich` | Single-pass verification AND enrichment - validate assumptions, add research insights |
| `plan-review` | Critique from multiple reviewer perspectives (security, perf, arch) |
| `plan-consolidation` | Resolve open questions with user; create actionable checklists |
| `work-implementation` | Execute plans following patterns, testing continuously |
| `work-review` | Multi-agent code reviews with todo file creation |

### Utility Skills

| Skill | Description |
|-------|-------------|
| `compound-docs` | Capture solved problems as categorized documentation |
| `git-worktree` | Manage Git worktrees for parallel development |

## Hooks

| Hook | Event | Description |
|------|-------|-------------|
| `session-start.sh` | SessionStart | Auto-installs subtask CLI; reminds to load skill on compact/resume |
| `skill-reminder.sh` | UserPromptSubmit | Detects "subtask" in prompts, suggests loading skill |
| `skill-required.sh` | PostToolUse (Bash) | Detects direct `subtask` CLI usage, suggests loading skill |

## Research Pattern

Flywheel uses a two-phase locate→analyze pattern for research:

1. **Locators (cheap, parallel)**: Find WHERE things are using haiku model
   - No Read tool - paths and file:line references only
   - Run all locators in parallel

2. **Analyzers (expensive, targeted)**: Understand HOW things work using sonnet model
   - Only analyze top 15 findings from locators
   - Documentarian mode: document what IS, not what SHOULD BE
   - Full file reads (no partial reads)

This reduces context usage significantly compared to all-in-one research agents.

## Subtask Integration

Flywheel uses [subtask](https://subtask.dev) for durable work dispatch. The subtask CLI is auto-installed via session hooks and the install script.

**When subtask is used:**
- **Work phases** (`/fly:work`): Each plan phase runs in an isolated git worktree via `subtask send`. Changes are merged back after review.
- **Code reviews** (`/fly:review`): All reviewer agents run as parallel subtask workers. Results are collected and synthesized.
- **Plan reviews** (`/fly:plan`): Same parallel pattern as code reviews.

**When Task tool is used instead:**
- Research agents (locators, analyzers) still use the Task tool for ephemeral, cheap operations
- Quick explorations that return small results and don't modify files

See the dispatch mechanism selection section in `flywheel-conventions` for full guidance.
