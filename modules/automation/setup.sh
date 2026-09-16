#!/usr/bin/env bash
# Give n8n a home directory it can write to.
#
# The image runs as the `node` user (uid 1000), and the bind directory below is
# created by Docker as root on a first install. n8n then dies with
#   EACCES: permission denied, open '/home/node/.n8n/config'
# and restarts forever. Nothing in the app is wrong; the directory is.
#
# Safe to re-run: it only creates and chowns.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/podhouse}"
DIR="$HB_ROOT/modules/automation/config/n8n"

mkdir -p "$DIR"
# 1000 is the uid inside this image, not PUID from .env — the image has no
# PUID/PGID support, so the files must belong to the uid it actually runs as.
chown -R 1000:1000 "$DIR" 2>/dev/null || true
echo "automation: $DIR is owned by the container's user"
