#!/usr/bin/env bash
# E2E: slug prefix-scan + collision-suffix integration test.
#
# Usage: bash tests/e2e/slug-scan.test.sh
#
# Per Phase 5 T5.4: simulates the Phase 0 slug-arg tiebreak logic documented
# in flywheel/skills/work-implementation/references/session-detection.md.
#
# Scenarios:
#   1. Three sessions share slug 'myfeat' across three dates. Prefix-scan with
#      arg='myfeat' should return the lexically-greatest (most recent ISO date).
#   2. Same slug on the same date collides → suffix appends -2, then -3.
#   3. Slug with zero matches → error path.
#   4. Slug with exactly one match → that session wins immediately.
#
# We exercise the same bash/find/sort logic the SKILL.md prescribes. No
# skill is invoked; this is a mechanical check of the resolution rules.
#
# Safety: uses a dedicated temp sessions directory so it never touches
# real .flywheel/plugin/sessions/. No active.json interaction.
#
# Exits 0 on success, 1 on any assertion failure.

set -u

pass=0
fail=0

note_pass() { echo "PASS: $1"; pass=$((pass + 1)); }
note_fail() { echo "FAIL: $1"; fail=$((fail + 1)); }

# Sandbox — the scan helper does not touch the real repo state.
tmpdir=$(mktemp -d -t slug_scan_XXXXXX)
trap 'rm -rf "$tmpdir"' EXIT
SESSIONS="$tmpdir/.flywheel/plugin/sessions"
mkdir -p "$SESSIONS"

# ---- resolve_slug: the shared helper (mirrors session-detection.md) --------
# Contract:
#   arg1: slug (e.g. 'myfeat')
#   arg2: sessions directory
#   stdout: resolved session_id (dir name) on success
#   exit 0 on success; 1 on zero matches
resolve_slug() {
  local slug="$1"
  local sessions_dir="$2"
  # Prefix-scan: collect dirs whose name starts with `<slug>-`.
  local matches
  matches=$(find "$sessions_dir" -maxdepth 1 -type d -name "${slug}-*" \
            | sort -r)
  if [ -z "$matches" ]; then
    return 1
  fi
  # Take first (lexically-greatest). basename to strip path.
  basename "$(echo "$matches" | head -n 1)"
}

# ---- next_session_id: collision-suffix helper -----------------------------
# Contract:
#   arg1: slug
#   arg2: date (YYYY-MM-DD)
#   arg3: sessions dir
#   stdout: free session id (<slug>-<date> OR <slug>-<date>-N)
next_session_id() {
  local slug="$1"
  local date="$2"
  local sessions_dir="$3"
  local base="$slug-$date"
  if [ ! -d "$sessions_dir/$base" ]; then
    echo "$base"
    return 0
  fi
  # Collision — find the next free -N.
  local n=2
  while [ -d "$sessions_dir/$base-$n" ]; do
    n=$((n + 1))
  done
  echo "$base-$n"
}

# ---- Scenario 1: three sessions with same slug, different dates ----------
mkdir -p "$SESSIONS/myfeat-2026-04-20"
mkdir -p "$SESSIONS/myfeat-2026-04-21"
mkdir -p "$SESSIONS/myfeat-2026-04-22"

winner=$(resolve_slug "myfeat" "$SESSIONS")
if [ "$winner" = "myfeat-2026-04-22" ]; then
  note_pass "slug tiebreak: lexical-desc sort picks most recent (myfeat-2026-04-22)"
else
  note_fail "slug tiebreak: expected myfeat-2026-04-22, got '$winner'"
fi

# ---- Scenario 2: ensure sort stability when inserting an older session ----
# Add an even older session; winner should still be 2026-04-22.
mkdir -p "$SESSIONS/myfeat-2026-03-01"
winner=$(resolve_slug "myfeat" "$SESSIONS")
if [ "$winner" = "myfeat-2026-04-22" ]; then
  note_pass "slug tiebreak: adding older session leaves winner unchanged"
