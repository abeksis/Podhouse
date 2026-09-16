#!/usr/bin/env bash
# Give the server a world directory it can write to.
#
# The image runs the server as UID:GID from .env (1000 by default) and the bind
# directory below is created by Docker as root, so its very first act —
# `mkdir /data/.tmp` — fails with "Permission denied" and the container
# restarts forever. This was true before any of the hardening work; a fresh
# install simply never produced a running server.
#
# Safe to re-run: it only creates and chowns.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/podhouse}"
DIR="$HB_ROOT/modules/bedrock/config/data"

mkdir -p "$DIR"
chown -R "${PUID:-1000}:${PGID:-1000}" "$DIR" 2>/dev/null || true
echo "bedrock: $DIR is owned by the server's user"
