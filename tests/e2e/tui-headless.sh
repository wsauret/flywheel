#!/usr/bin/env bash
# Verify retired workflow-mode refusals without model requests.
#
# H-01: A description without a workflow refuses on stderr with exit 1.
# H-02: A description with a workflow refuses without launching the TUI.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$PROJECT_DIR/bin/flywheel"
OUTPUT_DIR="$(mktemp -d)"
trap 'rm -r "$OUTPUT_DIR"' EXIT

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

for case_id in H-01 H-02; do
  for format in text jsonl; do
    echo "$case_id: retired headless workflow mode ($format)"
    args=(--headless --description "hello")
    if [ "$case_id" = H-02 ]; then args+=(--workflow debug); fi
    if [ "$format" = jsonl ]; then args+=(--jsonl); fi
    set +e
    "$BIN" "${args[@]}" > "$OUTPUT_DIR/stdout" 2> "$OUTPUT_DIR/stderr"
    exit_code=$?
    set -e

    if [ "$exit_code" -eq 1 ]; then
      pass "$case_id $format exits 1"
    else
      fail "$case_id $format expected exit 1, got $exit_code"
    fi
    if grep -q "Headless workflow mode is retired" "$OUTPUT_DIR/stderr"; then
      pass "$case_id $format prints the retirement refusal"
    else
      fail "$case_id $format does not print the retirement refusal"
    fi
    if [ ! -s "$OUTPUT_DIR/stdout" ]; then
      pass "$case_id $format leaves stdout empty"
    else
      fail "$case_id $format writes to stdout"
    fi
    if grep -Fq $'\e[?1049h' "$OUTPUT_DIR/stdout" "$OUTPUT_DIR/stderr"; then
      fail "$case_id $format launches the TUI"
    else
      pass "$case_id $format does not launch the TUI"
    fi
  done
done

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
