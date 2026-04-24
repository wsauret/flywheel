---
name: work-implementation
description: Execute work plans using probe-dispatch-checkpoint pattern. Orchestrator stays lean, dispatches subagents per phase. Triggers on "work on", "implement", "execute plan", "carry on", "continue". Do not use for exploration or design decisions — work-implementation executes against an existing spec.json. For design work, use brainstorm or plan-creation.
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
  - Skill
  - AskUserQuestion
---

# Executing-Work Skill

Execute the active session's TaskList (`spec.json` for plan mode, `findings.json` for fix-findings mode) using **probe-dispatch-checkpoint**. Namespace: plugin uses `.flywheel/plugin/sessions/`.

## Input

No required arguments. Optional `$ARGUMENTS`:

- empty → use the active session from `.flywheel/plugin/active.json`
- slug (`^[a-z0-9-]+$`) → prefix-scan `.flywheel/plugin/sessions/<slug>-*`; tiebreak by most-recent date; update `active.json`
- findings.json path → fix-findings mode against that findings file

Context recovery: "carry on" or `/fly:work` with no args → Phase 0 resolves the active session, Phase 1 resumes from the first non-completed phase.

---

## Phase 0: Session Detection

**BLOCKING: Run this phase FIRST, before anything else.**

Read `references/session-detection.md` before proceeding (active-pointer model, stale-pointer rescue P1-F, slug-arg tiebreak P1-H, `/fly:review` routing D9).

Decision tree:

1. **No args, active.json missing** → error: `"No active session. Run /fly:plan or /fly:work <slug>."` Exit.
2. **No args, active.json present but session dir missing (stale pointer, P1-F)** → error: `"Session <id> not found. Clearing active pointer. Run /fly:plan or /fly:work <slug>."` Clear active.json. Exit.
3. **No args, active.json points to a real session dir** → use it.
4. **Slug arg** → prefix-scan `.flywheel/plugin/sessions/<slug>-*`; tiebreak by lexical-desc sort (ISO-date semantics); update `active.json` to winner.
5. **findings.json path arg** → fix-findings mode; session dir is the path's parent or resolved via active.json.

Validate `session.json.schema_version == 1`; reject with `"Unsupported schema version <N>. Re-run the producing skill to regenerate."` (P2-6).

---

## Phase 1: Load & Resume

Read `references/load-resume-procedures.md` before proceeding (input-type detection, fix-findings adapter, pre-flight BC-coverage D8, baseline write + hash D2).

Procedure:

1. **Detect input type**:
   - `spec.json` present and not in fix-findings mode → plan mode.
   - `review.findings.json` or `findings.json` present (and no spec, or explicit findings arg) → fix-findings mode.
2. **Adapter**:
   - Plan mode: spec.json is the TaskList. No transformation.
   - Fix-findings mode: synthesize a TaskList (file-grouped phases, one task per finding, one BC per finding, `origin.created_by: "work-implementation-adapter"`, `origin.findings_path: <input>`). See `references/load-resume-procedures.md` for grouping rules.
3. **Schema version check (P2-6)**: `schema_version == 1`. Mismatch → the literal error above.
4. **BLOCKING: Pre-flight BC-coverage check (D8)**: per `flywheel-conventions/SKILL.md` Spec Quality Bar — every BC has at-least-one task claim (orphans = error). Multiple claims on same BC → Open Question (D13, not auto-fail).
5. **Baseline write + hash (D2)**: if no baseline.json exists, write one (frozen copy of TaskList + `baseline_frozen_at`), compute SHA-256, store in `session.json.baseline_hash`. See `references/baseline-procedure.md`.
6. **Resume case**: if baseline.json exists, **BLOCKING: re-verify the hash** (match baseline.json SHA-256 against session.json.baseline_hash). Mismatch → halt with `"Baseline hash mismatch. The frozen baseline was mutated after work-start."`
7. **State init / resume**: if state.json exists, resume from first non-completed phase; otherwise write a fresh state.json per `references/state-file-template.md`.
8. **Session update**: `active_skill = "work-implementation"`, `last_checkpoint_at = <now>`. Atomic write.
9. **Worktree assessment**: advisory prompt per `references/load-resume-procedures.md` if scope is large.

