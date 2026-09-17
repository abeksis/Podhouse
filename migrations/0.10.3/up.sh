#!/usr/bin/env bash
# 0.10.3 — close the rollback archives that older versions left readable.
#
# Every update before 0.10.0 wrote state/platform-backups/*.tar.gz under the
# default umask: 0644 files in a 0755 directory. Those archives contain .env
# and state/auth.json — every generated password, the backup encryption key,
# and live session ids. Any local account that could walk the tree could read
# all of it out of the tarball, whatever the modes on the original files said.
#
# 0.10.0 creates new ones privately. This is for the ones already on disk.
#
# Note what this cannot do: if an unprivileged account on this box read one of
# those archives before now, the secrets in it are already out. Rotating them
# is a decision for the person, not for a migration — see docs/SECURITY.md.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/podhouse}"
DIR="$HB_ROOT/state/platform-backups"
say() { printf '[migration 0.10.3] %s\n' "$*"; }

[ -d "$DIR" ] || { say "no platform backups on this box"; exit 0; }

chmod 700 "$DIR" || true
fixed=0
while IFS= read -r file; do
  chmod 600 "$file" 2>/dev/null && fixed=$((fixed + 1))
done < <(find "$DIR" -maxdepth 1 -type f -name '*.tar.gz' 2>/dev/null)

# The per-module update backups are already chmodded by updates.js, but only
# after tar finishes; an interrupted update can leave one behind open.
if [ -d "$HB_ROOT/state/update-backups" ]; then
  chmod 700 "$HB_ROOT/state/update-backups" || true
  while IFS= read -r file; do
    chmod 600 "$file" 2>/dev/null && fixed=$((fixed + 1))
  done < <(find "$HB_ROOT/state/update-backups" -maxdepth 1 -type f -name '*.tar.gz' 2>/dev/null)
fi

say "closed $fixed archive(s) to owner-only"
