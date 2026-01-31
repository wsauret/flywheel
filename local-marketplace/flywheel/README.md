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

### Claude Code

```bash
# Create plugins directory if it doesn't exist
mkdir -p ~/.claude/plugins

# Symlink the plugin
ln -s $(pwd)/plugin ~/.claude/plugins/flywheel
```

### OpenCode

OpenCode natively reads from Claude Code paths. Use the same installation:

```bash
ln -s $(pwd)/plugin ~/.claude/plugins/flywheel
```

Or copy directly to OpenCode paths:

```bash
cp -r plugin/skills/* ~/.config/opencode/skills/
cp -r plugin/commands/* ~/.config/opencode/commands/
cp -r plugin/agents/* ~/.config/opencode/agents/
```

## Components

| Component | Count |
|-----------|-------|
| Agents | 10 |
| Commands | 5 |
| Skills | 9 |

## Agents

Agents are organized into categories for easier discovery.

### Reviewers (7)

| Agent | Description |
|-------|-------------|
| `architecture-reviewer` | Analyze architectural decisions and compliance |
| `code-quality-reviewer` | Python/TypeScript review with high quality bar |
| `code-simplicity-reviewer` | Final pass for simplicity and minimalism |
| `data-integrity-reviewer` | Database migrations and data integrity |
| `pattern-reviewer` | Analyze code for patterns and anti-patterns |
| `performance-reviewer` | Performance analysis and optimization |
| `security-reviewer` | Security audits and vulnerability assessments |

### Researchers (3)

| Agent | Description |
|-------|-------------|
| `git-history-researcher` | Analyze git history and code evolution |
| `repo-researcher` | Research repository structure and conventions |
| `web-researcher` | External research: best practices, docs, community patterns |

## Commands

### Workflow Commands

Core workflow commands use `fly:` prefix:

| Command | Description |
|---------|-------------|
| `/fly:brainstorm` | Conversational exploration of ideas. One question at a time, explores 2-3 approaches, validates design incrementally. |
| `/fly:plan` | Create or refine implementation plans with research persistence. Handles design docs, feature descriptions, or existing plans. |
| `/fly:work` | Execute work plans efficiently. Loads context files, follows patterns, tests continuously. |
| `/fly:review` | Perform exhaustive code reviews using multi-agent analysis. Creates todo files for findings. |
| `/fly:compound` | Document solved problems using parallel subagents. Captures solutions while context is fresh. |

**Recommended Workflow:**
```
/fly:brainstorm → /fly:plan → /fly:work → /fly:review → /fly:compound
```

## Skills

### Workflow Skills

| Skill | Description |
|-------|-------------|
| `brainstorm` | Conversational exploration of ideas before planning |
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
