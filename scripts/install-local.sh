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

case "$(uname -s)" in
  Darwin) PLATFORM="darwin" ;;
  Linux) PLATFORM="linux" ;;
  # Git Bash, MSYS2 and Cygwin all run on Windows and all stage the Windows
  # payload, whose installer is a PowerShell script rather than a shell one.
  MINGW*|MSYS*|CYGWIN*) PLATFORM="win32" ;;
  *)
    echo "Unsupported local install platform: $(uname -s)"
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
  *)
    echo "Unsupported local install architecture: $(uname -m)"
    exit 1
    ;;
esac

STAGING="$ROOT/dist/flywheel-$PLATFORM-$ARCH"

if [ "$PLATFORM" = "win32" ]; then
  INSTALLER="$STAGING/install.ps1"
else
  INSTALLER="$STAGING/install.sh"
fi

if [ ! -f "$INSTALLER" ]; then
  echo "Build succeeded but its installer was not staged: $INSTALLER"
  exit 1
fi

echo ""
echo "Installing from $STAGING..."
if [ "$PLATFORM" = "win32" ]; then
  # The installer is given a Windows path: it is read by PowerShell, which does
  # not resolve the shell's own mount points.
  pwsh -NoProfile -ExecutionPolicy Bypass -File "$(cd "$STAGING" && pwd -W)/install.ps1"
else
  "$INSTALLER"
fi
