# Session Detection (Phase 0)

Active-pointer model, stale-pointer rescue, slug-arg tiebreak, and the shared `/fly:review` routing heuristic. Read this file before Phase 0 to handle every input shape correctly.

## Active-Pointer Model

Session state lives under `.flywheel/plugin/sessions/<session-id>/`. The currently-active session is identified by `.flywheel/plugin/active.json`:

```json
{ "schema_version": 1, "session_id": "add-timeout-flag-2026-04-23" }
```

Session id pattern: `<slug>-<YYYY-MM-DD>` (optional `-N` suffix for collisions). The active pointer resolves to a session directory containing `spec.json`, `session.json`, and (after first chunk completes) `progress.json`. `review.findings.json` may also be present, written by `plan-review` (consumed by `plan-consolidation`) or `work-review` (consumed by `work-implementation` in fix-findings mode).

## Phase 0 Procedure

Follow this decision tree **in order**. Each branch short-circuits the next.

### Step 1: Inspect `$ARGUMENTS`

| `$ARGUMENTS` | Action |
|---|---|
| empty | Fall through to Step 2 (use active session). |
| slug (matches `^[a-z0-9-]+$`) | Prefix-scan for sessions (see Step 3). |

### Step 2: Empty args — resolve active session

1. If `.flywheel/plugin/active.json` is missing:
   ```
   Error: No active session. Run /fly:plan or /fly:work <slug>.
   ```
   Exit with a non-zero status.

2. Read `.flywheel/plugin/active.json`:
   ```bash
   SESSION_ID=$(jq -r '.session_id' .flywheel/plugin/active.json)
   ```

3. **Stale-pointer rescue (P1-F)** — if `.flywheel/plugin/sessions/$SESSION_ID/` does not exist:
   ```
   Error: Session $SESSION_ID not found. Clearing active pointer.
   Run /fly:plan or /fly:work <slug>.
   ```
   Then: `rm -f .flywheel/plugin/active.json`. Exit with a non-zero status.

4. Otherwise: `SESSION_DIR=.flywheel/plugin/sessions/$SESSION_ID`. Continue to Phase 1.

### Step 3: Slug arg — prefix-scan with tiebreak (P1-H)

```bash
SLUG="$ARGUMENTS"
# Prefix-scan: collect all sessions whose id starts with <slug>-<date>.
matches=$(find .flywheel/plugin/sessions -maxdepth 1 -type d -name "${SLUG}-*" | sort -r)
```

- Zero matches: error "No session matching slug '$SLUG'. Run /fly:plan first."
- One match: that's the session. Set `SESSION_DIR`, update `active.json`, continue to Phase 1.
- Multiple matches: **tiebreak by lexical sort desc**. ISO-date suffix (`-YYYY-MM-DD`) sorts lexically = chronologically. Take the first result after `sort -r`. Update `active.json` to the winner, continue to Phase 1.

Write the new active pointer atomically per the Phase 2 atomic-write rule:

```bash
printf '{"schema_version":1,"session_id":"%s"}' "$WINNER" > .flywheel/plugin/active.json.tmp
mv .flywheel/plugin/active.json.tmp .flywheel/plugin/active.json
```

## `/fly:review` Routing Heuristic (D9)

This is a **shared helper** authored here per D9 and referenced by `flywheel/commands/fly/review.md` in Phase 5. `/fly:review` does not have its own skill — it dispatches to `plan-review` or `work-review` based on the input.

### Contract

| Input | Dispatch |
|---|---|
| `$ARGUMENTS` matches `^#?\d+$` (PR number) | `work-review` with the PR target |
| `$ARGUMENTS` looks like a branch name | `work-review` with the branch target |
| `$ARGUMENTS` empty AND session has `progress.json` | `work-review` (work is in progress or complete) |
| `$ARGUMENTS` empty AND session has `spec.json` but no `progress.json` | `plan-review` (spec not yet executed) |
| `$ARGUMENTS` empty AND neither file present | error "No spec to review. Run /fly:plan first." |

### Procedure (pseudocode matching `tests/work/routing.test.sh`)

```bash
route_review() {
  local arguments="$1"
  local session_dir="$2"   # resolved from .flywheel/plugin/active.json

  # PR number, with or without '#' prefix
  if [[ "$arguments" =~ ^#?[0-9]+$ ]]; then
    echo "work-review"
    return 0
  fi

  # Branch-name shape: contains '/', or starts with alphanumeric and has
  # dot/dash/underscore chars.
  if [ -n "$arguments" ] && [[ "$arguments" == */* || "$arguments" =~ ^[a-zA-Z][a-zA-Z0-9._-]*$ ]]; then
    echo "work-review"
    return 0
  fi

  if [ -z "$session_dir" ]; then
    echo "No active session and no PR/branch argument. Run /fly:plan first." >&2
    return 4
  fi

  if [ -f "$session_dir/progress.json" ]; then
    echo "work-review"
    return 0
  fi

  if [ -f "$session_dir/spec.json" ]; then
    echo "plan-review"
    return 0
  fi

  echo "No spec to review. Run /fly:plan first." >&2
  return 4
}
```

### Intuition

- **Presence of `progress.json`** is the signal that work has been started. If work is in progress or complete, review targets the executed work — `work-review`.
- **Presence of `spec.json` alone** means the plan hasn't been executed yet. Review targets the plan — `plan-review`.
- **An explicit PR/branch** bypasses the session-based inference; the user is asking to review code in a specific scope, regardless of the local session state.

### Edge Cases

- **User passed a session id as arg** (matches `^[a-z0-9-]+-\d{4}-\d{2}-\d{2}(-\d+)?$`): treat as a slug lookup via the Phase 0 slug-arg procedure, then apply the routing heuristic against the resolved session dir with empty `arguments`.

## Validation Checks Before Proceeding

Once the session is resolved, before Phase 1:

1. **Schema version match** — `session.json.schema_version == 1`. Reject with `"Unsupported schema version <N>. Re-run the producing skill to regenerate."`
2. **`spec.json` presence** for plan-mode work, or **`review.findings.json` presence** for fix-findings mode. Missing → ask the user to run the preceding skill.
3. **Stale `.tmp` cleanup** — if `progress.json.tmp` exists from a prior interrupted write, delete it. The authoritative state file is `progress.json`; `.tmp` is scratch.

## If Session Exists AND `$ARGUMENTS` Disagrees

- **Same session (arg resolves to same session_id as active.json)**: proceed.
- **Different session (arg resolves to a different session_id)**: update `active.json` to the new session_id (auto-switch; providing an arg is implicit confirmation). Briefly note the switch, no prompt.