else
  note_fail "slug tiebreak: older session perturbed winner: got '$winner'"
fi

# ---- Scenario 3: zero matches → error path --------------------------------
if resolve_slug "nosuchslug" "$SESSIONS" >/dev/null 2>&1; then
  note_fail "slug zero-match: expected failure, got success"
else
  note_pass "slug zero-match: returns non-zero exit (error path)"
fi

# ---- Scenario 4: exactly one match ---------------------------------------
mkdir -p "$SESSIONS/soloflight-2026-04-15"
winner=$(resolve_slug "soloflight" "$SESSIONS")
if [ "$winner" = "soloflight-2026-04-15" ]; then
  note_pass "slug one-match: returns the sole match"
else
  note_fail "slug one-match: expected soloflight-2026-04-15, got '$winner'"
fi

# ---- Scenario 5: collision-suffix rules ----------------------------------
# New slug 'clash' on 2026-04-22 — no collision yet.
next=$(next_session_id "clash" "2026-04-22" "$SESSIONS")
if [ "$next" = "clash-2026-04-22" ]; then
  note_pass "collision-suffix: no prior session → base form used"
else
  note_fail "collision-suffix: expected clash-2026-04-22, got '$next'"
fi

# Create that dir; next collision-suffix should be -2.
mkdir -p "$SESSIONS/clash-2026-04-22"
next=$(next_session_id "clash" "2026-04-22" "$SESSIONS")
if [ "$next" = "clash-2026-04-22-2" ]; then
  note_pass "collision-suffix: one collision → -2 suffix"
else
  note_fail "collision-suffix: expected clash-2026-04-22-2, got '$next'"
fi

# Now also create the -2 collision; next should be -3.
mkdir -p "$SESSIONS/clash-2026-04-22-2"
next=$(next_session_id "clash" "2026-04-22" "$SESSIONS")
if [ "$next" = "clash-2026-04-22-3" ]; then
  note_pass "collision-suffix: two collisions → -3 suffix"
else
  note_fail "collision-suffix: expected clash-2026-04-22-3, got '$next'"
fi

# ---- Scenario 6: resolve_slug handles -N suffixes correctly --------------
# After the clash- setup, 'clash' should resolve to the one with the largest -N
# (since lexical sort treats '-2' > '' and '-N' sort is stable within a date).
# Specifically: dir names are "clash-2026-04-22" and "clash-2026-04-22-2".
# Lexical sort-r ranks "clash-2026-04-22-2" above "clash-2026-04-22" — which
# is actually the desired outcome (the -2 is the most-recently-assigned session).
winner=$(resolve_slug "clash" "$SESSIONS")
if [ "$winner" = "clash-2026-04-22-2" ]; then
  note_pass "slug tiebreak handles -N suffix: clash-2026-04-22-2 wins over clash-2026-04-22"
else
  note_fail "slug tiebreak with -N: expected clash-2026-04-22-2, got '$winner'"
fi

# ---- Scenario 7: slug is a prefix of another slug — prefix-scan uses -
# separator, so 'feat' must NOT match 'feature-x-2026-04-23'.
mkdir -p "$SESSIONS/feature-x-2026-04-23"
if resolve_slug "feat" "$SESSIONS" >/dev/null 2>&1; then
  # It matched SOMETHING; confirm it's not 'feature-x' (it shouldn't be since
  # the pattern is 'feat-*' not 'feat*').
  winner=$(resolve_slug "feat" "$SESSIONS")
  if [ "$winner" = "feature-x-2026-04-23" ]; then
    note_fail "slug prefix discipline: 'feat' matched 'feature-x' — pattern should be 'feat-*' (hyphen bound)"
  else
    note_pass "slug prefix discipline: 'feat' did not match 'feature-x-...' (hyphen separator respected)"
  fi
else
  note_pass "slug prefix discipline: 'feat' has zero matches (feature-x is not a feat-* match)"
fi

echo ""
echo "Summary: $pass passed, $fail failed."
[ "$fail" = "0" ] && exit 0 || exit 1
