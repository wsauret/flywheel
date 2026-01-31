---
name: git-worktree
description: Manage Git worktrees for isolated parallel development. Handles creating, listing, switching, and cleanup.
---

# Git Worktree Manager

Unified interface for managing Git worktrees. Handles code reviews in isolation and parallel feature development.

## CRITICAL: Always Use the Manager Script

**NEVER call `git worktree add` directly.** Always use `worktree-manager.sh`.

The script handles:
1. Copies `.env` files from main repo
2. Ensures `.worktrees` is in `.gitignore`
3. Creates consistent directory structure

```bash
# ✅ CORRECT
bash ${CLAUDE_PLUGIN_ROOT}/skills/git-worktree/scripts/worktree-manager.sh create feature-name

# ❌ WRONG
git worktree add .worktrees/feature-name -b feature-name main
```

---

## When to Use

| Scenario | Action |
|----------|--------|
| Code review (`/fly:review`) | Offer worktree if not on PR branch |
| Feature work (`/fly:work`) | Ask: branch or worktree? |
| Parallel development | Create worktree per feature |
| After completing work | Cleanup worktree |

---

## Quick Reference

```bash
# Create worktree (copies .env files)
bash worktree-manager.sh create feature-login

# List all worktrees
bash worktree-manager.sh list

# Switch to worktree
bash worktree-manager.sh switch feature-login

# Copy .env files to existing worktree
bash worktree-manager.sh copy-env feature-login

# Clean up completed worktrees
bash worktree-manager.sh cleanup
```

See `references/commands.md` for full command details.

---

## Workflow: Code Review

```bash
# Not on PR branch? Create worktree
bash worktree-manager.sh create pr-123-feature
cd .worktrees/pr-123-feature

# After review
cd ../..
bash worktree-manager.sh cleanup
```

---

## Workflow: Parallel Features

```bash
# Start first feature
bash worktree-manager.sh create feature-login

# Start second feature (from main repo)
bash worktree-manager.sh create feature-notifications

# List what you have
bash worktree-manager.sh list

# Switch between
bash worktree-manager.sh switch feature-login
```

---

## Integration with /fly Commands

### `/fly:review`

1. Check current branch
2. If ALREADY on PR branch → no worktree
3. If DIFFERENT branch → offer worktree

### `/fly:work`

1. Ask: "New branch or worktree?"
2. Branch → create normally
3. Worktree → call this skill

---

## Key Principles

- **KISS** - One script handles everything
- **Opinionated defaults** - Worktrees from main, in `.worktrees/`
- **Safety first** - Confirms before create/cleanup
- **.env handling** - Automatically copies env files

---

## Troubleshooting

See `references/troubleshooting.md` for common issues:
- "Worktree already exists"
- "Cannot remove current worktree"
- Missing .env files
- Dependencies not working

---

## Detailed References

- `references/commands.md` - Full command reference, directory structure
- `references/troubleshooting.md` - Common issues and solutions
