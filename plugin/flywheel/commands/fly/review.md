---
name: fly:review
description: Review a plan or executed work. Routes to plan-review or work-review based on session state and arguments.
argument-hint: "[PR number, GitHub URL, branch name, session slug, or empty for current active session]"
---

# Code / Plan Review

**MANDATORY FIRST ACTION — You MUST route to the correct skill BEFORE doing anything else. Do NOT read files, search code, or respond to the user first.**

`/fly:review` is a dispatcher — it has no skill of its own. It routes to either `plan-review` (when the target is a spec that hasn't been executed yet) or `work-review` (when the target is executed code). The routing helper is authored in `flywheel/skills/work-implementation/references/session-detection.md` under "**/fly:review Routing Heuristic (D9)**" and validated by `tests/work/routing.test.sh`.

<review_target> #$ARGUMENTS </review_target>

## Routing Decision

Follow the routing heuristic in order. The first match wins.

| Input | Dispatch |
|---|---|
| `$ARGUMENTS` matches `^#?[0-9]+$` (PR number, with or without `#`) | `work-review` (PR target) |
| `$ARGUMENTS` is a branch-name shape (contains `/`, or alpha-leading identifier) | `work-review` (branch target) |
| `$ARGUMENTS` is a slug (matches `^[a-z0-9-]+$`) that resolves to a session | resolve session, then re-apply the heuristic with empty args against the resolved session |
| `$ARGUMENTS` empty AND the active session has `progress.json` | `work-review` (work is in progress or complete) |
| `$ARGUMENTS` empty AND the active session has `spec.json` but no `progress.json` | `plan-review` (spec not yet executed) |
| `$ARGUMENTS` empty AND no active session | error: `"No active session and no PR/branch argument. Run /fly:plan first."` |
| `$ARGUMENTS` empty AND active session has neither `spec.json` nor `progress.json` | error: `"No spec to review. Run /fly:plan first."` |

**Active session resolution**: read `.flywheel/plugin/active.json` if it exists; the `session_id` points at `.flywheel/plugin/sessions/<session_id>/`. If `active.json` is missing or its session dir does not exist, treat as no active session.

**Slug arg resolution**: use the Phase 0 slug prefix-scan (see `session-detection.md`) — collect all dirs under `.flywheel/plugin/sessions/` whose name starts with `<slug>-`, take the lexically-greatest (most recent ISO-date), update `active.json` to that session, then apply the empty-args routing logic.

## Invoking the Chosen Skill

Once the routing decision is made, invoke the skill using the Skill tool. Pass `$ARGUMENTS` through verbatim so the skill can re-resolve the target (PR/branch/session).

For `work-review`:

```
skill: work-review
```

For `plan-review`:

```
skill: plan-review
```

## Intuition

- **`progress.json` present** = work started; review targets the executed work → `work-review`
- **`spec.json` only** = plan not executed; review targets the plan → `plan-review`
- **PR or branch arg** = user explicitly scoped the review to code; bypass session inference → `work-review`

## What Each Skill Handles

`work-review`:
- Target detection (PR, URL, branch, current)
- Environment setup (worktree option)
- Parallel reviewer agents (security, performance, architecture, etc.)
- Finding synthesis and severity assignment
- Persists `review.findings.json` to the active session
- Summary report with a prompt to fix findings via `/fly:work <session_dir>/review.findings.json`

`plan-review`:
- Loads the active session's `spec.json`
- Dispatches all reviewer agents in parallel against the plan
- Deduplicates semantically
- Writes `review.findings.json` to the active session
- Summary with a prompt to continue into `plan-consolidation`

See `flywheel/skills/work-review/SKILL.md` and `flywheel/skills/plan-review/SKILL.md` for full procedural details. See `flywheel/skills/work-implementation/references/session-detection.md` for the canonical routing heuristic and its pseudocode.
