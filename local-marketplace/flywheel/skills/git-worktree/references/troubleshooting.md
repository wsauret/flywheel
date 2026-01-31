# Worktree Troubleshooting

Common issues and solutions.

## "Worktree already exists"

**Solution:** Script will ask if you want to switch to it instead.

---

## "Cannot remove worktree: it is the current worktree"

**Solution:** Switch out first, then cleanup:

```bash
cd $(git rev-parse --show-toplevel)
bash worktree-manager.sh cleanup
```

---

## Lost in a worktree?

**See where you are:**

```bash
bash worktree-manager.sh list
```

**Navigate back to main:**

```bash
cd $(git rev-parse --show-toplevel)
```

---

## .env files missing in worktree?

If worktree was created via raw `git worktree add`:

```bash
bash worktree-manager.sh copy-env feature-name
```

---

## Dependencies not working in worktree

Each worktree needs its own dependency installation:

```bash
cd .worktrees/feature-name
npm install  # or pip install, bundle install, etc.
```

---

## Git prevents checking out same branch

Git worktrees require unique branches. You cannot checkout the same branch in two worktrees.

**Solution:** Create a new branch name for each worktree.

---

## Claude Code not oriented in worktree

Run `/init` in each new worktree to orient Claude Code.
