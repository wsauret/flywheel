# Compounding Engineering Plugin

AI-powered development tools that get smarter with every use. Make each unit of engineering work easier than the last.

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
| `brainstorming` | Conversational exploration of ideas before planning |
| `plan-creation` | Draft plans based on codebase patterns (creative); flags claims for verification |
| `plan-verification` | Validate assumptions are real, not hallucinated (fact-checking) |
| `plan-reviewing` | Critique from multiple reviewer perspectives (security, perf, arch) |
| `plan-consolidation` | Resolve open questions with user; create actionable checklists |
| `executing-work` | Execute plans following patterns, testing continuously |
| `reviewing` | Multi-agent code reviews with todo file creation |

### Utility Skills

| Skill | Description |
|-------|-------------|
| `compound-docs` | Capture solved problems as categorized documentation |
| `git-worktree` | Manage Git worktrees for parallel development |
