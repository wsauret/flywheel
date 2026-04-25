# Shared pass/fail accounting + tiny assertion vocab.
# Source from each test case; expects $pass and $fail in caller scope.

note_pass() { echo "PASS: $1"; pass=$((pass + 1)); }
note_fail() { echo "FAIL: $1"; fail=$((fail + 1)); }

# Print pass/fail tally and exit non-zero on any failure.
finalize() {
  echo ""
  echo "Summary: $pass passed, $fail failed."
  [ "$fail" = "0" ] && exit 0 || exit 1
}
