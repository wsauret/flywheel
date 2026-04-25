# Load & Resume Procedures (Phase 1)

Mode detection, fresh-start initialization, resume invariants. Read before Phase 1.

## Inputs at the session directory

- `spec.json` — plan output from plan-creation/plan-consolidation
- `review.findings.json` — last review's output (from work-review at this point — plan-review's findings get consumed by plan-consolidation)
- `progress.json` — work state, present after first chunk completes
- `session.json` — session metadata

## Mode Detection

If the user passed an explicit findings-path argument (`/fly:work <path-to-review.findings.json>`), force fresh fix-findings mode regardless of prior session state. Archive any pre-existing `progress.json` first. This is the override path for "I want to fix the review now, skipping consolidation."

Otherwise, use session contents:

```bash
PROGRESS="$SESSION_DIR/progress.json"
SPEC="$SESSION_DIR/spec.json"
FINDINGS="$SESSION_DIR/review.findings.json"
EXPLICIT_FINDINGS_ARG="${1:-}"  # If $ARGUMENTS is a findings.json path

if [ -n "$EXPLICIT_FINDINGS_ARG" ] && [[ "$EXPLICIT_FINDINGS_ARG" == *.findings.json ]]; then
  # User invoked with an explicit findings path — force fix-findings, archive prior progress.
  if [ -f "$PROGRESS" ]; then
    mv "$PROGRESS" "$SESSION_DIR/progress.json.archived-$(date +%s)"
  fi
  INIT_MODE=fix-findings
elif [ -f "$PROGRESS" ]; then
  MODE=$(jq -r .mode "$PROGRESS")
  STATUS=$(jq -r .status "$PROGRESS")

  if [ "$MODE" = "plan" ] && [ "$STATUS" = "completed" ] && [ -f "$FINDINGS" ]; then
    # Plan-mode work finished, new review arrived → fresh fix-findings round.
    mv "$PROGRESS" "$SESSION_DIR/progress.json.plan-mode"
    INIT_MODE=fix-findings
  elif [ "$MODE" = "fix-findings" ] && [ "$STATUS" = "completed" ] && [ -f "$FINDINGS" ]; then
    # Another review round on top of fix-findings work.
    mv "$PROGRESS" "$SESSION_DIR/progress.json.fix-findings-$(date +%s)"
    INIT_MODE=fix-findings
  else
    INIT_MODE=resume   # Resume whatever mode is current.
  fi
elif [ -f "$FINDINGS" ] && [ -f "$SPEC" ]; then
  echo "Error: review.findings.json exists but spec.json was not consolidated. Run /fly:plan-consolidation, OR re-invoke /fly:work with the findings path explicitly to fix-findings directly." >&2
  exit 1
elif [ -f "$SPEC" ]; then
  INIT_MODE=plan
else
  echo "Error: no spec.json or review.findings.json in $SESSION_DIR." >&2
  exit 1
fi
```

## Fresh Start (Plan Mode)

```bash
jq -n '{
  schema_version: 1, mode: "plan", status: "pending",
  completed: [], in_progress: null,
  artifacts: { files_modified: [], commands_run: [] },
  error_log: []
}' > "$SESSION_DIR/progress.json.tmp"
mv "$SESSION_DIR/progress.json.tmp" "$SESSION_DIR/progress.json"
```

## Fresh Start (Fix-Findings Mode)

Identical shape to plan mode, with `mode: "fix-findings"`. The `completed[]` list holds **theme IDs** as chunks complete (e.g. `theme-scaffolding-redesign`, `theme-polish`), NOT finding IDs.

### Theme grouping

Before dispatching, the synthesizer clusters findings into themes:

1. Read `review.findings.json.findings[]`.
2. Group findings whose `fix` shares a structural change — same file's redesign, same shared-helper simplification, same coordinated cross-file edit.
3. Sweep all small unrelated polish (1-line comment fixes, single-finding files, import merges) into one `theme-polish` chunk.
4. Result: 1-5 themes regardless of finding count. A 17-finding review usually clusters into 3-5 themes.

A theme has a slugified ID (`theme-<descriptor>`), a one-line description, and the list of finding IDs it covers. The synthesizer can announce the theme breakdown to the user before dispatching for confirmation, but should not require approval for obvious clusters.

**Anti-pattern:** one-chunk-per-file. This produces N chunks for N files, including single-finding files that get a dispatch each. Theme-group instead.

## Resume Path

If `progress.json` exists with `status != "completed"`:

1. Read `progress.json`. The `completed[]` list is the source of truth.
2. The next chunk to dispatch is the first one whose ID is not in `completed[]`.
3. Update `session.json.last_checkpoint_at` to now; `active_skill = "work-implementation"`.

No hash check. No baseline read. No per-phase strikes ledger.

## Schema Version Mismatch

If `spec.json.schema_version != 1` or `review.findings.json.schema_version != 1`:

```
Error: Unsupported schema version <N>. Re-run the producing skill to regenerate.
```

The error message is literal — do not reword.

## Worktree Assessment (Advisory)

Recommend a worktree when:

- spec.json modifies >10 files (`jq '[.phases[].files[]] | unique | length' spec.json`)
- spec.json has >3 phases
- Any phase touches high-risk paths (auth, payments, migrations)

Prompt:

```
Ready to execute.
Scope: N files, M phases.

1. Current branch (Recommended for small changes)
2. Create worktree (Recommended for >10 files or high-risk paths)
```

If worktree: use native `git worktree add` and remind about dependency install and `/init`.
