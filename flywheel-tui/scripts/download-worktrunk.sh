#!/usr/bin/env bash
set -euo pipefail

VERSION="v0.33.0"
BASE_URL="https://github.com/max-sixty/worktrunk/releases/download/${VERSION}"
VENDOR_DIR="$(cd "$(dirname "$0")/.." && pwd)/bin/vendor"
TMP_DIR="$(mktemp -d)"

trap 'rm -rf "$TMP_DIR"' EXIT

# Map of vendored name -> GitHub asset name
declare -A TARGETS=(
  ["wt-darwin-arm64"]="worktrunk-aarch64-apple-darwin"
  ["wt-darwin-x64"]="worktrunk-x86_64-apple-darwin"
  ["wt-linux-x64"]="worktrunk-x86_64-unknown-linux-musl"
  ["wt-linux-arm64"]="worktrunk-aarch64-unknown-linux-musl"
)

mkdir -p "$VENDOR_DIR"

verify_checksum() {
  local file="$1"
  local expected_hash="$2"

  local actual_hash
  if command -v sha256sum &>/dev/null; then
    actual_hash="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum &>/dev/null; then
    actual_hash="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    echo "ERROR: No sha256 tool found" >&2
    return 1
  fi

  if [ "$actual_hash" != "$expected_hash" ]; then
    echo "ERROR: Checksum mismatch for $(basename "$file")" >&2
    echo "  Expected: $expected_hash" >&2
    echo "  Got:      $actual_hash" >&2
    return 1
  fi
}

for vendor_name in "${!TARGETS[@]}"; do
  asset="${TARGETS[$vendor_name]}"
  archive="${asset}.tar.xz"
  echo "Downloading ${archive}..."

  curl -sL "${BASE_URL}/${archive}" -o "${TMP_DIR}/${archive}"
  curl -sL "${BASE_URL}/${archive}.sha256" -o "${TMP_DIR}/${archive}.sha256"

  expected_hash="$(awk '{print $1}' "${TMP_DIR}/${archive}.sha256")"
  echo "  Verifying checksum..."
  verify_checksum "${TMP_DIR}/${archive}" "$expected_hash"
  echo "  Checksum OK"

  echo "  Extracting wt binary..."
  tar -xJf "${TMP_DIR}/${archive}" -C "$TMP_DIR"
  cp "${TMP_DIR}/${asset}/wt" "${VENDOR_DIR}/${vendor_name}"
  chmod +x "${VENDOR_DIR}/${vendor_name}"
  echo "  Installed ${vendor_name}"
  echo ""
done

echo "$VERSION" > "${VENDOR_DIR}/WORKTRUNK_VERSION"
echo "Done. Vendored worktrunk ${VERSION} for all platforms."
echo "Version file: ${VENDOR_DIR}/WORKTRUNK_VERSION"
