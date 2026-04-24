#!/usr/bin/env bash
# Baseline SHA-256 hash immutability test.
#
# Usage: bash tests/work/baseline-hash.test.sh
#
# Per D2: baseline.json is a full copy of spec.json + baseline_frozen_at,
# written once by work-implementation Phase 1. The session.json.baseline_hash
# is the SHA-256 of baseline.json, computed at write time. If baseline.json
# is mutated after work-start, the hash in session.json no longer matches —
# this is what work-review Phase 1.0 Check 0 detects (P1 finding "baseline
# was mutated after work-start").
#
# This test validates the mechanic at the shell layer (portable: mac's
# `shasum -a 256` and linux's `sha256sum` produce the same hex digest):
#
#   1. Hash format is 64 hex characters (SHA-256 output)
#   2. The hash in session-with-hash.json matches a fresh recompute of
#      baseline-test.json (immutability baseline)
#   3. Mutating baseline (even whitespace) changes the hash, so a stored
#      hash in session.json catches the mutation
#
# Exits 0 on success, 1 on any assertion failure.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIX="$REPO_ROOT/tests/work/fixtures"

pass=0
fail=0

note_pass() { echo "PASS: $1"; pass=$((pass + 1)); }
note_fail() { echo "FAIL: $1"; fail=$((fail + 1)); }

# Portable hasher: shasum is on mac natively and linux installs
# coreutils-equivalent. Outputs "<hash>  <filename>", we take the first field.
hash_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}

# -----------------------------------------------------------------------------
# Test 1: hash format is 64 hex characters
# -----------------------------------------------------------------------------
computed=$(hash_of "$FIX/baseline-test.json")
if [[ "$computed" =~ ^[a-f0-9]{64}$ ]]; then
  note_pass "hash format is 64-char lowercase hex: $computed"
else
  note_fail "hash '$computed' is not 64-char lowercase hex"
fi

# -----------------------------------------------------------------------------
# Test 2: stored hash in session-with-hash.json matches the computed hash
# -----------------------------------------------------------------------------
stored=$(jq -r '.baseline_hash' "$FIX/session-with-hash.json")
if [ "$stored" = "$computed" ]; then
  note_pass "session.json.baseline_hash matches fresh sha256 of baseline-test.json"
else
  note_fail "stored hash ($stored) != computed hash ($computed)"
  echo "If you edited baseline-test.json, update session-with-hash.json too."
fi

# -----------------------------------------------------------------------------
# Test 3: mutating baseline (even whitespace) produces a different hash
# (this simulates the work-review Phase 1.0 Check 0 detection logic)
# -----------------------------------------------------------------------------
mutated_tmp=$(mktemp -t baseline_mutated_XXXXXX.json)
trap 'rm -f "$mutated_tmp"' EXIT

# Copy + append a trailing whitespace change (won't affect JSON semantics but
# changes the bytes).
cp "$FIX/baseline-test.json" "$mutated_tmp"
printf '\n' >> "$mutated_tmp"

mutated_hash=$(hash_of "$mutated_tmp")

if [ "$mutated_hash" != "$computed" ]; then
  note_pass "mutated baseline hash ($mutated_hash) differs from original ($computed)"
else
  note_fail "mutation did not change hash — hashing is not catching byte-level changes"
fi

# -----------------------------------------------------------------------------
# Test 4: the mismatch-detection predicate is shell-verifiable
# (this is the predicate work-review Phase 1.0 Check 0 runs)
# -----------------------------------------------------------------------------
if [ "$(hash_of "$mutated_tmp")" != "$stored" ]; then
  note_pass "Check 0 predicate: hash(baseline.json) != session.baseline_hash detects mutation"
else
  note_fail "Check 0 predicate failed to detect the mutation"
fi

echo ""
echo "Summary: $pass passed, $fail failed."
[ "$fail" = "0" ] && exit 0 || exit 1
