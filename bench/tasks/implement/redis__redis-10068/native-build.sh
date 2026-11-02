#!/bin/bash
set -e
cd -- "$(dirname -- "$0")/../.."
/usr/bin/make distclean
exec /usr/bin/make 'CFLAGS=-DMAC_OS_X_VERSION_10_6=1060' "$@"
