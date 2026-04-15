#!/usr/bin/env bash
# Build the flywheel binary and install it locally in one shot.
# Runs build:binary, then executes the generated install.sh.
#
# Usage:
#   ./scripts/install-local.sh
#   FLYWHEEL_INSTALL_DIR=/usr/local/bin ./scripts/install-local.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

echo "Building binary..."
bun run --cwd "$ROOT" build:binary

# Find the staging directory (dist/flywheel-<platform>-<arch>/)
STAGING=$(find "$ROOT/dist" -maxdepth 1 -type d -name 'flywheel-*' | head -1)

if [ -z "$STAGING" ] || [ ! -f "$STAGING/install.sh" ]; then
  echo "Build succeeded but staging directory not found in dist/"
  exit 1
fi

echo ""
echo "Installing from $STAGING..."
"$STAGING/install.sh"
