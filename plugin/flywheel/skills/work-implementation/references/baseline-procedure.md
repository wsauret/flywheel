# Baseline Procedure (D2)

`baseline.json` is a frozen copy of the TaskList taken at work-start. It is the reference point for every compliance check in work-review Phase 1.0. The frozen-ness is enforced by a SHA-256 hash stored in `session.json.baseline_hash`.

## Why a Hash Instead of Filesystem Immutability

The plugin runs against a user's repo; we cannot make the file actually read-only. Instead we pin the content: a stored hash makes mid-execution mutations detectable. This is the protocol rule per D2 — the file's content is the authoritative baseline; mid-execution edits are caught via the hash on the next check, not prevented.

## Procedure: Write Baseline (Phase 1)

Executed once per session by work-implementation Phase 1:

1. **Serialize the in-memory TaskList with `baseline_frozen_at`**:
   ```bash
   # Copy the TaskList (already in memory as jq object) and add the timestamp.
   jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + {baseline_frozen_at: $ts}' \
     "$SESSION_DIR/spec.json" \
     > "$SESSION_DIR/baseline.json.tmp"
   mv "$SESSION_DIR/baseline.json.tmp" "$SESSION_DIR/baseline.json"
   ```

2. **Validate against the baseline schema** (offline sanity check; ajv is dev-only per D8 so skip the runtime invocation; validate was covered in the schema-tests layer):
   ```bash
   # Optional sanity step — skipped at runtime, shown here for completeness.
   # bunx ajv-cli --validate-formats=false --spec=draft2020 \
   #   validate -s flywheel/schemas/baseline.schema.json \
   #            -d "$SESSION_DIR/baseline.json" \
   #            -r flywheel/schemas/task-list.schema.json
   ```

3. **Compute SHA-256 hash**:
   ```bash
   BASELINE_HASH=$(shasum -a 256 "$SESSION_DIR/baseline.json" | awk '{print $1}')
   ```
   `shasum -a 256` is macOS-native and available on Linux; `sha256sum` is Linux-native and available via coreutils on macOS. `shasum -a 256` is the portable form.

4. **Store the hash in session.json** (atomic write):
   ```bash
   jq --arg h "$BASELINE_HASH" '.baseline_hash = $h' \
     "$SESSION_DIR/session.json" \
     > "$SESSION_DIR/session.json.tmp"
   mv "$SESSION_DIR/session.json.tmp" "$SESSION_DIR/session.json"
   ```

After these four steps, `baseline.json` holds the frozen TaskList and `session.json.baseline_hash` is a 64-hex string. The baseline is now immutable for the remainder of the session.

## Protocol Rule: Baseline is Read-Only

From the moment `baseline_hash` is set, the skill **must not** overwrite `baseline.json`. Any subsequent execution path that recomputes baseline content is a protocol violation.

- If the user wants to change the plan mid-execution, they must re-run `/fly:work` (after editing `spec.json`). That fresh invocation writes a **new** `baseline.json`, updates `baseline_hash`, and resumes from `state.json` (resume logic is adaptive — it revalidates against the new baseline).
- There is no in-place baseline update. The on-disk representation is the hash key; mutating the file without updating the hash will fail work-review Phase 1.0 Check 0.

## Check 0: Hash Verification (work-review consumer)

work-review Phase 1.0 re-runs this predicate before every review:

```bash
COMPUTED=$(shasum -a 256 "$SESSION_DIR/baseline.json" | awk '{print $1}')
STORED=$(jq -r '.baseline_hash' "$SESSION_DIR/session.json")

if [ "$COMPUTED" != "$STORED" ]; then
  # P1 finding: baseline was mutated after work-start.
  # Subsequent compliance checks are meaningless until this is resolved.
  exit 1
fi
```

This catches:

- Manual edits to `baseline.json` (via editor, automation, or a rogue script).
- Filesystem corruption.
- Accidental re-run of an older work-implementation version that overwrites the baseline.

The hash does **not** catch:

- A user editing `spec.json` mid-execution. That's expected; `spec.json` is the evolving document. `baseline.json` stays pinned.

## Mid-Execution Plan Change

When the user realizes mid-execution that the plan needs to change:

1. Edit `spec.json` (the active document).
2. Re-run `/fly:work`.
3. Phase 0 resolves the session.
4. Phase 1 notices `baseline.json` already exists. **Re-verify the hash first**:
   - If hash matches: the baseline is still valid. Re-read spec.json, diff against baseline.json in-memory, and surface the deltas to the user (AskUserQuestion: "You changed spec.json after work started. Start over with a new baseline, or continue against the old one?").
   - If hash mismatches: the baseline was mutated. Halt and report — user needs to delete `baseline.json` manually to reset.

An alternative procedure (simpler but destroys context): the user deletes the session entirely (`rm -rf`), reruns `/fly:plan`, and starts fresh.

## Cost Analysis

- **Storage**: baseline.json is a full copy of spec.json. Typical spec.json is 1–5 KB. Duplicate cost is negligible.
- **Compute**: SHA-256 over <5 KB is microseconds. No perf impact.
- **Token**: zero; the hash is computed in bash, not by the LLM.

## Common Mistakes

- **Forgetting to compute the hash** — baseline.json exists but `session.json.baseline_hash` is null. Next Check 0 will log a P1 finding; fix: recompute and update session.json.
- **Recomputing the hash mid-execution** — Never. The stored hash is the baseline's identity; overwriting it with a new value defeats the entire mechanism.
- **Using `sha256sum` instead of `shasum -a 256`** — works on Linux, breaks on macOS. Always use `shasum -a 256` for portability.
- **Pretty-printing baseline.json** — `jq '.'` emits canonical formatting, which is fine. But do not re-run `jq` on the file after the hash is computed; any reformatting changes bytes and breaks the hash.

## Reference Tests

- `tests/work/baseline-hash.test.sh` — verifies hash format, stored-vs-computed match, and mutation detection.
- `tests/schemas/fixtures/baseline-valid.json` — a valid baseline fixture.
- `tests/schemas/fixtures/session-valid.json` — a session fixture with a `baseline_hash` value.
