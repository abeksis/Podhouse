#!/usr/bin/env bash
# Sonarr: its config folder, and the pool folders it files series into.
#
# Split out of modules/media/setup.sh when sonarr became a module of its own.
# Every app in the set mounts the pool at ONE path (/data) so a finished
# download can be HARDLINKED into the library instead of copied — the kernel
# compares the MOUNT, so two separate binds fail with EXDEV even on one disk.
# Each module creates only the folders it uses; the pool is shared.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/podhouse}"
DATA_DIR="${HB_DATA_DIR:-$HB_ROOT/data}"
MEDIA_ROOT="${HB_MEDIA_ROOT:-$DATA_DIR}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

DOWNLOADS="${HB_DOWNLOADS:-downloads}"
MOVIES="${HB_MEDIA_MOVIES:-media/movies}"
TV="${HB_MEDIA_TV:-media/tv}"

CONFIG="$HB_ROOT/modules/sonarr/config/sonarr"
for dir in "$MEDIA_ROOT/$DOWNLOADS" "$MEDIA_ROOT/$TV" "$CONFIG"; do
  # A pre-existing library on a NAS is already laid out and may be read-only
  # to us in places; creating what is missing must not abort the install.
  mkdir -p "$dir" 2>/dev/null || echo "sonarr: could not create $dir (already there, or not writable)"
done

# The linuxserver images drop privileges to PUID:PGID and cannot chown a
# directory root already owns. Only what this module uses: chowning somebody's
# whole NAS library is not a side effect an installer gets to have.
for dir in "$MEDIA_ROOT/$DOWNLOADS" "$MEDIA_ROOT/$TV"; do
  [ -d "$dir" ] && chown "$PUID:$PGID" "$dir" 2>/dev/null || true
done
chown -R "$PUID:$PGID" "$HB_ROOT/modules/sonarr/config" 2>/dev/null || true
echo "sonarr: ready — pool mounted as /data"
