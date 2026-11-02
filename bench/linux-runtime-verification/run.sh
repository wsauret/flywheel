#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
IMAGE=flywheel-linux-runtime-verification
CONTAINER="flywheel-linux-runtime-verification-$$"
ARCHIVE=$(mktemp "${TMPDIR:-/tmp}/flywheel-linux-runtime-verification.XXXXXX.tar.gz")

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -f "$ARCHIVE"
}
trap cleanup EXIT

if ! docker build -f "$ROOT/bench/linux-runtime-verification/Dockerfile" -t "$IMAGE" "$ROOT"; then
  exit 1
fi

COPYFILE_DISABLE=1 tar czf "$ARCHIVE" \
  --exclude='._*' \
  --exclude=.git \
  --exclude=.flywheel \
  --exclude=dist \
  --exclude=inspiration \
  --exclude=docs \
  --exclude=bench \
  --exclude=assets \
  --exclude=crates \
  --exclude=node_modules \
  -C "$ROOT" .

if ! docker run -d --name "$CONTAINER" "$IMAGE" >/dev/null; then
  exit 1
fi
if ! docker cp "$ARCHIVE" "$CONTAINER:/opt/flywheel-harness/harness.tar.gz"; then
  exit 1
fi
if ! docker exec "$CONTAINER" sh -lc '
  set -eu
  ! command -v ps
  tar xzf harness.tar.gz
  rm harness.tar.gz
  export PATH="/root/.bun/bin:$PATH"
  bun install --frozen-lockfile
'; then
  exit 1
fi

# The native ripgrep addon is excluded from the source tarball with the rest
# of crates/. Ship a cross-built artifact when one exists so search and list
# run as PASS instead of SKIP; ripgrep.ts resolves crates/ripgrep/ as its
# development fallback.
ADDON="$ROOT/crates/ripgrep/flywheel-ripgrep.linux-arm64.node"
if [ -f "$ADDON" ]; then
  docker exec "$CONTAINER" mkdir -p /opt/flywheel-harness/crates/ripgrep
  if ! docker cp "$ADDON" "$CONTAINER:/opt/flywheel-harness/crates/ripgrep/"; then
    exit 1
  fi
fi

docker exec "$CONTAINER" bun --conditions=browser /opt/flywheel-harness/bench/linux-runtime-verification/smoke.ts
