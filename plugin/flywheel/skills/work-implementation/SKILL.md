---
name: work-implementation
description: Execute spec.json (plan mode) or review.findings.json (fix-findings mode) by dispatching subagents per chunk. Triggers on "work on", "implement", "execute plan", "carry on", "continue".
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

# Work Implementation Skill

Execute the active session's plan or review findings via probe → dispatch → checkpoint. Namespace: plugin uses `.flywheel/plugin/sessions/`.

## Input

No required arguments. Optional `$ARGUMENTS`:

- empty → use the active session from `.flywheel/plugin/active.json`
- slug (`^[a-z0-9-]+$`) → prefix-scan `.flywheel/plugin/sessions/<slug>-*`; tiebreak by most-recent date

Mode is detected from session contents — never set explicitly.

---

## Phase 0: Session Detection

Read `references/session-detection.md`.

Decision tree:

1. **No args, active.json missing** → error: `"No active session. Run /fly:plan or /fly:work <slug>."` Exit.
2. **No args, active.json points to missing session dir** → error: `"Session <id> not found. Clearing active pointer."` Clear active.json. Exit.
3. **No args, active.json present** → use it.
4. **Slug arg** → prefix-scan; tiebreak by lexical-desc sort (ISO-date semantics); update active.json to winner.

Validate `session.json.schema_version == 1`. Mismatch → `"Unsupported schema version <N>. Re-run the producing skill to regenerate."`

---

## Phase 1: Mode Detection & Load

Read `references/load-resume-procedures.md`.

Procedure:

1. **Detect mode** from session contents:
   - `progress.json` exists with `mode: "fix-findings"` → resume fix-findings.
   - `progress.json` exists with `mode: "plan"` AND `status: "completed"` AND `review.findings.json` exists → start fresh fix-findings (archive old `progress.json` to `progress.json.plan-mode`).
   - `progress.json` exists with `mode: "plan"` → resume plan mode.
   - `progress.json` missing AND `review.findings.json` exists AND `spec.json` exists → error: `"Run /fly:plan-consolidation to merge review findings before starting work."`
   - `progress.json` missing AND `spec.json` exists → start fresh plan mode.
   - else → error: `"No spec.json or review.findings.json in session."`

2. **Init progress.json (fresh start only)**:

   ```json
   {
     "schema_version": 1,
     "mode": "<plan|fix-findings>",
     "status": "pending",
     "completed": [],
     "in_progress": null,
     "artifacts": { "files_modified": [], "commands_run": [] },
     "error_log": []
   }
   ```

   Atomic write (`.tmp` → `mv`).

3. **Session update**: `active_skill = "work-implementation"`, `last_checkpoint_at = <now>`. Atomic write.

4. **Skill-exit trap** to clear `active_skill`:

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

5. **Worktree assessment**: advisory prompt per `references/load-resume-procedures.md` if scope is large.

No baseline. No hash. No BC coverage check. No TaskList synthesis.

---

## Phase 2: Execute (Per-Chunk Loop)

The chunk unit depends on mode. In both modes, a chunk is a **phase + bullets** structure: one logical unit of work containing several related items the subagent works through in a single dispatch.

