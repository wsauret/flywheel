#!/usr/bin/env bash
set -euo pipefail

VENDOR_DIR="$(cd "$(dirname "$0")/.." && pwd)/bin/vendor"
VERSION_FILE="${VENDOR_DIR}/WORKTRUNK_VERSION"
DOWNLOAD_SCRIPT="$(cd "$(dirname "$0")" && pwd)/download-worktrunk.sh"

get_latest_version() {
  curl -sL "https://api.github.com/repos/max-sixty/worktrunk/releases/latest" \
    | grep '"tag_name"' \
    | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/'
}

# Accept version as argument or fetch latest
if [ $# -ge 1 ]; then
  NEW_VERSION="$1"
else
  echo "Fetching latest version from GitHub..."
  NEW_VERSION="$(get_latest_version)"
  if [ -z "$NEW_VERSION" ]; then
    echo "ERROR: Could not determine latest version" >&2
    exit 1
  fi
fi

# Show current version
if [ -f "$VERSION_FILE" ]; then
  CURRENT_VERSION="$(cat "$VERSION_FILE")"
  echo "Current version: ${CURRENT_VERSION}"
else
  CURRENT_VERSION="(none)"
  echo "No current version found"
fi

echo "New version:     ${NEW_VERSION}"

if [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
  echo "Already at ${NEW_VERSION}. Nothing to do."
  exit 0
fi

# Update VERSION in the download script and run it
sed -i.bak "s/^VERSION=\".*\"/VERSION=\"${NEW_VERSION}\"/" "$DOWNLOAD_SCRIPT"
rm -f "${DOWNLOAD_SCRIPT}.bak"

echo ""
echo "Running download script for ${NEW_VERSION}..."
bash "$DOWNLOAD_SCRIPT"

echo ""
echo "=== Update Summary ==="
echo "  ${CURRENT_VERSION} -> ${NEW_VERSION}"
echo ""
echo "Files updated:"
echo "  scripts/download-worktrunk.sh (VERSION variable)"
echo "  bin/vendor/WORKTRUNK_VERSION"
echo "  bin/vendor/wt-darwin-arm64"
echo "  bin/vendor/wt-darwin-x64"
echo "  bin/vendor/wt-linux-arm64"
echo "  bin/vendor/wt-linux-x64"