Register a skill-exit trap to clear `active_skill` on any exit path (P2-14):

```bash
cleanup_active_skill() {
  if [ -f "$SESSION_DIR/session.json" ]; then
    jq '.active_skill = null' "$SESSION_DIR/session.json" \
      > "$SESSION_DIR/session.json.tmp"
    mv "$SESSION_DIR/session.json.tmp" "$SESSION_DIR/session.json"
  fi
}
trap cleanup_active_skill EXIT
```

---

## Phase 2: Execute (Per-Phase Loop)

For each phase in TaskList.phases[] whose `status != "completed"`:

### 2.1 Probe Phase Files

Quick check of the phase's referenced files (from `phase.files[]` and each `task.files[]`). Flag missing files; warn if any single file exceeds 500 lines (consider splitting).

### 2.2 Dispatch Subagent

**BLOCKING: Every phase executes inside a Task subagent. The main agent's role in Phase 2 is probe (2.1) → dispatch (2.2) → checkpoint (2.3) — not implementation. Do NOT use Edit or Write on source files from the main agent.**

If a phase looks trivially small, dispatch it anyway. You cannot judge cross-phase context pressure from a single phase's scope — by the time phase N feels heavy, phases 1..N-1 have already accumulated in the main thread. A 3-file, 20-minute phase still dispatches; the rationalization "it was small and mechanical" is the exact failure mode this rule exists to catch.

Main-agent bypass is only legitimate when dispatch itself is blocked (Task tool unavailable, subagent returning structural failures, a shared reference both phases need to update atomically). Record the bypass with a non-null `bypass_justification` at checkpoint; see `references/checkpoint-procedure.md`.

**BLOCKING: Do NOT specify a `model` parameter** — subagents inherit the current session's model.

```
Task general-purpose: "
## Task
Execute Phase <id>: <phase.goal>

## TaskList Excerpt
<paste phase JSON: tasks, files, verification, manual_verification>

## Context
- BC claims: <phase.tasks[].fulfills[] summarized>
- Key files from baseline: <baseline.context.key_files>
- Patterns: <baseline.context.patterns>
- Gotchas: <baseline.context.gotchas>
- Completed phases so far: <state.phases[] where status == completed, with outcomes>
- Learnings: <state.learnings>

## Constraints
- Follow existing patterns exactly.
- TDD per task (RED → GREEN → REFACTOR) unless the task is pure refactor/docs/config.
- Record every command: artifact entries with literal command, actual exit_code, actual stdout_tail.
- Report: outcomes, files_created[], files_modified[], commands_run[], any strikes.
"
```

Provide the phase JSON directly; do not make the subagent re-read spec.json.

### 2.2a TDD Cycle

Read `flywheel-conventions/references/tdd-cycle.md` for RED/GREEN/REFACTOR. Skip TDD for pure refactoring, config-only, or docs changes.

### 2.3 Checkpoint (Atomic JSON Writes)

Read `references/checkpoint-procedure.md` before proceeding (atomic-write invariant, `commands_run` accuracy K5, merge-into-state.json recipe).

1. Capture the subagent's reported artifacts into the phase's `state.phases[i]`:
   - `status: "completed"` (only if verification passed)
   - `completed_at: <now ISO8601>`
   - `outcomes: [...]`
   - `artifacts.files_created[]`, `files_modified[]`, `commands_run[]`
   - `bc_satisfied[]` = union of `fulfills[]` across phase tasks (derived from **baseline**, not spec.json, to pin what was committed to).
2. **Atomic write state.json** (always via `state.json.tmp` + `mv`; see `references/state-file-template.md`).
3. **Update session.json.last_checkpoint_at** (atomic write).
4. **Verify TDD evidence**: tests exist, tests pass (exit 0). Re-run the phase's `verification` command if there's any doubt; capture real exit code.
5. **Manual verification pause** if `phase.manual_verification` is non-empty. See `references/checkpoint-procedure.md`.