- **Plan mode**: chunk = phase from `spec.json.phases[]`. ID = `phase.id`. Bullets = `phase.tasks[]`.
- **Fix-findings mode**: chunk = **theme group** of findings — a logical cluster (e.g. one design refactor, one shared-helper simplification, one polish pass) that one subagent can address in a single dispatch. ID = `theme-<slug>` (e.g. `theme-scaffolding-redesign`, `theme-polish`). Bullets = the findings in that theme.

  **Theme grouping (the synthesizer's job):**
  - Cluster findings whose suggested fixes share a structural change (same file or same coordinated cross-file edit).
  - Group all small unrelated polish (1-line comment fixes, import merges, single-finding files) into one `theme-polish` chunk; do NOT dispatch one subagent per single-finding file.
  - Aim for 1-5 themes regardless of finding count. 17 findings → ~4 themes is right; 17 findings → 17 themes is wrong.
  - Themes don't have to be balanced. A scaffolding redesign with 3 findings is a theme; a polish pass with 9 P3s is also a theme.
  - Theme name should describe the change (e.g. `theme-loadmd-simplify`), not the file (e.g. `theme-load-step-markdown-ts`).

For each chunk whose ID is NOT in `progress.completed[]`:

### 2.1 Probe Files

Quick check of the chunk's files. Flag missing files; warn if any single file >500 lines.

### 2.2 Dispatch Subagent

**BLOCKING: every chunk runs inside a Task subagent.** Main agent does probe → dispatch → checkpoint, never Edit/Write on source files.

**Plan mode dispatch:**

```
Task general-purpose: "
## Task
Execute phase <id>: <phase.goal>

## Phase JSON
<paste phase JSON: tasks, files, verification, manual_verification>

## Context
- summary: <spec.summary>
- success_criteria: <spec.success_criteria>
- key_files: <spec.context.key_files>
- patterns: <spec.context.patterns>
- gotchas: <spec.context.gotchas>
- Already completed: <progress.completed>

## Elegance bar (NON-NEGOTIABLE)
Maximize elegance over minimizing churn. Pick the more elegant design even if it means a larger refactor.
- Every line you add must do important work. If you can't name what concretely breaks when a line is removed, delete it.
- Single source of truth — read from existing state, don't duplicate.
- Use the language/framework's idiomatic primitive before reaching for a wrapper. Search the codebase first.
- Wrappers and helpers must add capability, not move code around. No shallow wrappers, no forwarding chains.
- No speculative code, no defensive checks for impossible cases, no backward-compat shims for nonexistent consumers.
- Follow existing patterns; deviate when the existing pattern is itself inelegant — note it in your report.

## Constraints
- TDD per task (RED → GREEN → REFACTOR). REFACTOR is mandatory: after green, re-read each touched file and ask 'would a reader ask why any line is here?' If yes, simplify or delete. Skip TDD only for pure refactor, docs, or config-only changes.
- Before claiming a task done, confirm every added line has a concrete purpose. Anything that doesn't, delete.
- Record commands run with literal command + actual exit_code.
- Report: outcomes, files_modified[], commands_run[], simplifications_made[] (places you deleted or consolidated instead of adding).
"
```

**Fix-findings mode dispatch:**

```
Task general-purpose: "
## Task
Resolve theme: <theme-id> — <theme-description>

## Context
- spec: .flywheel/plugin/sessions/<session_id>/spec.json (Read for system-level goal, success criteria, and design rationale in context.gotchas[])

## Findings (read all before fixing any)
<paste each finding verbatim: title, severity, location, failure, fix>

## Approach: symptoms vs. structure
These findings are clustered because they likely share a structural cause. Diagnose first, patch never.
1. Read all findings before touching code. Identify the structural issue they point at.
2. Fix the structure once. If the structural change resolves N of M findings as a side effect, re-evaluate the rest before applying their fixes — they may dissolve too.
3. Do NOT apply each fix as an isolated patch. The fixes are reviewer hypotheses about individual symptoms; the synthesizer grouped them because the real fix is upstream.

## Elegance bar (NON-NEGOTIABLE)
Maximize elegance over minimizing churn. If the cleaner shape requires touching files outside the findings list, take it — note the drift in your report.
- Every line you keep must do important work; every line you add too.
- Prefer deletion to modification. The best fix is often less code, not more.

## Holistic re-read (mandatory before claiming done)
After applying changes, re-read each touched file end-to-end. Ask:
- Is the result simpler than what I started with?
- Does any line in this diff lack a concrete purpose?
- Would a reader ask 'why is this here?' about anything I added?
If the diff is longer or more complex than the pre-fix code, you patched instead of refactored. Redo as a refactor.

## Constraints
- Run tests after the change set; capture exit_code.
- Report: which finding IDs were addressed, files_modified[], commands_run[], structural_change (one-sentence summary of what shape change resolved the theme).
"
```

**BLOCKING: Do NOT specify a `model` parameter** — subagents inherit the current session's model.

### 2.2a TDD Cycle

Read `flywheel-conventions/references/tdd-cycle.md` for RED/GREEN/REFACTOR. Skip TDD for pure refactoring, config-only, or docs changes.

### 2.3 Checkpoint (Atomic Write)

Read `references/checkpoint-procedure.md`.

On subagent return:

1. Append chunk ID to `progress.completed[]`.
2. Append `files_modified[]`, `commands_run[]`, and `simplifications_made[]` (if reported) to `progress.artifacts`.
3. Atomic write `progress.json` (`.tmp` → `mv`).
4. Update `session.json.last_checkpoint_at`.
5. Verify the chunk's `verification` (plan mode) or run tests (fix-findings mode). Capture exit_code. Re-run if any doubt.
6. Manual verification pause if `phase.manual_verification` is non-empty (plan mode).

### 2.4 Ralph Mode Check

Ralph mode activates when any of: spec has >5 phases, `--ralph` flag, or context >50% with >2 chunks remaining. Read `references/ralph-mode.md`.

### 2.5 Loop

Continue to the next non-completed chunk. All complete → Phase 3.

---

## Phase 3: Quality Check

Run the plan's `success_criteria` checks (plan mode) or full test suite + typecheck (fix-findings mode). Read `references/verification-gates.md`: identify the proving command, run it fresh, read full output, verify, then claim done.

---

## Phase 4: Complete

```
All chunks complete and verified.

What's next?
1. Review the work — /fly:review (recommended for substantive changes)
2. Ship it — /fly:ship (commit, PR, compound learnings)
```

After the user's choice:

1. `progress.json.status = "completed"` (atomic write).
2. Phase 1 trap clears `session.json.active_skill`. ship handles `session.status = "completed"`.
3. Worktree cleanup if applicable.

---

## Recovery & Errors

Read `references/recovery-and-errors.md`.

**Errors**: 3-Strike protocol per chunk (record each attempt in `progress.error_log`). Subagent failures: retry/skip/abort prompt. Test failures: fix before checkpointing.

---

## Anti-Patterns

- **Synthesize a TaskList from findings.json** — findings.json IS the list. Group by theme (not by file) and dispatch.
- **Group fix-findings by `location`** — produces one chunk per file, which inflates dispatch count for any review with single-finding files. Use theme groups instead (see Phase 2 chunk-definition section). 17 findings spread across 9 files should land in ~4 themes, not 9.
- **Write a baseline.json or compute a hash** — neither exists in the simplified model. spec.json is the live target.
- **BLOCKING: Direct main-agent execution of "small" chunks** — dispatch every chunk via Task. The main agent does probe + dispatch + checkpoint, nothing else.
- **BLOCKING: Declare done without running verification** — `references/verification-gates.md` requires fresh evidence. Each chunk's `verification` must execute and pass before the chunk is marked completed.

---

## Detailed References

- `references/session-detection.md` — Phase 0 active-pointer model, slug-arg tiebreak
- `references/load-resume-procedures.md` — Phase 1 mode detection, fresh-start init, resume invariants
- `references/checkpoint-procedure.md` — Atomic write recipe, `commands_run` accuracy
- `references/progress-file-template.md` — progress.json shape, atomic write invariant, status enum
- `references/session-file-template.md` — session.json shape, `active_skill` lifecycle, skill-exit cleanup trap
- `references/verification-gates.md` — Verification protocol
- `references/recovery-and-errors.md` — Resume flow, 3-Strike protocol
- `references/ralph-mode.md` — Stateless agent loop triggers, checkpoint format
- `flywheel-conventions/references/tdd-cycle.md` — RED/GREEN/REFACTOR; skip conditions
