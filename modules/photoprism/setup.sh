#!/usr/bin/env bash
# PhotoPrism's storage directory, owned by the user it drops to.
#
# The container starts as root and becomes PHOTOPRISM_UID; the bind directory
# is created by Docker as root, so without this the app cannot write its cache,
# thumbnails or sidecar files.
#
# Safe to re-run: it only creates and chowns.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/podhouse}"
DIR="$HB_ROOT/modules/photoprism/config/storage"

mkdir -p "$DIR"
chown -R "${PUID:-1000}:${PGID:-1000}" "$DIR" 2>/dev/null || true
echo "photoprism: $DIR is owned by the app's user"
