# Session ID and Artifact Layout

Conventions for the session directory plan-creation writes.

## Session ID Pattern

**Format:** `<slug>-<YYYY-MM-DD>` with an optional `-N` collision tiebreak (`-2`, `-3`, …).

- **Slug**: kebab-case, alphanumeric + hyphens only. Regex: `^[a-z0-9-]+$`
- **Date**: ISO 8601 `YYYY-MM-DD` (the day the session is created)
- **Tiebreak**: integer suffix starting at `-2` when a session for the same slug already exists for the same date

**Examples:**

- `add-timeout-flag-2026-04-23`
- `fix-checkout-race-2026-04-23`
- `refactor-auth-2026-04-23-2` (second session with the same slug on the same day)

**Invalid (avoid):**

- `add_timeout_flag-2026-04-23` (underscores)
- `Add-Timeout-2026-04-23` (uppercase)
- `timeout-2026-4-23` (unpadded month/day)

## Directory Layout

```
.flywheel/plugin/sessions/<session-id>/
  spec.json                    # plan-creation writes; plan-consolidation refines
  session.json                 # plan-creation writes; status/active_skill metadata
  spec.json.pre-consolidation  # plan-consolidation writes before refinement
  review.findings.json         # plan-review and work-review write here (consumed by next skill)
  progress.json                # work-implementation checkpoint state
```

The `plugin/` infix exists so plugin sessions coexist with TUI sessions (`.flywheel/sessions/`) in the same repo without collision.

## Active Pointer

**Path:** `.flywheel/plugin/active.json`

**Schema:**

```json
{ "schema_version": 1, "session_id": "<session-id>" }
```

plan-creation writes this after it writes the session directory. Downstream skills read this to find the active session.

## Collision Behavior

1. Compute candidate session id: `<slug>-<YYYY-MM-DD>`
2. If `.flywheel/plugin/sessions/<candidate>/` does not exist → use candidate
3. Otherwise, append `-2`, `-3`, … until a free slot is found
4. If `-9` is taken (i.e. 10 sessions for the same slug on the same day) → error out and ask the user to clean up — they likely have a stuck session

Collision detection is recursion-safe: each probe is a single `test -d` call.

## Content Guidelines

### Repo-relative file paths

Every path inside `spec.json` is repo-relative (`src/auth.ts:42-55`), never absolute. The spec is checked against real code, and absolute paths rot the moment someone else opens the session.

### Test scenarios

Each task lists enumerable scenarios. A scenario is concrete enough that the implementer turns it directly into a test case. If you can't write one, the task is not ready — surface it as an `open_question` on the spec.
