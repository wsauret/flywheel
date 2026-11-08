#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

array_field() {
  local plan="$1" field="$2"
  python3 - "$plan" "$field" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1], encoding="utf-8"))[sys.argv[2]]
if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
    raise SystemExit(f"plan field {sys.argv[2]} is not a string array")
for item in value:
    sys.stdout.buffer.write(item.encode() + b"\0")
PY
}

scalar_field() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1], encoding="utf-8"))[sys.argv[2]]
if isinstance(value, (dict, list)):
    raise SystemExit(f"plan field {sys.argv[2]} is not scalar")
print(str(value).lower() if isinstance(value, bool) else value)
PY
}

has_field() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
print("true" if sys.argv[2] in json.load(open(sys.argv[1], encoding="utf-8")) else "false")
PY
}

PLAN=$(bun run "$SCRIPT_DIR/run-harbor.ts" prepare "$@")
DRY_RUN=$(scalar_field "$PLAN" dry_run)
echo "Campaign grade: $(scalar_field "$PLAN" grade)"
echo "Campaign warning: $(scalar_field "$PLAN" warning)"
echo "Auth profile: $(scalar_field "$PLAN" auth_profile)"
echo "Packaged Flywheel commit: $(scalar_field "$PLAN" source_commit)"
python3 - "$PLAN" <<'PY2'
import json
import sys
package = json.load(open(sys.argv[1], encoding="utf-8"))["agent_package"]
print(f"Agent package: {package['repository']} {package['ref']} at {package['commit']}")
PY2
if [ "$(scalar_field "$PLAN" execution_mode)" = hosted ]; then
  echo "Preparation plan: $PLAN"
  set +e
  bun run "$SCRIPT_DIR/run-harbor.ts" run-hosted "$PLAN"
  HOSTED_EXIT=$?
  set -e
  exit "$HOSTED_EXIT"
fi
if [ "$DRY_RUN" = true ]; then
  echo "Preparation plan: $PLAN"
  exit 0
fi

DOWNLOAD_COMMAND=()
while IFS= read -r -d '' item; do DOWNLOAD_COMMAND+=("$item"); done < <(array_field "$PLAN" download_command)
"${DOWNLOAD_COMMAND[@]}"

PREBUILD=$(scalar_field "$PLAN" prebuild)
if [ "$PREBUILD" = true ]; then
  CONCURRENCY=$(scalar_field "$PLAN" concurrency)
  TASK_NAMES=()
  while IFS= read -r -d '' item; do TASK_NAMES+=("$item"); done < <(array_field "$PLAN" task_names)
  TASK_CACHE=$(scalar_field "$PLAN" task_cache)
  pids=()
  for task_ref in "${TASK_NAMES[@]}"; do
    task_name="${task_ref##*/}"
    task_namespace="${task_ref%%/*}"
    environment=$(find "$TASK_CACHE/$task_name" -maxdepth 4 -name Dockerfile -print -quit)
    if [ -z "$environment" ]; then
      echo "Missing Dockerfile for $task_ref" >&2
      exit 1
    fi
    environment="$(dirname "$environment")"
    (cd "$environment" && docker build -t "$task_namespace-$task_name:latest" .) &
    pids+=("$!")
    if [ "${#pids[@]}" -ge "$CONCURRENCY" ]; then
      for pid in "${pids[@]}"; do wait "$pid"; done
      pids=()
    fi
  done
  for pid in "${pids[@]}"; do wait "$pid"; done
fi

# Only a benchmark that seals its verifier dependencies has a wheelhouse step.
if [ "$(has_field "$PLAN" wheelhouse_command)" = true ]; then
  WHEELHOUSE_COMMAND=()
  while IFS= read -r -d '' item; do WHEELHOUSE_COMMAND+=("$item"); done < <(array_field "$PLAN" wheelhouse_command)
  WHEELHOUSE=$("${WHEELHOUSE_COMMAND[@]}")
  bun run "$SCRIPT_DIR/run-harbor.ts" add-wheelhouse "$PLAN" "$WHEELHOUSE"
fi

set +e
bun run "$SCRIPT_DIR/run-harbor.ts" run-local "$PLAN"
LOCAL_EXIT=$?
set -e
exit "$LOCAL_EXIT"
