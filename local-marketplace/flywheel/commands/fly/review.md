---
name: fly:review
description: Perform exhaustive code reviews using multi-agent analysis. Creates todo files for findings. Reviews PRs, branches, or current changes.
argument-hint: "[PR number, GitHub URL, branch name, or empty for current branch]"
---

# Code Review

<review_target> #$ARGUMENTS </review_target>

**Invoke the reviewing skill:**

```
skill: reviewing
```

The reviewing skill handles:
- Review target detection (PR, URL, branch, current)
- Environment setup (worktree option)
- Parallel reviewer agents (security, performance, architecture, etc.)
- Finding synthesis and severity assignment
- Todo file creation using file-todos skill
- Summary report with next steps

See `plugin/skills/reviewing/SKILL.md` for full procedural details.
