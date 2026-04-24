# Load & Resume Procedures (Phase 1)

Adapter logic (spec.json vs findings.json), pre-flight BC-coverage check, baseline write + hash, and state initialization. Read this before Phase 1 so the skill picks the right branch.

## Phase 1 Inputs

The resolved session directory from Phase 0 may contain:

- `spec.json` — task-list produced by plan-creation or plan-consolidation (plan mode)
- `findings.json` or `review.findings.json` — reviewer output (fix-findings mode, when no spec is the target)
- `context.md` — research sidecar (read for context, never edited)
- `baseline.json` — present only on resume after work has already started
- `state.json` — present only on resume
- `session.json` — session metadata (always present after plan-creation runs)

## Adapter: Detect Input Type

```bash
if [ -f "$SESSION_DIR/spec.json" ] && [ "$INPUT_TYPE" != "fix-findings" ]; then
  INPUT_TYPE=plan
  INPUT_PATH="$SESSION_DIR/spec.json"
elif [ -f "$SESSION_DIR/review.findings.json" ]; then
  INPUT_TYPE=fix-findings
  INPUT_PATH="$SESSION_DIR/review.findings.json"
elif [ -f "$SESSION_DIR/findings.json" ]; then
  INPUT_TYPE=fix-findings
  INPUT_PATH="$SESSION_DIR/findings.json"
else
  echo "Error: no spec.json or findings.json in $SESSION_DIR." >&2
  exit 1
fi
```

## Schema Version Mismatch Rejection (P2-6)

Before loading the TaskList, verify:

```bash
SV=$(jq -r '.schema_version' "$INPUT_PATH")
if [ "$SV" != "1" ]; then
  echo "Error: Unsupported schema version $SV. Re-run the producing skill to regenerate." >&2
  exit 1
fi
```

This applies to both `spec.json` (task-list.schema.json) and `findings.json` (findings.schema.json). The error message is literal — do not reword.

## Branch A: Plan Mode (spec.json)

No transformation needed. The in-memory TaskList **is** the parsed spec.json:

```bash
TASKLIST=$(jq '.' "$SESSION_DIR/spec.json")
```

The spec already conforms to `task-list.schema.json`. Validate once to be safe:

```bash
bunx ajv-cli --validate-formats=false --spec=draft2020 \
  validate -s flywheel/schemas/task-list.schema.json \
           -d "$SESSION_DIR/spec.json"
```

Ajv is a dev-only schema test (D8). At runtime the skill does **not** invoke ajv; it trusts the writer. This reference mentions ajv only as the offline verification approach.

## Branch B: Fix-Findings Mode (findings.json)

The adapter synthesizes a TaskList from a findings.json input. The procedure:

1. **Group findings by file** — each unique `scope.file` becomes a phase.
2. **One task per finding** — task description references the finding's `suggested_fix`, test scenarios derive from the `what_wrong` case.
3. **Synthesize BCs** — one BC per finding, title copied from the finding's `title`, area uppercased from the file-basename root (e.g. `src/auth.ts` → `AUTH`). Unique counter per area (e.g. `BC-AUTH-001`, `BC-AUTH-002`).
4. **Each task's `fulfills[]`** claims the synthesized BC for its finding (ensures BC coverage).
5. **`origin.created_by`**: set to `"work-implementation-adapter"`.
6. **`origin.findings_path`**: set to the input path.
7. **`plan_id`**: `fix-findings-<YYYY-MM-DD>` or the active session's plan_id if different.

Example: see `tests/work/fixtures/findings-derived-tasklist.json` for the reference output shape.

### BC ID Collisions

If two findings synthesize to the same area (e.g. both in `src/auth.ts`), increment the three-digit counter. The schema enforces uniqueItems on BCs, so duplicates caught at validate-time.

## Pre-Flight BC-Coverage Check (D8, prose-directive)

Before writing `baseline.json`:

Per B4 in flywheel-conventions (Spec Quality Bar), verify:

