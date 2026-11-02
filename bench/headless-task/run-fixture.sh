#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# run-fixture.sh -- Cost baseline for `flywheel --headless --task`.
#
# Runs one Terminal-Bench 2.1 task against the installed flywheel binary,
# verifies the result with the task's own tests, and records the run's usage
# summary (turns, tokens, cost).
#
# Task assets are downloaded at run time and cached under .cache/; they carry
# the Terminal-Bench canary string and must never be committed to this repo.
#
# Usage:
#   bun run install:local                       # install the binary under test
#   ./bench/headless-task/run-fixture.sh --name <profile> \
#     [--task cancel-async-tasks|log-summary-date-ranges] [--repeat N]
#   FLYWHEEL_CHAT_MODEL=gpt-6-luna FLYWHEEL_CHAT_EFFORT=max \
#     ./bench/headless-task/run-fixture.sh --name luna-max-baseline
#
# Every run writes a record to records/<profile>/ with the run's usage,
# termination, and self-reported report (model, effort, tool surfaces), plus
# the verifier outcome and wall time. Records are local run output and are
# gitignored.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CACHE_DIR="$SCRIPT_DIR/.cache"
TB_BASE="https://raw.githubusercontent.com/harbor-framework/terminal-bench-2-1/main/tasks"

PROFILE_NAME="default"
TASK_NAME="cancel-async-tasks"
REPEAT=1
while [ $# -gt 0 ]; do
  case "$1" in
    --name)   PROFILE_NAME="$2"; shift 2 ;;
    --task)   TASK_NAME="$2"; shift 2 ;;
    --repeat) REPEAT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Per-task contract: which assets to fetch, how to seed the workspace, the
# instruction rewrite (tasks name /app paths; the fixture runs in a mktemp
# workspace instead), and how to verify. Verifier files are rewritten into
# the workspace, never in the cache.
case "$TASK_NAME" in
  cancel-async-tasks)
    ASSETS="instruction.md tests/test.py tests/test_outputs.py"
    ;;
  log-summary-date-ranges)
    ASSETS="instruction.md tests/test_outputs.py environment/log_generator_deterministic.py"
    ;;
  *) echo "Unknown task: $TASK_NAME" >&2; exit 1 ;;
esac

TASK_CACHE="$CACHE_DIR/$TASK_NAME"
mkdir -p "$TASK_CACHE"
for asset in $ASSETS; do
  target="$TASK_CACHE/$(basename "$asset")"
  [ -f "$target" ] || curl -sfL "$TB_BASE/$TASK_NAME/$asset" -o "$target"
done

task_text() {
  case "$TASK_NAME" in
    cancel-async-tasks)
      sed 's|`/app/run.py`|`run.py` in the current working directory|' "$TASK_CACHE/instruction.md"
      ;;
    log-summary-date-ranges)
      sed -e 's|/app/logs|the logs directory in the current working directory|g' \
          -e 's|/app/summary.csv|summary.csv in the current working directory|g' \
          "$TASK_CACHE/instruction.md"
      ;;
  esac
}

seed_workspace() {
  local workspace="$1"
  case "$TASK_NAME" in
    log-summary-date-ranges)
      # The generator hardcodes /app/logs; point it at the workspace instead.
      sed "s|^output_dir = .*|output_dir = \"$workspace/logs\"|" \
        "$TASK_CACHE/log_generator_deterministic.py" > "$workspace/.generate-logs.py"
      "$CACHE_DIR/venv/bin/python" "$workspace/.generate-logs.py"
      rm "$workspace/.generate-logs.py"
      ;;
  esac
}

run_verifier() {
  local workspace="$1"
  case "$TASK_NAME" in
    cancel-async-tasks)
      cp "$TASK_CACHE/test.py" "$TASK_CACHE/test_outputs.py" "$workspace/"
      (cd "$workspace" && PATH="$CACHE_DIR/venv/bin:$PATH" pytest test_outputs.py -q -k "not run_py_file_exists" -p no:cacheprovider)
      ;;
    log-summary-date-ranges)
      sed "s|Path(\"/app/summary.csv\")|Path(\"$workspace/summary.csv\")|" \
        "$TASK_CACHE/test_outputs.py" > "$workspace/test_outputs.py"
      (cd "$workspace" && PATH="$CACHE_DIR/venv/bin:$PATH" pytest test_outputs.py -q -p no:cacheprovider)
      ;;
  esac
}

if [ ! -d "$CACHE_DIR/venv" ]; then
  python3 -m venv "$CACHE_DIR/venv"
  "$CACHE_DIR/venv/bin/pip" -q install pytest
fi

run_once() {
  local attempt="$1"
  local workspace
  workspace="$(mktemp -d -t flywheel-headless-task)"
  seed_workspace "$workspace"

  echo "=== run $attempt/$REPEAT (task: $TASK_NAME, profile: $PROFILE_NAME, workspace: $workspace)"
  local start elapsed run_exit verify_exit
  start=$(date +%s)
  set +e
  (cd "$workspace" && FLYWHEEL_PROJECT_ROOT="$workspace" flywheel --headless --task "$TASK_TEXT" | tee "$workspace/run-output.log")
  run_exit=$?
  set -e
  elapsed=$(( $(date +%s) - start ))

  echo "=== verifier"
  set +e
  run_verifier "$workspace"
  verify_exit=$?
  set -e

  local record_dir="$SCRIPT_DIR/records/$PROFILE_NAME"
  mkdir -p "$record_dir"
  local record="$record_dir/$(date -u +%Y%m%dT%H%M%SZ)-$attempt.json"
  SUMMARY="$(tail -1 "$workspace/run-output.log")" \
  TASK_NAME="$TASK_NAME" RUN_EXIT="$run_exit" VERIFY_EXIT="$verify_exit" WALL="$elapsed" \
    bun -e 'const s=JSON.parse(process.env.SUMMARY ?? "{}"); delete s.projectRoot; console.log(JSON.stringify({task:process.env.TASK_NAME,recordedAt:new Date().toISOString(),runExit:+(process.env.RUN_EXIT??1),verifyExit:+(process.env.VERIFY_EXIT??1),wallSeconds:+(process.env.WALL??0),...s},null,2))' > "$record"

  echo "=== result ($record)"
  cat "$record"
  rm -rf "$workspace"
}

TASK_TEXT="$(task_text)"

# Task/verifier outcomes live in the records; the exit status reports only
# fixture infrastructure failures (set -e), so multi-task chains keep going.
for attempt in $(seq 1 "$REPEAT"); do
  run_once "$attempt"
done