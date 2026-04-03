#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# run-terminal-bench.sh -- Run the Flywheel harness against Terminal-Bench 2.0
#
# Usage:
#   ./bench/run-terminal-bench.sh                        # defaults: opus 4.6, 4 concurrent
#   ./bench/run-terminal-bench.sh --model claude-sonnet-4-6 --concurrency 8
#   ./bench/run-terminal-bench.sh --skip-prebuild        # skip Docker image pre-build
#   ./bench/run-terminal-bench.sh --tasks 5              # only run first N tasks
#
# Prerequisites:
#   - Docker running
#   - harbor CLI installed: uv tool install harbor
#   - ANTHROPIC_API_KEY set
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
MODEL="anthropic/claude-opus-4-6"
CONCURRENCY=4
DATASET="terminal-bench/terminal-bench-2"
SKIP_PREBUILD=false
N_TASKS=""
JOB_NAME=""
EXTRA_ARGS=()

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)       MODEL="$2"; shift 2 ;;
    --concurrency) CONCURRENCY="$2"; shift 2 ;;
    --dataset)     DATASET="$2"; shift 2 ;;
    --skip-prebuild) SKIP_PREBUILD=true; shift ;;
    --tasks)       N_TASKS="$2"; shift 2 ;;
    --job-name)    JOB_NAME="$2"; shift 2 ;;
    --help|-h)
      head -14 "$0" | tail -10
      exit 0
      ;;
    *)
      EXTRA_ARGS+=("$1"); shift ;;
  esac
done

# Validate
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Error: ANTHROPIC_API_KEY not set" >&2
  exit 1
fi

if ! command -v harbor &>/dev/null; then
  echo "Error: harbor CLI not found. Install with: uv tool install harbor" >&2
  exit 1
fi

if ! docker info &>/dev/null 2>&1; then
  echo "Error: Docker is not running" >&2
  exit 1
fi

# Derive job name from model if not set
if [ -z "$JOB_NAME" ]; then
  model_short="${MODEL##*/}"
  model_short="${model_short//\//-}"
  JOB_NAME="flywheel-${model_short}-$(date +%Y%m%d-%H%M%S)"
fi

JOBS_DIR="$REPO_ROOT/jobs"
TASK_CACHE="$HOME/.cache/harbor/tasks/packages/terminal-bench"
HARBOR_DOCKER_DIR="$(python3 -c "import harbor.environments.docker; import os; print(os.path.dirname(harbor.environments.docker.__file__))" 2>/dev/null || echo "")"

echo "================================================"
echo "  Flywheel Harness -- Terminal-Bench Runner"
echo "================================================"
echo "  Model:       $MODEL"
echo "  Concurrency: $CONCURRENCY"
echo "  Dataset:     $DATASET"
echo "  Job name:    $JOB_NAME"
echo "  Jobs dir:    $JOBS_DIR"
echo "================================================"

# ------------------------------------------------------------------
# Phase 1: Download all tasks
# ------------------------------------------------------------------
echo ""
echo "[1/3] Downloading tasks..."
harbor download "$DATASET" 2>&1 | tail -3

# ------------------------------------------------------------------
# Phase 2: Pre-build all Docker images (parallel)
# ------------------------------------------------------------------
if [ "$SKIP_PREBUILD" = false ]; then
  echo ""
  echo "[2/3] Pre-building Docker images (this is slow the first time)..."

  TASK_DIRS=()
  for task_dir in "$TASK_CACHE"/*/; do
    [ -d "$task_dir" ] || continue
    # Find the environment dir (hash subdir / environment / Dockerfile)
    env_dir=$(find "$task_dir" -maxdepth 3 -name "Dockerfile" -exec dirname {} \; 2>/dev/null | head -1)
    if [ -n "$env_dir" ]; then
      TASK_DIRS+=("$env_dir")
    fi
  done

  total=${#TASK_DIRS[@]}
  echo "  Found $total task environments to build"

  # Build images in parallel batches
  built=0
  failed=0
  pids=()
  dirs=()

  for env_dir in "${TASK_DIRS[@]}"; do
    task_name=$(basename "$(dirname "$(dirname "$env_dir")")")

    # Check if image already exists by looking for a docker-compose project
    # We just do a plain docker build of the Dockerfile
    (
      cd "$env_dir"
      tag="terminal-bench-${task_name}:latest"
      if docker image inspect "$tag" &>/dev/null 2>&1; then
        exit 0  # already built
      fi
      docker build -t "$tag" -q . >/dev/null 2>&1
    ) &
    pids+=($!)
    dirs+=("$task_name")

    # Limit parallelism
    if [ ${#pids[@]} -ge $((CONCURRENCY * 2)) ]; then
      for i in "${!pids[@]}"; do
        if wait "${pids[$i]}" 2>/dev/null; then
          built=$((built + 1))
        else
          failed=$((failed + 1))
          echo "    WARN: failed to build ${dirs[$i]}"
        fi
      done
      echo "  Progress: $((built + failed))/$total built ($failed failures)"
      pids=()
      dirs=()
    fi
  done

  # Wait for remaining
  for i in "${!pids[@]}"; do
    if wait "${pids[$i]}" 2>/dev/null; then
      built=$((built + 1))
    else
      failed=$((failed + 1))
      echo "    WARN: failed to build ${dirs[$i]}"
    fi
  done
  echo "  Pre-build complete: $built succeeded, $failed failed out of $total"
else
  echo ""
  echo "[2/3] Skipping pre-build (--skip-prebuild)"
fi

# ------------------------------------------------------------------
# Phase 3: Run the benchmark
# ------------------------------------------------------------------
echo ""
echo "[3/3] Running benchmark..."

HARBOR_ARGS=(
  -d "$DATASET"
  --agent-import-path "bench.flywheel_agent:FlywheelHarness"
  -m "$MODEL"
  -n "$CONCURRENCY"
  -k 1
  -y
  -o "$JOBS_DIR"
  --job-name "$JOB_NAME"
  --environment-build-timeout-multiplier 5.0
  --timeout-multiplier 2.0
)

if [ -n "$N_TASKS" ]; then
  HARBOR_ARGS+=(-l "$N_TASKS")
fi

HARBOR_ARGS+=("${EXTRA_ARGS[@]}")

echo "  Command: PYTHONPATH=$REPO_ROOT harbor run ${HARBOR_ARGS[*]}"
echo ""

export PYTHONPATH="$REPO_ROOT"
exec harbor run "${HARBOR_ARGS[@]}"
