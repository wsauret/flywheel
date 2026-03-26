#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  bun install
fi

# Verify bun and typecheck work
bun --version > /dev/null 2>&1 || { echo "ERROR: bun not found"; exit 1; }
