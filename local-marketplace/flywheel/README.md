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
| Agents | 16 |
| Commands | 8 |
| Skills | 8 |

## Agents

Agents are organized into categories for easier discovery.

### Review (9)

| Agent | Description |
|-------|-------------|
| `agent-native-reviewer` | Verify features are agent-native (action + context parity) |
| `architecture-strategist` | Analyze architectural decisions and compliance |
| `code-simplicity-reviewer` | Final pass for simplicity and minimalism |
| `data-integrity-guardian` | Database migrations and data integrity |
| `pattern-recognition-specialist` | Analyze code for patterns and anti-patterns |
| `performance-oracle` | Performance analysis and optimization |
| `python-reviewer` | Python code review with strict conventions |
| `security-sentinel` | Security audits and vulnerability assessments |
| `typescript-reviewer` | TypeScript code review with strict conventions |

### Research (4)

| Agent | Description |
|-------|-------------|
| `best-practices-researcher` | Gather external best practices and examples |
| `framework-docs-researcher` | Research framework documentation and best practices |
| `git-history-analyzer` | Analyze git history and code evolution |
| `repo-research-analyst` | Research repository structure and conventions |

### Workflow (3)

| Agent | Description |
|-------|-------------|
| `lint` | Run linting and code quality checks |
| `pr-comment-resolver` | Address PR comments and implement fixes |
| `spec-flow-analyzer` | Analyze user flows and identify gaps in specifications |

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

### Utility Commands

| Command | Description |
|---------|-------------|
| `/resolve-pr-comments` | Resolve PR review comments in parallel |
| `/resolve-file-todos` | Resolve items in `/todos/` directory in parallel |
| `/triage` | Triage and prioritize issues |

## Skills

### Workflow Skills

| Skill | Description |
|-------|-------------|
| `brainstorming` | Conversational exploration of ideas before planning |
| `planning` | Create implementation plans with research persistence |
| `executing-work` | Execute plans following patterns, testing continuously |
| `reviewing` | Multi-agent code reviews with todo file creation |
| `compounding` | Coordinate parallel subagents to document solutions |

### Utility Skills

| Skill | Description |
|-------|-------------|
| `compound-docs` | Capture solved problems as categorized documentation |
| `file-todos` | File-based todo tracking system |
| `git-worktree` | Manage Git worktrees for parallel development |
