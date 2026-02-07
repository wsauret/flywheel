---
name: work-implementation
description: Execute work plans using probe-dispatch-checkpoint pattern. Orchestrator stays lean, dispatches subagents per phase. Triggers on "work on", "implement", "execute plan", "carry on", "continue".
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
  - Task
  - TaskCreate
  - TaskUpdate
  - TaskList
  - AskUserQuestion
---

# Executing-Work Skill

Execute plans using **probe-dispatch-checkpoint** pattern. Orchestrator stays lean, dispatches subagents per phase, persists state for recovery.

**Context Compaction:** This skill manages context via `.state.md` files (progress checkpoints) and `.context.md` files (research findings). If context is lost mid-work, these files enable seamless recovery.

## Input

Plan path via `$ARGUMENTS`. Can be a plan, specification, or todo file.

**If no arguments provided:** Check for active session (see Phase 0).

---

## Phase 0: Session Detection

**Run this phase FIRST, before anything else.**

Read `references/session-detection.md` before proceeding -- contains validation logic, presentation templates, and edge case handling for session resume.

1. Check for `.flywheel/session.md`
2. **Session exists, no args:** Validate state (files exist, no unexpected changes, context freshness), present summary, ask user to resume/show details/start fresh
3. **Session exists, args provided:** Compare plan paths -- same plan resumes, different plan asks user
4. **No session:** Require plan path from arguments or ask user

---

## Phase 1: Load & Resume

Read `references/load-resume-procedures.md` before proceeding -- contains state file checks, baseline creation, session file template, format validation checklists, task creation examples, and worktree assessment.

1. **Check/create state file** from plan path (`${PLAN_PATH%.md}.state.md`). Resume from first unchecked phase if exists; otherwise create per `references/state-file-template.md`
2. **Create baseline plan snapshot** for compliance checking (`${PLAN_PATH%.md}.baseline.md`)
3. **Create/update session file** in `.flywheel/session.md` per `references/session-file-template.md`
4. **Load context** from `[plan_path].context.md` (file references, gotchas, naming conventions)
5. **Load applicable standards** from `docs/standards/` — search by plan tags/topics, include in dispatch context for subagents
6. **Validate format** of plan, state, and context files; log warnings in state file
7. **Create native Tasks** (one per phase) for progress tracking -- dual-write with state file for redundancy
8. **Assess worktree need** (recommend if >10 files, >3 phases, or critical paths)

---

## Phase 2: Execute (Per-Phase Loop)

For each unchecked phase:

### 2.1 Probe Phase Files

Quick check of referenced files. If >500 lines: warn, consider splitting. Note missing files.

### 2.2 Dispatch Subagent

```
Task general-purpose: "
## Task
Execute Phase N: <description>

## Plan Excerpt
<paste full phase content>

## Context
- Key decisions: <from state file>
- Files to reference: <from context file>
- Patterns to follow: <from context file>
- Applicable standards: <from docs/standards/ if any match>

## Constraints
- Follow existing patterns exactly
- Run tests after changes
- Report: files modified, decisions made, blockers
"
```

Provide plan text directly (don't make subagent read file). One phase at a time. Include decisions from previous phases.

### 2.2a TDD Cycle

Read `references/tdd-cycle.md` before proceeding -- contains RED/GREEN/REFACTOR steps and skip conditions.

Apply RED-GREEN-REFACTOR per implementation task. Skip TDD for pure refactoring, config-only, or docs changes.

### 2.3 Checkpoint (Dual-Write)

Read `references/checkpoint-procedure.md` before proceeding -- contains dual-write steps, manual verification pause flow, and skip conditions.

1. **Update native Task** to completed (primary)
2. **Update state file** with phase completion, decisions, learnings, code context (backup)
3. **Verify TDD evidence** and run tests
4. **Update session file** (timestamp, phase number, status)
5. **Manual verification pause** if plan has Manual Verification criteria (ask user to confirm)

### 2.4 Ralph Mode Check

Check if Ralph mode should activate (>5 phases, `--ralph` flag, or context >50% with >2 phases remaining). If active, write detailed state and suggest context clear. Read `references/ralph-mode.md` before proceeding -- contains trigger conditions, checkpoint format, and state file completeness requirements.

### 2.5 Loop

Continue to next unchecked phase. All complete -> Phase 3.

---

## Phase 3: Quality Check

Follow `references/verification-gates.md`: IDENTIFY proving command, RUN it fresh, READ full output, VERIFY it confirms claim, ONLY THEN make claim with evidence.

**Two-Stage Review:**
1. **Stage 1: Spec Compliance** - Built what was requested? (Fix gaps before Stage 2)
2. **Stage 2: Code Quality** - Code clean and tested?

---

## Phase 4: Ship It

1. **Commit & PR:** `git add`, `git commit`, `git push`, `gh pr create`
2. **Update state:** Mark `status: completed`
3. **Clear session and baseline:** `rm .flywheel/session.md` and baseline file
4. **Worktree cleanup:** If in worktree, offer to remove and switch to main

---

## Recovery & Error Handling

Read `references/recovery-and-errors.md` before proceeding -- contains dual-write recovery flow, task persistence details, 3-Strike error protocol, and specific error case handling.

**Recovery:** "carry on" or `/fly:work` with no args -> session file identifies plan -> check Tasks + state file -> resume from first uncompleted phase.

**Errors:** 3-Strike protocol (diagnose, alternative approach, broader rethink, then escalate). Subagent failures: retry/skip/abort. Test failures: fix before checkpoint.

---

## Key Principles

- **Checkpoint after each phase** - enables recovery
- **State file is source of truth** - not conversation memory
- **Sequential execution** - one phase at a time
- **Provide context to subagents** - they start fresh
- **Ship complete features** - finish what you start
- **Ralph mode for long tasks** - context clear is a feature, not a bug

## Anti-Patterns

- **Skip checkpoints** - lose recovery capability
- **Parallel implementation** - causes file conflicts
- **Make subagent read plan** - provide text directly
- **Ignore test failures** - fix before checkpoint

---

## Detailed References

- `references/session-detection.md` - Phase 0 validation logic, presentation templates, edge cases
- `references/load-resume-procedures.md` - Phase 1 state checks, format validation, task creation, worktree assessment
- `references/tdd-cycle.md` - RED/GREEN/REFACTOR steps and skip conditions
- `references/checkpoint-procedure.md` - Dual-write checkpoint steps, manual verification pause
- `references/ralph-mode.md` - Stateless agent loop triggers, checkpoint format, state completeness
- `references/recovery-and-errors.md` - Recovery flow, 3-Strike protocol, specific error cases
- `references/state-file-template.md` - State file structure and recovery process
- `references/session-file-template.md` - Session file for "carry on" resume
- `references/verification-gates.md` - Verification protocol, two-stage review
