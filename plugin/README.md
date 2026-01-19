# Compounding Engineering Plugin

AI-powered development tools that get smarter with every use. Make each unit of engineering work easier than the last.

## Components

| Component | Count |
|-----------|-------|
| Agents | 16 |
| Commands | 9 |
| Skills | 3 |

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

Core workflow commands use `workflows:` prefix to avoid collisions with built-in commands:

| Command | Description |
|---------|-------------|
| `/workflows:brainstorm` | Conversational exploration of ideas before planning. One question at a time, explores approaches, validates design incrementally. |
| `/workflows:plan` | Create implementation plans. Works best after brainstorm or accepts design docs as input. |
| `/workflows:review_plan` | Deepen and review a plan in a single orchestrated workflow |
| `/workflows:work` | Execute work items systematically |
| `/workflows:review_work` | Run comprehensive code reviews on PRs |
| `/workflows:compound` | Document solved problems to compound team knowledge |

**Recommended Workflow:**
```
/workflows:brainstorm → /workflows:plan → /workflows:review_plan → /workflows:work → /workflows:review_work
```

### Utility Commands

| Command | Description |
|---------|-------------|
| `/resolve-pr-comments` | Resolve PR review comments in parallel |
| `/resolve-file-todos` | Resolve items in `/todos/` directory in parallel |
| `/triage` | Triage and prioritize issues |

## Skills

| Skill | Description |
|-------|-------------|
| `compound-docs` | Capture solved problems as categorized documentation |
| `file-todos` | File-based todo tracking system |
| `git-worktree` | Manage Git worktrees for parallel development |
