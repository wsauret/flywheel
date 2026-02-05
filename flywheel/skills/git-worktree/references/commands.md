# Worktree Commands Reference

All commands use the `worktree-manager.sh` script.

## Script Location

```bash
${CLAUDE_PLUGIN_ROOT}/skills/git-worktree/scripts/worktree-manager.sh
```

Or use the local path:
```bash
.claude/flywheel/skills/git-worktree/scripts/worktree-manager.sh
```

---

## Commands

### `create <branch-name> [from-branch]`

Creates a new worktree with the given branch name.

**Arguments:**
- `branch-name` (required): Name for the new branch and worktree
- `from-branch` (optional): Base branch (defaults to `main`)

**Example:**
```bash
bash worktree-manager.sh create feature-login
bash worktree-manager.sh create hotfix-123 main
```

**What happens:**
1. Checks if worktree already exists
2. Updates base branch from remote
3. Creates new worktree and branch
4. Copies all .env files from main repo
5. Shows path for cd-ing to worktree

---

### `list` or `ls`

Lists all available worktrees with status.

**Example:**
```bash
bash worktree-manager.sh list
```

**Output shows:**
- Worktree name
- Branch name
- Current worktree (marked ✓)
- Main repo status

---

### `switch <name>` or `go <name>`

Switches to an existing worktree.

**Example:**
```bash
bash worktree-manager.sh switch feature-login
```

If name not provided, lists available worktrees and prompts.

---

### `copy-env <name>`

Copies .env files to an existing worktree.

**Example:**
```bash
bash worktree-manager.sh copy-env feature-login
```

Use if worktree was created without .env files.

---

### `cleanup` or `clean`

Interactively cleans up inactive worktrees.

**Example:**
```bash
bash worktree-manager.sh cleanup
```

**What happens:**
1. Lists all inactive worktrees
2. Asks for confirmation
3. Removes selected worktrees
4. Cleans up empty directories

---

## Directory Structure

```
.worktrees/
├── feature-login/          # Worktree 1
│   ├── .git
│   ├── app/
│   └── ...
├── feature-notifications/  # Worktree 2
│   └── ...
└── ...

.gitignore (updated to include .worktrees)
```

---

## Technical Details

- Uses `git worktree add` internally
- Each worktree has its own branch
- Changes in one worktree don't affect others
- Shared git history with main repo
- Lightweight (file system links, not clones)
