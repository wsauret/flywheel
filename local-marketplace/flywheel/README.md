# Compounding Engineering Plugin

AI-powered development tools that get smarter with every use. Make each unit of engineering work easier than the last.

## Philosophy

Flywheel implements two complementary strategies for AI-assisted development:

### Context Compaction (During Work)

AI coding agents struggle with large codebases because context windows fill up with search results, file contents, and tool outputs. Flywheel manages this through:

- **Research → Plan → Implement workflow** - Each phase produces compact artifacts, not sprawling chat
- **`.context.md` files** - Persist research findings across sessions
- **`.state.md` files** - Enable recovery if context is lost mid-work
- **`.flywheel/session.md`** - Tracks active work for "carry on" resume
- **Subagent dispatch** - Fresh context for research tasks, compact results returned

This keeps context utilization under 40% for optimal performance.

**Session Recovery:** If you need to clear context mid-work (`/clear`), just say "carry on" or run `/fly:work` with no arguments. The session file remembers where you left off.

### Knowledge Compounding (After Work)

Each solved problem should make future problems easier. Flywheel captures lessons via:

- **`/fly:compound`** - Document solutions while context is fresh
- **`docs/solutions/`** - Searchable knowledge base of past solutions
- **Automatic discovery** - Planning skills surface relevant past solutions

Like compound interest, each captured lesson accumulates value over time.

### Human Leverage

Focus review effort where it matters most:

| Review Target | Prevents |
|---------------|----------|
| Research | Thousands of bad lines |
| Plans | Hundreds of bad lines |
| Code | Individual mistakes |

This is why Flywheel requires human approval at research and plan boundaries.

## Installation

### Claude Code (Recommended)

Use the install script from the repository root:

```bash
./install.sh
```

The install script will:
1. Add the local marketplace to Claude Code
2. Install the Flywheel plugin
3. Optionally configure Context7 with your API key (get one free at https://context7.com/dashboard)

### OpenCode

Use the `generate_opencode.py` script to transform and copy files to OpenCode paths:

```bash
# Preview what will be transformed
python generate_opencode.py --dry-run

# Install to ~/.config/opencode/
python generate_opencode.py
```

The script transforms Claude Code plugin format to OpenCode format, handling frontmatter differences and path structures.

## Components

| Component | Count |
|-----------|-------|
| Agents | 16 |
| Commands | 6 |
| Skills | 11 |

## Agents

Agents are organized into categories for easier discovery.

### Reviewers (8)

| Agent | Description |
|-------|-------------|
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
| `plan-verification` | Validate assumptions are real, not hallucinated (fact-checking) |
| `plan-review` | Critique from multiple reviewer perspectives (security, perf, arch) |
| `plan-consolidation` | Resolve open questions with user; create actionable checklists |
| `work-implementation` | Execute plans following patterns, testing continuously |
| `work-review` | Multi-agent code reviews with todo file creation |

### Utility Skills

| Skill | Description |
|-------|-------------|
| `compound-docs` | Capture solved problems as categorized documentation |
| `git-worktree` | Manage Git worktrees for parallel development |

## Research Pattern

Flywheel uses a two-phase locate→analyze pattern for research:

1. **Locators (cheap, parallel)**: Find WHERE things are using haiku model
   - No Read tool - paths and file:line references only
   - Run all locators in parallel

2. **Analyzers (expensive, targeted)**: Understand HOW things work using sonnet model
   - Only analyze top 15 findings from locators
   - Documentarian mode: document what IS, not what SHOULD BE
   - Full file reads (no partial reads)

This reduces context usage by 40-60% compared to all-in-one research agents.
