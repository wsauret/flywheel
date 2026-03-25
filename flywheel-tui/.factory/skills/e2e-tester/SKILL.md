---
name: e2e-tester
description: Runs end-to-end pipeline tests via tmux with zero-tolerance for errors
---

# E2E Tester

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Features requiring end-to-end validation of the Flywheel pipeline via tmux. You are testing that EVERYTHING works — not just features you added, but the entire pipeline end to end. Zero tolerance for errors.

## Required Skills

None. This worker uses tmux directly per the project's AGENTS.md testing instructions.

## ZERO TOLERANCE POLICY

You are NOT an observer. You are a quality enforcer. If ANYTHING goes wrong during the E2E run — ANY error in the log, ANY handoff that fails to parse, ANY warning that indicates a bug, ANY state transition error, ANY degraded fallback — it is a BLOCKING issue. Do NOT dismiss problems as "unrelated", "pre-existing", "review-stage issue", or "not a failure of the quality systems being tested." EVERYTHING is being tested. Report every single problem as a blocking discoveredIssue with root cause analysis and a concrete suggestedFix.

The run is not done until it is FLAWLESS.

## Work Procedure

### 1. Understand the Test Objectives

Read the feature description carefully. Read `AGENTS.md` in the mission directory and the project root `AGENTS.md` for tmux testing instructions. Every expectedBehavior item must pass with zero exceptions.

### 2. Prepare Test Environment

```bash
# Clean slate
rm -rf /tmp/flywheel-e2e-test /tmp/e2e-evidence
mkdir -p /tmp/flywheel-e2e-test /tmp/e2e-evidence

# Create simple test project
cd /tmp/flywheel-e2e-test
git init
cat > hello.py << 'EOF'
def hello(name):
    return f"Hello, {name}!"

if __name__ == "__main__":
    print(hello("World"))
EOF
git add . && git commit -m "initial"
```

- Ensure the Flywheel binary is available at `bin/flywheel`
- Create a `flywheel.toml` config with commands section (test, typecheck if applicable)

### 3. Run the Pipeline via tmux

```bash
tmux kill-session -t flywheel-e2e 2>/dev/null
tmux new-session -d -s flywheel-e2e -x 120 -y 40 \
  'cd /Users/wsauret/Documents/GitHub/flywheel/flywheel-tui && FLYWHEEL_PROJECT_CWD=/tmp/flywheel-e2e-test bin/flywheel'
sleep 3
tmux capture-pane -t flywheel-e2e -p > /tmp/e2e-evidence/01-idle.txt

tmux send-keys -t flywheel-e2e '/start implement a simple python hello world function' Enter
sleep 2
# Select plan+work+review mode
tmux send-keys -t flywheel-e2e '3'
sleep 5
```

### 4. Monitor and Capture Evidence

Capture screen at EVERY transition. Poll every 30-60 seconds. Save ALL evidence.

### 5. Post-Run Verification (EXHAUSTIVE)

After the pipeline completes, check EVERYTHING:

```bash
# 1. Log file — ZERO errors, ZERO bug-indicating warnings
LOG=$(ls -t /tmp/flywheel-e2e-test/.flywheel/log/*.log | head -1)
grep -E '^ERROR' "$LOG"        # Must be EMPTY
grep -E '^WARN' "$LOG"         # Review EVERY warning — any bug indicator is blocking

# 2. Handoff files — ALL must parse cleanly
for f in /tmp/flywheel-e2e-test/.flywheel/handoffs/*.json; do
  echo "=== $f ==="
  cat "$f" | python3 -c "import json,sys; json.load(sys.stdin); print('VALID JSON')"
done

# 3. Stage context — must exist with real data
cat /tmp/flywheel-e2e-test/.flywheel/stage-context.json

# 4. Validation contract — must exist with VAL-* IDs
cat /tmp/flywheel-e2e-test/.flywheel/plans/*.validation-contract.md 2>/dev/null || \
  cat /tmp/flywheel-e2e-test/validation-contract.md 2>/dev/null

# 5. Plan — must have ## Milestone: markers
grep '## Milestone:' /tmp/flywheel-e2e-test/.flywheel/plans/*.md 2>/dev/null

# 6. Validation phases — check state file for injection
cat /tmp/flywheel-e2e-test/.flywheel/plans/*.state.md 2>/dev/null

# 7. validation-state.json — must exist
cat /tmp/flywheel-e2e-test/validation-state.json 2>/dev/null || \
  cat /tmp/flywheel-e2e-test/.flywheel/validation-state.json 2>/dev/null
```

### 6. Assess Results with Zero Tolerance

For EACH check above:
- If it passes: record the evidence
- If it fails: diagnose WHY. Read source code if needed. Report as blocking discoveredIssue with:
  - Exact error/symptom
  - Root cause (which file, which function, what's wrong)
  - Concrete suggestedFix (what code change would fix it)

Do NOT:
- Say "this is unrelated to our changes"
- Say "this is a pre-existing issue"
- Say "this is cosmetic / non-blocking"
- Wave away any failure for any reason

### 7. Clean Up

```bash
tmux kill-session -t flywheel-e2e 2>/dev/null
# Keep /tmp/e2e-evidence for the handoff
```

## Example Handoff (PASSING)

```json
{
  "summary": "Full E2E pipeline completed flawlessly via tmux. Zero errors, zero warnings indicating bugs, all handoffs parsed cleanly, stage context accumulated from all phases, validation contract generated with 5 assertions, 2 milestone markers in plan, scrutiny validation auto-injected and executed, validation-state.json shows 5/5 passed.",
  "artifacts": {
    "files_created": ["/tmp/e2e-evidence/"],
    "files_modified": [],
    "commands_run": ["tmux commands", "evidence collection"]
  },
  "decisions": ["Used /start plan+work+review mode"],
  "warnings": [],
  "verification": {
    "tests_passed": true,
    "test_output_summary": "ALL 7 E2E assertions pass. Zero ERROR lines in log. Zero bug-indicating WARN lines. All handoffs valid JSON. Stage context has cumulative data from 6 phases. validation-contract.md has 5 VAL-* assertions. Plan has 2 milestones. Scrutiny phase auto-injected. validation-state.json exists with results."
  },
  "files_to_review": [],
  "discoveredIssues": []
}
```

## Example Handoff (FAILING — correct behavior)

```json
{
  "summary": "E2E pipeline completed but with 3 blocking issues. Log shows 2 ERROR lines (state transition failure, handoff parse error). Stage context missing work-phase data due to handoff schema mismatch.",
  "discoveredIssues": [
    {
      "severity": "blocking",
      "description": "ERROR in log: Invalid state transition new -> work:paused at pipeline completion. Root cause: session-orchestrator.ts line 142 calls pauseSession() without first transitioning through plan:imported -> plan:approved -> work:active.",
      "suggestedFix": "In session-orchestrator.ts, add proper state transitions before pauseSession() call, or guard the pause with a state check."
    },
    {
      "severity": "blocking",
      "description": "WARN: handoff invalid for work phase 2 — artifacts.files_created Required. Causes stage context to lose all structured data for that phase. Root cause: WorkerHandoffSchema requires files_created but worker only modified files.",
      "suggestedFix": "Make files_created optional in ArtifactsSchema in src/schemas/handoff.ts."
    }
  ]
}
```

## When to Return to Orchestrator

- The Flywheel TUI crashes on startup (environment issue)
- The pipeline hangs for more than 20 minutes on a single phase
- API key or engine binary is not available
- You have identified blocking issues that need code fixes before re-running
