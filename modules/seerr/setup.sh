#!/usr/bin/env bash
# Seerr runs as an unprivileged user and cannot repair a root-owned bind mount.
# Prepare its config directory before the first container start. Safe to re-run.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/podhouse}"
CONFIG_DIR="$HB_ROOT/modules/seerr/config/seerr"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

mkdir -p "$CONFIG_DIR"
chown -R "$PUID:$PGID" "$CONFIG_DIR"

echo "seerr: config directory owned by $PUID:$PGID"
