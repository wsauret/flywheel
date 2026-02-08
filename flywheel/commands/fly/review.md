---
name: fly:review
description: Perform exhaustive code reviews using multi-agent analysis. Creates todo files for findings. Reviews PRs, branches, or current changes.
argument-hint: "[PR number, GitHub URL, branch name, or empty for current branch]"
---

# Code Review

**MANDATORY FIRST ACTION — You MUST use the Skill tool to invoke the skill below BEFORE doing anything else. Do NOT read files, search code, or respond to the user first.**

**Invoke the work-review skill:**

```
skill: work-review
```

<review_target> #$ARGUMENTS </review_target>

The work-review skill handles:
- Review target detection (PR, URL, branch, current)
- Environment setup (worktree option)
- Parallel reviewer agents (security, performance, architecture, etc.)
- Finding synthesis and severity assignment
- Finding tracking using built-in tasks
- Summary report with next steps

See `plugin/skills/work-review/SKILL.md` for full procedural details.
