---
name: e2e-tester
description: Runs end-to-end pipeline tests via tmux, collecting evidence that all quality gates fire correctly
---

# E2E Tester

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Features requiring end-to-end validation of the Flywheel pipeline via tmux. Tests that the full system works together — plan generation, work execution, handoff data flow, validation injection, and quality gates.

## Required Skills

None. This worker uses tmux directly per the project's AGENTS.md testing instructions.

## Work Procedure

### 1. Understand the Test Objectives

Read the feature description carefully. Read `AGENTS.md` in the mission directory and the project root `AGENTS.md` for tmux testing instructions. Understand what evidence must be collected.

### 2. Prepare Test Environment

- Create a simple test project directory (e.g., `/tmp/flywheel-e2e-test/`)
- Initialize it as a git repo with a simple task (e.g., a Python hello world function)
- Create a `flywheel.toml` config if needed
- Ensure the Flywheel binary is available at `bin/flywheel`

### 3. Run the Pipeline via tmux

Follow the tmux testing pattern from project root AGENTS.md:

```bash
# Kill any stale session
tmux kill-session -t flywheel-e2e 2>/dev/null

# Start Flywheel in tmux targeting the test project
tmux new-session -d -s flywheel-e2e -x 120 -y 40 \
  'cd /Users/wsauret/Documents/GitHub/flywheel/flywheel-tui && FLYWHEEL_PROJECT_CWD=/tmp/flywheel-e2e-test bin/flywheel'
sleep 3

# Capture initial screen
tmux capture-pane -t flywheel-e2e -p > /tmp/e2e-evidence/01-idle.txt

# Start pipeline with /start
tmux send-keys -t flywheel-e2e '/start implement a simple python hello world function' Enter
sleep 2

# Select pipeline mode (plan + work + review)
tmux send-keys -t flywheel-e2e '3'
sleep 5
```

### 4. Monitor and Capture Evidence

At each key transition point, capture the screen and relevant files:

```bash
# Capture screen periodically
tmux capture-pane -t flywheel-e2e -p > /tmp/e2e-evidence/02-working.txt

# After plan stage:
# - Check for validation-contract.md
# - Check for milestone markers in plan
# - Capture plan file content

# After work stage:
# - Check handoff files for widened projections
# - Check for stage-context.json
# - Check .flywheel/library/ for writes

# After review/validation:
# - Check for validation-state.json
# - Check state file for validation phase entries
# - Check log file for ERROR lines
```

### 5. Collect File Evidence

After the pipeline completes (or at key checkpoints):

```bash
# Check handoff files
ls -la /tmp/flywheel-e2e-test/.flywheel/handoffs/
cat /tmp/flywheel-e2e-test/.flywheel/handoffs/*.json | head -100

# Check stage context
cat /tmp/flywheel-e2e-test/.flywheel/stage-context.json 2>/dev/null

# Check validation contract
cat /tmp/flywheel-e2e-test/validation-contract.md 2>/dev/null

# Check validation state
cat /tmp/flywheel-e2e-test/validation-state.json 2>/dev/null

# Check library
ls /tmp/flywheel-e2e-test/.flywheel/library/ 2>/dev/null

# Check log for errors
ls -t /tmp/flywheel-e2e-test/.flywheel/log/*.log 2>/dev/null | head -1 | xargs grep -E '^(ERROR|WARN)' 2>/dev/null
```

### 6. Verify All Quality Systems Fired

For each E2E assertion in the validation contract:
- Check the specific evidence file/output
- Record pass/fail with specific observations
- If something didn't fire, check the log file for why

### 7. Clean Up

```bash
tmux kill-session -t flywheel-e2e 2>/dev/null
rm -rf /tmp/flywheel-e2e-test
```

## Example Handoff

```json
{
  "summary": "Ran full Flywheel pipeline E2E via tmux on a Python hello-world project. Pipeline completed plan→work→review in 12 minutes. Verified handoff files contain widened projections, stage context accumulated across 3 phases, validation contract generated with 4 assertions, scrutiny validation phase auto-injected and executed. 6 of 7 E2E assertions passed; VAL-E2E-003 failed (stage context file missing).",
  "artifacts": {
    "files_created": ["/tmp/e2e-evidence/"],
    "files_modified": [],
    "commands_run": ["tmux various commands", "cat handoff files", "grep log files"]
  },
  "decisions": [
    "Used /start with plan+work+review mode for comprehensive coverage",
    "Set 30-minute timeout per user requirement"
  ],
  "warnings": ["Stage context file was not written to disk — appears to be in-memory only"],
  "verification": {
    "tests_passed": true,
    "test_output_summary": "E2E pipeline completed. 6/7 assertions verified: handoff widening confirmed, validation contract generated, milestone markers present, validation phases injected, validation-state.json created. Stage context persistence failed."
  },
  "files_to_review": [],
  "skillFeedback": {
    "followedProcedure": true,
    "deviations": [],
    "suggestedChanges": ["Consider adding a script that automates the E2E evidence collection"]
  }
}
```

## When to Return to Orchestrator

- The Flywheel TUI crashes on startup (environment issue)
- The pipeline hangs for more than 15 minutes on a single phase
- API key or engine binary is not available
- Multiple E2E assertions fail, suggesting fundamental issues with the implementation