- **Every BC in `behavioral_contract[]` is claimed by at-least-one task** (union of `phases[].tasks[].fulfills[]`). Orphans are an error: `"BC <id> has no task claim. Update the spec.json to add a task that fulfills it, or remove the BC."`
- **Multiple claims on the same BC** surface as an Open Question (not auto-fail per D13). Present the user via AskUserQuestion: "BC <id> is claimed by tasks <t1>, <t2>. Is this intentional (cross-phase contract) or a redundant claim?"
- **BC id uniqueness** is schema-enforced (`uniqueItems: true`); the coverage check assumes it.

This is a prose directive — there is no runtime BC-coverage checker binary. The agent reasons through the union in-memory (jq does the set-difference; see `tests/pipeline/plan-create.test.sh:103-113` for the formulation).

```bash
orphans=$(jq -r '
  (.behavioral_contract | map(.id)) as $bcs
  | ([.phases[].tasks[].fulfills[]] | unique) as $claimed
  | $bcs - $claimed
  | .[]
' "$SESSION_DIR/spec.json")
```

If `$orphans` is non-empty, halt with the error above.

## Baseline Write + Hash (D2)

See `baseline-procedure.md` for the full procedure. The short form:

1. Copy the in-memory TaskList to `baseline.json`, adding `baseline_frozen_at: <ISO 8601 timestamp>`.
2. Validate against `baseline.schema.json` (offline via ajv test; at runtime the shape is trusted).
3. Compute SHA-256:
   ```bash
   HASH=$(shasum -a 256 "$SESSION_DIR/baseline.json" | awk '{print $1}')
   ```
4. Write `HASH` into `session.json.baseline_hash` via atomic write (see checkpoint-procedure.md).

## State Initialization

Write a fresh `state.json` at the session directory:

```json
{
  "schema_version": 1,
  "plan_id": "<from-spec>",
  "status": "pending",
  "summary": "Phase 1 load complete. No phases executed yet.",
  "phases": [
    {
      "id": "<phase-id>",
      "status": "pending",
      "started_at": null,
      "completed_at": null,
      "outcomes": [],
      "strikes": [],
      "bc_satisfied": [],
      "artifacts": {
        "files_created": [],
        "files_modified": [],
        "commands_run": []
      }
    }
  ],
  "learnings": [],
  "error_log": []
}
```

One phase stub per `TaskList.phases[].id`. Use the atomic write pattern (`state.json.tmp` → `mv`).

## Session Update

Update `session.json`:

- `active_skill: "work-implementation"`
- `last_checkpoint_at: <ISO 8601 timestamp>`
- `baseline_hash: <computed-above>`

Atomic write (`session.json.tmp` → `mv`).

## Resume Path

If `state.json` already exists at the session directory:

1. **Do not overwrite `baseline.json`** — it is frozen.
2. **Re-verify the hash**: `shasum -a 256 baseline.json | awk '{print $1}'` must equal `session.json.baseline_hash`. Mismatch → halt with `"Baseline hash mismatch. The frozen baseline was mutated after work-start."` (work-review Phase 1.0 Check 0 catches this; work-implementation should also refuse to continue).
3. Read `state.json`; resume from the first phase whose `status != "completed"`.
4. Update `session.json.last_checkpoint_at` to now; `active_skill = "work-implementation"`.

## Format Validation on Load

When reading spec.json, findings.json, and context.md, sanity-check:

- **spec.json / findings.json**: `schema_version == 1`; structure parses with jq.
- **context.md**: optional read for research sidecar. If missing, log a warning under `state.learnings`: "context.md absent at session start."
- **session.json**: schema_version 1; active_skill is either null or one of the five valid skill names.

## Worktree Assessment

Advisory only. Recommend a worktree when:

- Plan modifies >10 files across phases (`jq '[.phases[].files[]] | unique | length' spec.json`)
- Plan has >3 phases
- Any phase's `files[]` touches high-risk paths (auth, payments, migrations)

Prompt the user before entering execution loop:

```
Ready to execute.

Scope: N files, M phases.

1. Current branch (Recommended for small changes)
2. Create worktree (Recommended for >10 files or high-risk paths)
```

If worktree: use native `git worktree add` and remind about dependency install and `/init`.