### 2.4 Ralph Mode Check

Ralph mode activates when any of: plan has >5 phases, `--ralph` flag, or context >50% with >2 phases remaining. Read `references/ralph-mode.md` before proceeding.

### 2.5 Loop

Continue to next unchecked phase. All complete → Phase 3.

---

## Phase 3: Quality Check

Follow `references/verification-gates.md`: IDENTIFY proving command, RUN fresh, READ full output, VERIFY it confirms the claim, ONLY THEN make the claim.

**Two-Stage Review**:
1. **Stage 1: Spec Compliance** — Built what the baseline spec requested? (Fix gaps before Stage 2.)
2. **Stage 2: Code Quality** — Code clean, tested, pattern-consistent?

---

## Phase 4: Complete

All phases executed and verified. Present the user with next steps:

```
All phases complete and verified.

What's next?
1. Review the work (recommended if complex changes) — dispatches /fly:review → work-review
2. Ship it — dispatches /fly:ship (commit, PR, compound learnings)
```

After the user's choice:

1. Update `state.json.status = "completed"` (atomic write).
2. The Phase 1 trap has cleared `session.json.active_skill`. ship handles `session.status = "completed"`.
3. Worktree cleanup: if in worktree, offer to remove and switch to main.

---

## Recovery & Error Handling

Read `references/recovery-and-errors.md` before proceeding (resume flow, stranded-.tmp cleanup, baseline hash re-verification, 3-Strike protocol, always-clear-active-skill trap).

**Errors**: 3-Strike protocol (record each attempt in `state.phases[i].strikes[]`, escalate to `state.error_log[]` after three). Subagent failures: retry/skip/abort prompt. Test failures: fix before checkpointing.

---

## Anti-Patterns

- **Split plan into "this session" phases** — context pressure is handled via Ralph mode or subagent dispatch. If a spec is genuinely too large, return to plan-consolidation.
- **Ask for approval between every task** — spec is the authority. Only ask when the spec itself is ambiguous.
- **BLOCKING: Declare "done" without running tests** — `references/verification-gates.md` requires evidence. Each phase's `verification` command must execute and pass before state transitions to `complete`.
- **BLOCKING: Direct main-agent execution of "small" phases** — "Small" is a per-phase judgment; context pressure is a per-plan property. Reads, edits, and test output accumulate across phases and choke the main thread by late phases. Dispatch every phase via Task. The main agent does probe + dispatch + checkpoint — nothing else. If legitimately bypassed, `state.phases[i].executed_by` must be `"main-agent"` with a non-null `bypass_justification`; "it looked small" is not a valid justification.

---

## Detailed References

- `references/session-detection.md` — Phase 0 active-pointer model, stale-pointer rescue, slug-arg tiebreak, `/fly:review` routing heuristic (D9)
- `references/load-resume-procedures.md` — Phase 1 adapter (spec.json vs findings.json), pre-flight BC coverage, schema version check
- `references/baseline-procedure.md` — Baseline write, SHA-256 hash, mid-execution plan change (D2)
- `references/checkpoint-procedure.md` — Atomic JSON state writes, `commands_run` accuracy (K5), merge recipes
- `references/state-file-template.md` — state.json shape, atomic write invariant, status enum
- `references/session-file-template.md` — session.json shape, `active_skill` lifecycle, skill-exit cleanup trap
- `references/verification-gates.md` — Verification protocol, two-stage review, B6 system-wide test check
- `references/recovery-and-errors.md` — Resume flow, 3-Strike protocol, baseline hash re-verification
- `references/ralph-mode.md` — Stateless agent loop triggers, checkpoint format, state completeness
- `flywheel-conventions/references/tdd-cycle.md` — RED/GREEN/REFACTOR; skip conditions for pure refactors/docs/config
