#!/usr/bin/env bash
# Radarr: its config folder, and the pool folders it files films into.
#
# Split out of modules/media/setup.sh when radarr became a module of its own.
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

CONFIG="$HB_ROOT/modules/radarr/config/radarr"
for dir in "$MEDIA_ROOT/$DOWNLOADS" "$MEDIA_ROOT/$MOVIES" "$CONFIG"; do
  # A pre-existing library on a NAS is already laid out and may be read-only
  # to us in places; creating what is missing must not abort the install.
  mkdir -p "$dir" 2>/dev/null || echo "radarr: could not create $dir (already there, or not writable)"
done

# The linuxserver images drop privileges to PUID:PGID and cannot chown a
# directory root already owns. Only what this module uses: chowning somebody's
# whole NAS library is not a side effect an installer gets to have.
for dir in "$MEDIA_ROOT/$DOWNLOADS" "$MEDIA_ROOT/$MOVIES"; do
  [ -d "$dir" ] && chown "$PUID:$PGID" "$dir" 2>/dev/null || true
done
chown -R "$PUID:$PGID" "$HB_ROOT/modules/radarr/config" 2>/dev/null || true
echo "radarr: ready — pool mounted as /data"

# ---------------------------------------------------------------------------
# Open without a login on a home network, like the rest of the box.
#
# Left alone, a fresh Radarr opens on an "Authentication Required" dialog that
# makes you invent an account before you can see anything. On a FRESH install
# (no config.xml yet) on a box with a private address, write the two settings
# that skip it: External = no sign-in page of its own, and not for local
# addresses. Podhouse's own links use the API key, which this never gates.
#
# A box with a public address keeps the dialog: there "no login" would mean
# no login for the whole internet. An existing config.xml — an account the
# user already made — is never touched.
# ---------------------------------------------------------------------------
CFG_XML="$CONFIG/config.xml"
case "${HB_HOST_ADDRESS:-}" in
  10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) private=1 ;;
  *) private=0 ;;
esac
if [ ! -f "$CFG_XML" ] && [ "$private" = 1 ]; then
  printf '<Config>\n  <AuthenticationMethod>External</AuthenticationMethod>\n  <AuthenticationRequired>DisabledForLocalAddresses</AuthenticationRequired>\n</Config>\n' > "$CFG_XML"
  chown "$PUID:$PGID" "$CFG_XML" 2>/dev/null || true
  echo "radarr: no login on the home network (set one in Radarr > Settings > General)"
fi
