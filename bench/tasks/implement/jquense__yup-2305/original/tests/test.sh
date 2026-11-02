#!/bin/bash

cd /app/src

# Copy HEAD test files from /tests (overwrites BASE state)
mkdir -p "test"
cp "/tests/array.ts" "test/array.ts"
mkdir -p "test"
cp "/tests/tuple.ts" "test/tuple.ts"

# Run the specific test files with Jest
yarn testonly test/array.ts test/tuple.ts
test_status=$?

if [ $test_status -eq 0 ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
exit "$test_status"
