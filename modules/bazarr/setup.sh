#!/usr/bin/env bash
# Bazarr: its config folder. It reads the library the *arr apps built.
#
# Split out of modules/media/setup.sh when bazarr became a module of its own.
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


CONFIG="$HB_ROOT/modules/bazarr/config/bazarr"
for dir in "$CONFIG"; do
  # A pre-existing library on a NAS is already laid out and may be read-only
  # to us in places; creating what is missing must not abort the install.
  mkdir -p "$dir" 2>/dev/null || echo "bazarr: could not create $dir (already there, or not writable)"
done

# The linuxserver images drop privileges to PUID:PGID and cannot chown a
# directory root already owns. Only what this module uses: chowning somebody's
# whole NAS library is not a side effect an installer gets to have.
chown -R "$PUID:$PGID" "$HB_ROOT/modules/bazarr/config" 2>/dev/null || true
echo "bazarr: ready"
